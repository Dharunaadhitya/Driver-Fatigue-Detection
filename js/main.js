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
const imgEl = document.getElementById('esp32Feed');
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

const sourceToggle = document.getElementById('sourceToggle');
const esp32UrlInput = document.getElementById('esp32Url');
const applyEspBtn = document.getElementById('applyEspBtn');
const esp32Status = document.getElementById('esp32Status');
const videoLabel = document.getElementById('videoLabel');

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

  // Wire video source — route ESP32 connection messages to the status pill
  videoSource.onStatusChange = (s) => {
    // ESP32-specific messages go to the status pill; others go to the header status bar
    if (s.startsWith('ESP32-CAM:')) {
      setEsp32Status(s);
      // Also show in header as a brief note
      setStatus(s, 'active');
    } else {
      setStatus(s, 'active');
    }
  };

  // Restore settings (including source mode)
  loadSettings();
  renderHistory();
  initTheme();
}

// ── Start / Stop ──────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  try {
    await videoSource.start(videoEl, imgEl);
    isRunning = true;
    sessionStart = Date.now();
    sessionTimerInterval = setInterval(updateSessionTimer, 1000);
    loop();
    setStatus('Detecting…', 'active');
    if (!fatigueEngine.calibrated) showCalib(true);
  } catch (err) {
    setStatus('Camera error: ' + err.message, 'error');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', stopSession);
resetBtn.addEventListener('click', () => {
  fatigueEngine.reset();
  alertEngine.clearHistory();
  renderHistory();
  resetGauges();
  showCalib(true);
  setStatus('Reset — click Start to calibrate again', 'ready');
});

muteBtn.addEventListener('click', () => {
  const muted = alertEngine.toggleMute();
  muteBtn.innerHTML = muted
    ? '<span class="btn-icon">🔇</span> Unmute'
    : '<span class="btn-icon">🔊</span> Mute';
});

function stopSession() {
  isRunning = false;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  videoSource.destroy();
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Stopped', 'idle');
  setAlertUI('normal');
}

// ── Main loop ─────────────────────────────────────────────────────────────
function loop() {
  if (!isRunning) return;
  animFrameId = requestAnimationFrame(loop);

  const el = videoSource.getActiveElement();
  if (!videoSource.isReady()) return;

  // Sync canvas size using source-agnostic helper
  const { width: w, height: h } = videoSource.getSourceDimensions();
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w;
    overlayCanvas.height = h;
  }

  faceDetector.send(el);
}

// ── Face results handler ──────────────────────────────────────────────────
function handleFaceResults(faceData) {
  // Update fatigue engine
  const state = fatigueEngine.update(faceData);

  // Update alert engine
  const level = alertEngine.evaluate(state);
  currentAlertLevel = level;

  // Update calibration progress
  if (!fatigueEngine.calibrated) {
    const pct = Math.min(100, (fatigueEngine.calibFrames.length / fatigueEngine.CALIB_FRAMES) * 100);
    calibBar.style.width = pct + '%';
    calibBar.textContent = Math.round(pct) + '%';
    const calibPct = document.getElementById('calibPct');
    if (calibPct) calibPct.textContent = Math.round(pct) + '%';
  } else {
    showCalib(false);
  }

  // Update UI gauges
  updateGauges(state);

  // Face detected badge
  faceDetectedBadge.className = 'face-badge ' + (faceData.detected ? 'detected' : 'not-detected');
  faceDetectedBadge.textContent = faceData.detected ? '✓ Face detected' : '✗ No face';

  // Draw landmarks
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (faceData.detected) {
    drawLandmarks(faceData);
  }
}

// ── Landmark drawing ──────────────────────────────────────────────────────
function drawLandmarks(faceData) {
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;

  const eyeColor = currentAlertLevel === 'normal' ? '#22C55E' :
                   currentAlertLevel === 'warning' ? '#F59E0B' :
                   currentAlertLevel === 'danger' ? '#F97316' : '#EF4444';

  // Draw eyes
  for (const eye of [faceData.leftEye, faceData.rightEye]) {
    ctx2d.beginPath();
    eye.forEach((p, i) => {
      const x = p.x * W;
      const y = p.y * H;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    });
    ctx2d.closePath();
    ctx2d.strokeStyle = eyeColor;
    ctx2d.lineWidth = 2;
    ctx2d.stroke();

    // Subtle glow
    ctx2d.shadowColor = eyeColor;
    ctx2d.shadowBlur = 6;
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;
  }

  // Draw mouth
  ctx2d.beginPath();
  faceData.mouth.forEach((p, i) => {
    const x = p.x * W;
    const y = p.y * H;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  });
  ctx2d.closePath();
  ctx2d.strokeStyle = '#3B82F6';
  ctx2d.lineWidth = 1.5;
  ctx2d.stroke();

  // EAR label
  const noseX = faceData.headPose.noseTip.x * W;
  const noseY = faceData.headPose.noseTip.y * H;
  ctx2d.fillStyle = eyeColor;
  ctx2d.font = '600 12px "JetBrains Mono", monospace';
  ctx2d.fillText(`EAR: ${fatigueEngine.currentEAR.toFixed(3)}`, noseX - 35, noseY - 10);
}

// ── Alert UI ──────────────────────────────────────────────────────────────
function handleAlertLevelChange(level, message) {
  setAlertUI(level, message);
  if (level !== 'normal') {
    renderHistory();
  }
}

function setAlertUI(level, message = '') {
  alertBanner.className = 'alert-banner ' + level;
  if (level === 'normal') {
    alertBanner.classList.add('hidden');
  } else {
    alertBanner.classList.remove('hidden');
    alertMessage.textContent = message;
  }

  // Flash the video border
  const videoWrapper = document.getElementById('videoWrapper');
  videoWrapper.className = 'video-wrapper level-' + level;
}

// ── Gauges ────────────────────────────────────────────────────────────────
function updateGauges(state) {
  earValue.textContent = state.ear.toFixed(3);
  // Show MAR value + yawn charge progress
  const yawnPct = Math.min(fatigueEngine.yawnFrames, fatigueEngine.YAWN_SUSTAIN_FRAMES);
  const yawnMax = fatigueEngine.YAWN_SUSTAIN_FRAMES;
  marValue.textContent = state.yawning
    ? `${state.mar.toFixed(3)} 😮`
    : yawnPct > 0
    ? `${state.mar.toFixed(3)} ⚡${yawnPct}/${yawnMax}`
    : state.mar.toFixed(3);
  blinkValue.textContent = state.blinkRatePerMin;
  yawnValue.textContent = state.yawnCount;
  tiltValue.textContent = `${state.headTilt.toFixed(1)}° / ${state.headNod.toFixed(1)}°`;

  // PERCLOS gauge
  const pct = Math.min(1, state.perclos);
  perclosValue.textContent = (pct * 100).toFixed(1) + '%';
  const offset = PERCLOS_CIRCUMFERENCE * (1 - pct);
  perclosArc.style.strokeDashoffset = offset;
  perclosArc.style.stroke =
    state.microsleep ? '#EF4444' : pct > 0.7 ? '#F97316' : pct > 0.4 ? '#F59E0B' : '#22C55E';

  // Color EAR value
  earValue.style.color =
    state.eyesClosed ? '#EF4444' : state.ear < 0.28 ? '#F59E0B' : '#22C55E';

  // MAR color — warning when approaching, danger when yawning
  marValue.style.color = state.yawning ? '#F97316'
    : yawnPct > 0 ? '#F59E0B'
    : '';
}

function resetGauges() {
  earValue.textContent = '—';
  marValue.textContent = '—';
  perclosValue.textContent = '0.0%';
  blinkValue.textContent = '0';
  yawnValue.textContent = '0';
  tiltValue.textContent = '—';
  perclosArc.style.strokeDashoffset = PERCLOS_CIRCUMFERENCE;
  perclosArc.style.stroke = '#22C55E';
  earValue.style.color = '';
  marValue.style.color = '';
  faceDetectedBadge.textContent = '✗ No face';
  faceDetectedBadge.className = 'face-badge not-detected';
}

// ── History ───────────────────────────────────────────────────────────────
function renderHistory() {
  const entries = alertEngine.getHistory();
  if (entries.length === 0) {
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
sourceToggle.addEventListener('change', async () => {
  const mode = sourceToggle.value;

  // Show/hide ESP32 section
  document.getElementById('esp32Section').style.display =
    mode === 'esp32' ? 'block' : 'none';

  // Update video label
  videoLabel.textContent = mode === 'esp32' ? 'ESP32-CAM' : 'WEBCAM';

  // Toggle canvas mirror: webcam is mirrored, ESP32 is not
  applyCanvasMirror(mode);

  // If session is running, switch the live source
  if (isRunning) {
    try {
      await videoSource.switchMode(mode);
    } catch (err) {
      setStatus('Switch failed: ' + err.message, 'error');
      // Revert the dropdown back to the previous mode so the UI stays consistent
      sourceToggle.value = mode === 'webcam' ? 'esp32' : 'webcam';
      document.getElementById('esp32Section').style.display =
        sourceToggle.value === 'esp32' ? 'block' : 'none';
      return;
    }
  }

  // Persist the chosen mode
  saveSettings();
});

applyEspBtn.addEventListener('click', () => {
  const url = esp32UrlInput.value.trim();
  if (!url) {
    setEsp32Status('ESP32-CAM: ⚠ Enter a stream URL first');
    return;
  }
  videoSource.setEsp32Url(url);
  // Always save the URL
  saveSettings();
  // If already running in ESP32 mode, reconnect
  if (isRunning && sourceToggle.value === 'esp32') {
    videoSource.switchMode('esp32');
  } else {
    setEsp32Status('ESP32-CAM: URL saved — click Start to connect');
  }
});

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
    if (s.esp32Url) {
      esp32UrlInput.value = s.esp32Url;
      videoSource.setEsp32Url(s.esp32Url);
    }
    // Default to esp32 mode — avoids webcam permission prompt on load.
    // Use saved preference if available, otherwise fall back to esp32.
    const mode = s.sourceMode || 'esp32';
    sourceToggle.value = mode;
    document.getElementById('esp32Section').style.display =
      mode === 'esp32' ? 'block' : 'none';
    videoLabel.textContent = mode === 'esp32' ? 'ESP32-CAM' : 'WEBCAM';
    videoSource.mode = mode;
    applyCanvasMirror(mode);
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem('fatigue_settings', JSON.stringify({
    earThreshold: earThresholdInput.value,
    marThreshold: marThresholdInput.value,
    esp32Url: esp32UrlInput.value,
    sourceMode: sourceToggle.value,
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
 * reflection. ESP32 feed is NOT mirrored. This function keeps the canvas
 * overlay in sync so landmarks always align with the displayed image.
 */
function applyCanvasMirror(mode) {
  if (mode === 'esp32') {
    // Remove mirror on both canvas and the img element
    overlayCanvas.style.transform = 'none';
  } else {
    // Restore mirror for webcam (matches the CSS scaleX(-1) on #videoFeed)
    overlayCanvas.style.transform = 'scaleX(-1)';
  }
}

// ── ESP32 Status pill helper ──────────────────────────────
function setEsp32Status(message) {
  if (!esp32Status) return;
  esp32Status.textContent = message;
  esp32Status.className = 'esp32-status'; // reset
  if (message.includes('Connecting')) {
    esp32Status.classList.add('connecting');
  } else if (message.includes('Connected')) {
    esp32Status.classList.add('connected');
  } else if (
    message.includes('failed') ||
    message.includes('error') ||
    message.includes('⚠')
  ) {
    esp32Status.classList.add('error');
  }
}

// ── Expose globals for inline HTML handlers ───────────────────────────────
window.__alertEngine = alertEngine;
window.__renderHistory = renderHistory;

// ── Boot ──────────────────────────────────────────────────────────────────
init();
