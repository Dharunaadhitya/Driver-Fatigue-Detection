/**
 * Main entry point — wires VideoSource, FaceDetector, FatigueEngine, AlertEngine.
 * Also handles all UI updates and canvas landmark drawing.
 */

import { VideoSource } from './videoSource.js';
import { FaceDetector } from './faceDetector.js';
import { FatigueEngine } from './fatigueEngine.js';
import { AlertEngine } from './alertEngine.js';

// ── DOM refs ──────────────────────────────────────────────────────────────
const videoEl = document.getElementById('videoFeed');
const overlayCanvas = document.getElementById('overlayCanvas');
const ctx2d = overlayCanvas.getContext('2d');

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const calibBar = document.getElementById('calibBar');
const calibSection = document.getElementById('calibSection');

const earValue = document.getElementById('earValue');
const marValue = document.getElementById('marValue');
const perclosValue = document.getElementById('perclosValue');
const perclosArc = document.getElementById('perclosArc');
const blinkValue = document.getElementById('blinkValue');
const yawnValue = document.getElementById('yawnValue');
const tiltValue = document.getElementById('tiltValue');

const alertBanner = document.getElementById('alertBanner');
const alertMessage = document.getElementById('alertMessage');
const historyList = document.getElementById('historyList');
const faceDetectedBadge = document.getElementById('faceDetectedBadge');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const muteBtn = document.getElementById('muteBtn');

const videoLabel = document.getElementById('videoLabel');

const headerSnapshotBtn = document.getElementById('headerSnapshotBtn');
const tabManualSnapBtn = document.getElementById('tabManualSnapBtn');
const snapshotsList = document.getElementById('snapshotsList');
const snapCount = document.getElementById('snapCount');

let capturedSnapshots = [];
let lastAutoSnapTime = 0;

const earThresholdInput = document.getElementById('earThreshold');
const marThresholdInput = document.getElementById('marThreshold');
const applyThreshBtn = document.getElementById('applyThreshBtn');
const sessionTime = document.getElementById('sessionTime');

// ── Theme management ──────────────────────────────────────────────────────
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('drowsyguard-theme', theme);
  if (themeIcon) {
    themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
  }
  if (themeToggle) {
    const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    themeToggle.setAttribute('aria-label', label);
    themeToggle.setAttribute('title', label);
  }
}

function initTheme() {
  const saved = localStorage.getItem('drowsyguard-theme') || 'dark';
  applyTheme(saved);
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  }
}

// ── Instances ─────────────────────────────────────────────────────────────
const videoSource = new VideoSource();
const faceDetector = new FaceDetector();
const fatigueEngine = new FatigueEngine();
const alertEngine = new AlertEngine();

let isRunning = false;
let animFrameId = null;
let sessionStart = null;
let sessionTimerInterval = null;
let currentAlertLevel = 'normal';

// ── Perclos SVG arc constants ─────────────────────────────────────────────
const PERCLOS_R = 54;
const PERCLOS_CIRCUMFERENCE = 2 * Math.PI * PERCLOS_R;
perclosArc.style.strokeDasharray = PERCLOS_CIRCUMFERENCE;
perclosArc.style.strokeDashoffset = PERCLOS_CIRCUMFERENCE;

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  setStatus('Initializing…', 'idle');
  startBtn.disabled = true;

  try {
    setStatus('Loading face detection model…', 'idle');
    await faceDetector.init();
    faceDetector.onResults = handleFaceResults;
    setStatus('Ready — click Start', 'ready');
    startBtn.disabled = false;
  } catch (err) {
    setStatus('Model load failed: ' + err.message, 'error');
  }

  // Wire alert engine
  alertEngine.onLevelChange = handleAlertLevelChange;

  // Wire video source
  videoSource.onStatusChange = (s) => {
    setStatus(s, 'active');
  };

  if (videoLabel) {
    videoLabel.textContent = 'WEBCAM';
  }
  applyCanvasMirror();

  // Restore settings
  loadSettings();
  renderHistory();
  initTheme();
}

// ── Start / Stop ──────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  try {
    await videoSource.start(videoEl);
    isRunning = true;
    if (headerSnapshotBtn) headerSnapshotBtn.disabled = false;
    sessionStart = Date.now();
    sessionTimerInterval = setInterval(updateSessionTimer, 1000);
    fatigueEngine.startCalibration();
    showCalib(true);
    setStatus('Monitoring active', 'active');
    renderLoop();
  } catch (err) {
    setStatus('Camera failed: ' + err.message, 'error');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', () => {
  stopSession();
});

resetBtn.addEventListener('click', () => {
  fatigueEngine.reset();
  alertEngine.reset();
  renderHistory();
  clearMetricsUI();
  setStatus(isRunning ? 'Session reset — monitoring' : 'Ready — click Start', isRunning ? 'active' : 'ready');
});

muteBtn.addEventListener('click', () => {
  const muted = alertEngine.toggleMute();
  muteBtn.classList.toggle('muted', muted);
  muteBtn.querySelector('.btn-icon').textContent = muted ? '🔇' : '🔊';
  muteBtn.title = muted ? 'Unmute audio alarms' : 'Mute audio alarms';
});

function stopSession() {
  isRunning = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  clearInterval(sessionTimerInterval);
  videoSource.destroy();
  faceDetector.reset();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (headerSnapshotBtn) headerSnapshotBtn.disabled = true;
  setStatus('Session stopped', 'idle');
  showCalib(false);
  clearMetricsUI();
}

// ── Render Loop ───────────────────────────────────────────────────────────
function renderLoop() {
  if (!isRunning) return;

  processFrame();
  animFrameId = requestAnimationFrame(renderLoop);
}

function processFrame() {
  const el = videoSource.getActiveElement();
  if (!videoSource.isReady()) return;

  // Match canvas dimensions to video element
  const { width: w, height: h } = videoSource.getSourceDimensions();
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w;
    overlayCanvas.height = h;
  }

  // Clear previous landmarks
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // Send frame to FaceDetector
  faceDetector.send(el);
}

// ── Face Results Handler ──────────────────────────────────────────────────
function handleFaceResults(data) {
  if (!isRunning) return;

  const now = Date.now();
  const faceFound = Boolean(data && (data.detected || data.faceDetected));

  if (!faceFound) {
    updateFaceBadge(false);
    return;
  }

  updateFaceBadge(true);

  // Update fatigue engine
  const metrics = fatigueEngine.update(data, now);

  // Calibration progress indicator
  if (!fatigueEngine.calibrated) {
    showCalib(true);
    const calibPct = Math.min(100, Math.round((fatigueEngine.calibrationFrames / fatigueEngine.CALIBRATION_FRAMES) * 100));
    calibBar.style.width = calibPct + '%';
  } else {
    showCalib(false);
  }

  // Evaluate alert level
  const alertState = alertEngine.evaluate(metrics, now);

  // Draw overlays
  drawLandmarks(data);

  // Update UI gauges
  updateGauges(metrics, data);
}

// ── Drawing ───────────────────────────────────────────────────────────────
function drawLandmarks(data) {
  const w = overlayCanvas.width;
  const h = overlayCanvas.height;

  // Draw eye landmarks
  ctx2d.strokeStyle = '#38bdf8';
  ctx2d.fillStyle = '#38bdf8';
  ctx2d.lineWidth = 1.5;

  const leftEyePts = data.leftEyeRaw || data.leftEye;
  const rightEyePts = data.rightEyeRaw || data.rightEye;
  drawPointList(leftEyePts, w, h);
  drawPointList(rightEyePts, w, h);

  // Draw mouth outer
  ctx2d.strokeStyle = '#f59e0b';
  ctx2d.fillStyle = '#f59e0b';
  drawPointList(data.mouthRaw || data.mouth, w, h);

  // Draw inner mouth (yawn area)
  ctx2d.strokeStyle = '#ef4444';
  ctx2d.fillStyle = '#ef4444';
  drawPointList(data.mouthInnerRaw || data.mouthInner, w, h);

  // Draw head pose indicator line from nose to chin
  const nose = (data.headPose && data.headPose.noseTip) || data.nose;
  const chin = (data.headPose && data.headPose.chin) || data.chin;
  if (nose && chin) {
    ctx2d.strokeStyle = '#a855f7';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(nose.x * w, nose.y * h);
    ctx2d.lineTo(chin.x * w, chin.y * h);
    ctx2d.stroke();
  }
}

function drawPointList(points, w, h) {
  if (!points || !points.length) return;
  for (const pt of points) {
    ctx2d.beginPath();
    ctx2d.arc(pt.x * w, pt.y * h, 2, 0, 2 * Math.PI);
    ctx2d.fill();
  }
}

// ── UI Updates ────────────────────────────────────────────────────────────
function updateGauges(metrics, faceData) {
  // EAR
  earValue.textContent = metrics.ear ? metrics.ear.toFixed(2) : '—';
  earValue.className = 'gauge-value ' + (metrics.eyesClosed ? 'danger' : 'safe');

  // MAR
  marValue.textContent = metrics.mar ? metrics.mar.toFixed(2) : '—';
  marValue.className = 'gauge-value ' + (metrics.yawning ? 'warning' : 'safe');

  // PERCLOS
  const perclosPct = Math.round((metrics.perclos || 0) * 100);
  perclosValue.textContent = perclosPct + '%';
  const offset = PERCLOS_CIRCUMFERENCE * (1 - (metrics.perclos || 0));
  perclosArc.style.strokeDashoffset = offset;

  // Arc color based on PERCLOS
  let arcColor = 'var(--accent-emerald)';
  if (metrics.perclos >= 0.70) arcColor = 'var(--accent-rose)';
  else if (metrics.perclos >= 0.40) arcColor = 'var(--accent-amber)';
  perclosArc.style.stroke = arcColor;

  // Blink rate
  blinkValue.textContent = metrics.blinkRatePerMin !== undefined ? metrics.blinkRatePerMin : (metrics.blinkRate || 0);

  // Yawn count
  yawnValue.textContent = metrics.yawnCount || 0;

  // Head tilt & nod
  const tilt = metrics.headTilt !== undefined ? metrics.headTilt : (faceData && faceData.tilt);
  const nod = metrics.headNod !== undefined ? metrics.headNod : (faceData && faceData.nod);
  if (tilt !== undefined && nod !== undefined) {
    const tiltStr = `${tilt > 0 ? '+' : ''}${Math.round(tilt)}°`;
    const nodStr = `${nod > 0 ? '+' : ''}${Math.round(nod)}°`;
    tiltValue.textContent = `${tiltStr} / ${nodStr}`;
    const headAlert = metrics.headTiltAlert || metrics.headNodAlert || Math.abs(tilt) > 25 || nod < -15;
    tiltValue.className = 'gauge-value ' + (headAlert ? 'warning' : 'safe');
  }
}

function handleAlertLevelChange(level, event) {
  currentAlertLevel = level;

  // Video border glow
  const wrapper = document.getElementById('videoWrapper');
  if (wrapper) {
    wrapper.className = 'video-wrapper level-' + level;
  }

  const msgText = typeof event === 'string' ? event : (event && event.message ? event.message : level.toUpperCase());

  // Alert banner
  if (level === 'normal') {
    alertBanner.classList.add('hidden');
  } else {
    alertBanner.className = 'alert-banner level-' + level;
    alertMessage.textContent = msgText;
    alertBanner.classList.remove('hidden');
  }

  // Append to history log
  renderHistory();

  // Automatically capture snapshot on severe fatigue
  if (level === 'microsleep' || level === 'danger') {
    const now = Date.now();
    if (now - lastAutoSnapTime > 4000) {
      lastAutoSnapTime = now;
      captureIncidentSnapshot(level);
    }
  }
}

function captureIncidentSnapshot(trigger = 'manual') {
  if (!videoEl || !videoEl.videoWidth) {
    if (!isRunning) {
      setStatus('Please click "Start" to activate camera first', 'warning');
      alert('The webcam is not active. Please click "Start" to activate your camera first!');
    }
    return;
  }

  try {
    const off = document.createElement('canvas');
    off.width = videoEl.videoWidth || 640;
    off.height = videoEl.videoHeight || 480;
    const oCtx = off.getContext('2d');

    // Draw unmirrored frame
    oCtx.save();
    oCtx.scale(-1, 1);
    oCtx.drawImage(videoEl, -off.width, 0, off.width, off.height);
    oCtx.restore();

    // Telemetry stamp
    oCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    oCtx.fillRect(0, off.height - 34, off.width, 34);
    oCtx.fillStyle = '#FFFFFF';
    oCtx.font = 'bold 13px monospace';
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    oCtx.fillText(`[LOCAL WEBCAM] ${timeStr}  TRIGGER: ${trigger.toUpperCase()}`, 12, off.height - 12);

    const dataUrl = off.toDataURL('image/jpeg', 0.88);
    const snapObj = {
      id: Date.now(),
      dataUrl,
      trigger,
      time: timeStr
    };
    capturedSnapshots.unshift(snapObj);
    renderSnapshotsUI();
    setStatus(`Snapshot captured (${trigger})`, 'active');

    // Also upload to server if running
    off.toBlob(blob => {
      if (!blob) return;
      const fd = new FormData();
      fd.append('driver_id', 'DRV-101');
      fd.append('trigger', trigger);
      fd.append('snapshot', blob, `snap_${Date.now()}.jpg`);
      fetch('/api/snapshots/upload', { method: 'POST', body: fd }).catch(() => {});
    }, 'image/jpeg', 0.88);
  } catch (err) {
    console.warn('[Snapshot] Error:', err);
  }
}

function renderSnapshotsUI() {
  if (!snapshotsList) return;
  if (snapCount) snapCount.textContent = capturedSnapshots.length;

  if (capturedSnapshots.length === 0) {
    snapshotsList.innerHTML = '<p class="no-history">No snapshots captured yet. Start camera and click 📷 Snapshot.</p>';
    return;
  }

  snapshotsList.innerHTML = capturedSnapshots.map(s => `
    <div style="background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px; margin-bottom: 10px;">
      <div style="position: relative;">
        <span style="position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.75); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; color: ${s.trigger === 'microsleep' ? 'var(--accent-rose)' : 'var(--accent-amber)'};">${s.trigger.toUpperCase()}</span>
        ${s.driverId ? `<span style="position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.75); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: #94a3b8;">${s.driverId}</span>` : ''}
        <img src="${s.dataUrl}" onerror="this.onerror=null; this.src='/api/snapshots/image/${s.id}?fallback=svg';" style="width: 100%; border-radius: 6px; display: block; min-height: 120px; background: #0f172a;" alt="Incident snapshot" />
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 12px; color: var(--text-muted);">
        <span>${s.time}</span>
        <a href="${s.dataUrl}" download="snapshot_${s.id}.jpg" class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 11px; text-decoration: none;">⬇️ Save</a>
      </div>
    </div>
  `).join('');
}

async function loadInitialSnapshots() {
  try {
    const res = await fetch('/api/snapshots/all');
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.snapshots && data.snapshots.length) {
      data.snapshots.forEach(s => {
        capturedSnapshots.push({
          id: s.id,
          dataUrl: `/api/snapshots/image/${s.id}`,
          trigger: s.trigger_type || 'incident',
          time: s.captured_at ? new Date(s.captured_at).toLocaleTimeString() : 'Recent',
          driverId: s.driver_id
        });
      });
      renderSnapshotsUI();
    }
  } catch (_) {}
}
loadInitialSnapshots();

if (headerSnapshotBtn) {
  headerSnapshotBtn.disabled = false;
  headerSnapshotBtn.addEventListener('click', () => captureIncidentSnapshot('manual'));
}
if (tabManualSnapBtn) {
  tabManualSnapBtn.addEventListener('click', () => captureIncidentSnapshot('manual'));
}

function updateFaceBadge(detected) {
  faceDetectedBadge.className = 'face-badge ' + (detected ? 'detected' : 'not-detected');
  faceDetectedBadge.querySelector('.badge-text').textContent = detected ? '✓ Face tracked' : '✗ No face';
}

function clearMetricsUI() {
  earValue.textContent = '—';
  earValue.className = 'gauge-value';
  marValue.textContent = '—';
  marValue.className = 'gauge-value';
  perclosValue.textContent = '0%';
  perclosArc.style.strokeDashoffset = PERCLOS_CIRCUMFERENCE;
  perclosArc.style.stroke = 'var(--accent-emerald)';
  blinkValue.textContent = '0';
  yawnValue.textContent = '0';
  tiltValue.textContent = '—';
  tiltValue.className = 'gauge-value';
  alertBanner.classList.add('hidden');
  document.getElementById('videoWrapper').className = 'video-wrapper level-normal';
  updateFaceBadge(false);
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function renderHistory() {
  const entries = alertEngine.getHistory();
  if (!entries || !entries.length) {
    historyList.innerHTML = '<p class="no-history">No alerts yet this session.</p>';
    return;
  }
  historyList.innerHTML = entries
    .slice(0, 30)
    .map((e) => {
      const t = new Date(e.time);
      const ts = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
      return `<div class="history-item level-${e.level}">
        <span class="hist-time">${ts}</span>
        <span class="hist-msg">${e.message}</span>
      </div>`;
    })
    .join('');
}

// ── Settings ──────────────────────────────────────────────────────────────
applyThreshBtn.addEventListener('click', () => {
  fatigueEngine.updateThresholds({
    earThreshold: parseFloat(earThresholdInput.value),
    marThreshold: parseFloat(marThresholdInput.value),
  });
  saveSettings();
});

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('fatigue_settings') || '{}');
    if (s.earThreshold) earThresholdInput.value = s.earThreshold;
    if (s.marThreshold) marThresholdInput.value = s.marThreshold;
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem('fatigue_settings', JSON.stringify({
    earThreshold: earThresholdInput.value,
    marThreshold: marThresholdInput.value,
  }));
}

// ── Status ────────────────────────────────────────────────────────────────
function setStatus(text, type) {
  statusText.textContent = text;
  statusDot.className = 'status-dot ' + type;
}

// ── Session Timer ─────────────────────────────────────────────────────────
function updateSessionTimer() {
  if (!sessionStart) return;
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
  const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
  const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  sessionTime.textContent = `${h}:${m}:${s}`;
}

function showCalib(show) {
  calibSection.style.display = show ? 'block' : 'none';
  if (show) calibBar.style.width = '0%';
}

// ── Canvas mirror helper ──────────────────────────────────
/**
 * Webcam feed is CSS-mirrored (scaleX(-1)) so the driver sees a natural
 * reflection. This keeps the canvas overlay in sync with the webcam feed.
 */
function applyCanvasMirror() {
  overlayCanvas.style.transform = 'scaleX(-1)';
}

// ── Expose globals for inline HTML handlers ───────────────────────────────
window.__alertEngine = alertEngine;
window.__renderHistory = renderHistory;

// ── Boot ──────────────────────────────────────────────────────────────────
init();
