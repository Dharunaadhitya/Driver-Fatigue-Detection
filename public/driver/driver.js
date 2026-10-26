/**
 * DrowsyGuard Fleet — Driver Station In-Cab Client Controller
 * Wires untouched edge detection engines, in-cab kiosk UI, trip telemetry batching, and WebSockets.
 */

'use strict';

import { VideoSource } from '/js/videoSource.js';
import { FaceDetector } from '/js/faceDetector.js';
import { FatigueEngine } from '/js/fatigueEngine.js';
import { AlertEngine } from '/js/alertEngine.js';

// ── State ──────────────────────────────────────────────────────────────────
let currentDriver = null;
let driverToken = localStorage.getItem('drowsyguard_driver_token');
let currentTrip = null;
let isTripRunning = false;
let animFrameId = null;
let tripTimerInterval = null;
let tripStartTime = null;
let heartbeatInterval = null;
let ws = null;

// Telemetry batch queue
let eventQueue = [];
let batchFlushInterval = null;

// Instances
const videoSource = new VideoSource();
const faceDetector = new FaceDetector();
const fatigueEngine = new FatigueEngine();
const alertEngine = new AlertEngine();

// DOM References
const screenLogin = document.getElementById('screenLogin');
const screenPreTrip = document.getElementById('screenPreTrip');
const screenActiveTrip = document.getElementById('screenActiveTrip');

// Login Elements
const loginEmpId = document.getElementById('loginEmpId');
const pinDisplay = document.getElementById('pinDisplay');
let currentPin = '';

// Pre-Trip Elements
const preTripName = document.getElementById('preTripName');
const preTripDetails = document.getElementById('preTripDetails');
const preTripAvatar = document.getElementById('preTripAvatar');
const preTripCalibInfo = document.getElementById('preTripCalibInfo');

// Active Trip Elements
const kioskVideo = document.getElementById('kioskVideo');
const kioskCanvas = document.getElementById('kioskCanvas');
const ctx = kioskCanvas.getContext('2d');
const kioskVideoWrapper = document.getElementById('kioskVideoWrapper');
const kioskFaceBadge = document.getElementById('kioskFaceBadge');
const kioskSourceLabel = document.getElementById('kioskSourceLabel');
const hudStatusChip = document.getElementById('hudStatusChip');
const hudTripTimer = document.getElementById('hudTripTimer');
const kioskAlertBanner = document.getElementById('kioskAlertBanner');
const kioskAlertMessage = document.getElementById('kioskAlertMessage');
const microsleepOverlay = document.getElementById('microsleepOverlay');
const tripSummaryModal = document.getElementById('tripSummaryModal');

// Metric Value Elements
const kioskPerclosVal = document.getElementById('kioskPerclosVal');
const kioskPerclosArc = document.getElementById('kioskPerclosArc');
const kioskEarVal = document.getElementById('kioskEarVal');
const kioskEarState = document.getElementById('kioskEarState');
const kioskMarVal = document.getElementById('kioskMarVal');
const kioskYawnCount = document.getElementById('kioskYawnCount');
const kioskBlinkVal = document.getElementById('kioskBlinkVal');
const kioskTiltVal = document.getElementById('kioskTiltVal');

const tripWarningCount = document.getElementById('tripWarningCount');
const tripDangerCount = document.getElementById('tripDangerCount');
const tripMicrosleepCount = document.getElementById('tripMicrosleepCount');

let counts = { warnings: 0, dangers: 0, microsleeps: 0 };

// Arc Gauge Constants
const PERCLOS_R = 54;
const PERCLOS_CIRCUMFERENCE = 2 * Math.PI * PERCLOS_R;
if (kioskPerclosArc) {
  kioskPerclosArc.style.strokeDasharray = PERCLOS_CIRCUMFERENCE;
  kioskPerclosArc.style.strokeDashoffset = PERCLOS_CIRCUMFERENCE;
}

// ── Screen Navigation ──────────────────────────────────────────────────────
function showScreen(screen) {
  screenLogin.classList.remove('active');
  screenPreTrip.classList.remove('active');
  screenActiveTrip.classList.remove('active');
  screen.classList.add('active');
}

// ── Toast Notification ─────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Keypad Input ───────────────────────────────────────────────────────────
document.querySelectorAll('.keypad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    if (key === 'clear') {
      currentPin = '';
    } else if (key === 'backspace') {
      currentPin = currentPin.slice(0, -1);
    } else if (currentPin.length < 6) {
      currentPin += key;
    }
    pinDisplay.textContent = currentPin ? '•'.repeat(currentPin.length) : '····';
  });
});

document.querySelectorAll('.recent-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    loginEmpId.value = chip.getAttribute('data-id');
    currentPin = chip.getAttribute('data-pin');
    pinDisplay.textContent = '•'.repeat(currentPin.length);
  });
});

// ── Driver Login Action ───────────────────────────────────────────────────
document.getElementById('startShiftBtn').addEventListener('click', async () => {
  const employee_id = loginEmpId.value.trim().toUpperCase();
  const pin = currentPin;

  if (!employee_id || !pin) {
    showToast('Enter Employee ID and 4-digit PIN', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/driver-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_id, pin })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Authentication failed');

    driverToken = data.token;
    currentDriver = data.driver;
    localStorage.setItem('drowsyguard_driver_token', driverToken);
    localStorage.setItem('drowsyguard_driver_profile', JSON.stringify(currentDriver));

    setupPreTripScreen();
  } catch (err) {
    showToast(err.message, 'error');
    currentPin = '';
    pinDisplay.textContent = '····';
  }
});

function setupPreTripScreen() {
  preTripName.textContent = currentDriver.name;
  preTripDetails.textContent = `${currentDriver.employeeId} · ${currentDriver.vehicle}`;
  preTripAvatar.textContent = currentDriver.name.split(' ').map(n=>n[0]).join('');

  if (currentDriver.baselineEar) {
    preTripCalibInfo.textContent = `Saved Calibration Active (Baseline EAR: ${currentDriver.baselineEar.toFixed(3)})`;
    fatigueEngine.calibrationEAR = currentDriver.baselineEar;
    fatigueEngine.calibrated = true;
  } else {
    preTripCalibInfo.textContent = 'Standard Calibration Active (Baseline EAR: 0.310)';
    fatigueEngine.calibrationEAR = 0.31;
    fatigueEngine.calibrated = true;
  }

  showScreen(screenPreTrip);
}

document.getElementById('preTripLogoutBtn').addEventListener('click', () => {
  driverToken = null;
  currentDriver = null;
  localStorage.removeItem('drowsyguard_driver_token');
  currentPin = '';
  pinDisplay.textContent = '····';
  showScreen(screenLogin);
});

// ── Canvas Mirror Helper ──────────────────────────────────────────────────
function applyCanvasMirror() {
  kioskCanvas.style.transform = 'scaleX(-1)';
}

// Test Stream Button
const testStreamBtn = document.getElementById('testStreamBtn');
const preTripCameraStatus = document.getElementById('preTripCameraStatus');
if (testStreamBtn) {
  testStreamBtn.addEventListener('click', async () => {
    preTripCameraStatus.textContent = 'Testing…';
    preTripCameraStatus.className = 'status-chip warning';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      preTripCameraStatus.textContent = 'Webcam Ready ✓';
      preTripCameraStatus.className = 'status-chip safe';
      showToast('Webcam connection confirmed', 'success');
    } catch (err) {
      preTripCameraStatus.textContent = 'Webcam Denied ✗';
      preTripCameraStatus.className = 'status-chip offline';
      showToast('Webcam access error: ' + err.message, 'error');
    }
  });
}

// ── Shift Break / Pause Controls ──────────────────────────────────────────
const hudBreakBtn = document.getElementById('hudBreakBtn');
const kioskBreakOverlay = document.getElementById('kioskBreakOverlay');
const breakDurationTimer = document.getElementById('breakDurationTimer');
const btnResumeBreak = document.getElementById('btnResumeBreak');

let isTripPaused = false;
let breakStartTime = null;
let breakTimerInterval = null;

function updateBreakTimer() {
  if (!breakStartTime || !breakDurationTimer) return;
  const elapsed = Math.floor((Date.now() - breakStartTime) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  breakDurationTimer.textContent = `${m}:${s}`;
}

function toggleBreak() {
  if (!isTripRunning) {
    showToast('Shift has not started yet', 'info');
    return;
  }

  isTripPaused = !isTripPaused;

  if (isTripPaused) {
    // Entering rest break
    breakStartTime = Date.now();
    if (breakTimerInterval) clearInterval(breakTimerInterval);
    breakTimerInterval = setInterval(updateBreakTimer, 1000);
    if (breakDurationTimer) breakDurationTimer.textContent = '00:00';

    if (hudBreakBtn) {
      hudBreakBtn.innerHTML = '▶ Resume Shift';
      hudBreakBtn.className = 'btn btn-primary btn-sm';
    }

    hudStatusChip.textContent = 'On Break';
    hudStatusChip.className = 'status-chip offline';
    kioskFaceBadge.textContent = '☕ Rest Break';
    kioskFaceBadge.className = 'status-chip offline';

    if (kioskBreakOverlay) kioskBreakOverlay.style.display = 'flex';

    // Cancel alarms & alert visuals
    alertEngine._stopContinuousAlarm();
    microsleepOverlay.classList.remove('active');
    kioskAlertBanner.classList.add('hidden');
    kioskVideoWrapper.className = 'kiosk-video-wrapper level-normal';
    ctx.clearRect(0, 0, kioskCanvas.width, kioskCanvas.height);

    showToast('Driving shift paused. Rest break in progress.', 'info');
  } else {
    // Resuming shift
    if (breakTimerInterval) clearInterval(breakTimerInterval);
    breakStartTime = null;

    if (hudBreakBtn) {
      hudBreakBtn.innerHTML = '⏸ Take Break';
      hudBreakBtn.className = 'btn btn-secondary btn-sm';
    }

    hudStatusChip.textContent = 'Safe';
    hudStatusChip.className = 'status-chip safe';
    kioskFaceBadge.textContent = '✓ Active';
    kioskFaceBadge.className = 'status-chip safe';

    if (kioskBreakOverlay) kioskBreakOverlay.style.display = 'none';

    // Flush rolling buffers so pre-break frames do not trigger instant alert
    fatigueEngine.earHistory = [];
    fatigueEngine.earBuffer = [];
    fatigueEngine.marBuffer = [];
    fatigueEngine.eyesClosedFrames = 0;
    fatigueEngine.yawnFrames = 0;

    showToast('Driving shift resumed. Real-time fatigue monitoring active ✓', 'success');
  }
}

if (hudBreakBtn) {
  hudBreakBtn.addEventListener('click', toggleBreak);
}
if (btnResumeBreak) {
  btnResumeBreak.addEventListener('click', toggleBreak);
}

// ── Begin Trip Shift Action ───────────────────────────────────────────────
document.getElementById('beginTripBtn').addEventListener('click', async () => {
  videoSource.mode = 'webcam';
  applyCanvasMirror();
  kioskSourceLabel.textContent = 'WEBCAM';

  try {
    // 1. Initialize face detection engine if not already loaded
    if (!faceDetector.faceMesh) {
      await faceDetector.init();
      faceDetector.onResults = handleFaceResults;
    }

    // 2. Start Video Source
    await videoSource.start(kioskVideo);

    // 3. Register trip with backend
    const res = await fetch('/api/trips', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${driverToken}`
      },
      body: JSON.stringify({ driver_id: currentDriver.id })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start trip');

    // Ensure calibrated baseline EAR is active
    const baseline = (currentDriver && currentDriver.baselineEar) ? currentDriver.baselineEar : 0.31;
    fatigueEngine.calibrationEAR = baseline;
    fatigueEngine.calibrated = true;

    // Wire alert engine incident transitions
    let lastSnapshotTriggerTime = 0;

    async function captureWebcamSnapshot(triggerType = 'microsleep') {
      if (!kioskVideo || !kioskVideo.videoWidth) {
        console.warn('[Snapshot] Webcam not ready for capture');
        return;
      }
      try {
        const snapCanvas = document.createElement('canvas');
        snapCanvas.width = kioskVideo.videoWidth || 640;
        snapCanvas.height = kioskVideo.videoHeight || 480;
        const sCtx = snapCanvas.getContext('2d');

        // Un-mirror frame for clean photo
        sCtx.save();
        sCtx.scale(-1, 1);
        sCtx.drawImage(kioskVideo, -snapCanvas.width, 0, snapCanvas.width, snapCanvas.height);
        sCtx.restore();

        // Stamped telemetry bar
        sCtx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        sCtx.fillRect(0, snapCanvas.height - 34, snapCanvas.width, 34);
        sCtx.fillStyle = '#FFFFFF';
        sCtx.font = 'bold 13px monospace';
        const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const empId = (currentDriver && (currentDriver.empId || currentDriver.employee_id)) || 'DRV-101';
        sCtx.fillText(`[${empId}] ${nowStr}  INCIDENT: ${triggerType.toUpperCase()}`, 12, snapCanvas.height - 12);

        snapCanvas.toBlob(async (blob) => {
          if (!blob) return;
          const formData = new FormData();
          formData.append('driver_id', empId);
          formData.append('trigger', triggerType);
          formData.append('snapshot', blob, `snap_${Date.now()}.jpg`);

          try {
            const res = await fetch('/api/snapshots/upload', {
              method: 'POST',
              headers: driverToken ? { 'Authorization': `Bearer ${driverToken}` } : {},
              body: formData
            });
            if (res.ok) {
              const resData = await res.json();
              console.log('[Snapshot] Webcam incident snapshot saved:', resData);
              showToast(`📸 Incident snapshot saved (${triggerType})`, 'info');
            }
          } catch (err) {
            console.warn('[Snapshot] Upload fetch error:', err);
          }
        }, 'image/jpeg', 0.88);
      } catch (err) {
        console.warn('[Snapshot] Frame capture error:', err);
      }
    }

    const hudSnapshotBtn = document.getElementById('hudSnapshotBtn');
    if (hudSnapshotBtn) {
      hudSnapshotBtn.onclick = () => captureWebcamSnapshot('manual');
    }
    window.captureWebcamSnapshot = captureWebcamSnapshot;

    alertEngine.onLevelChange = (level, message) => {
      if (level === 'warning') {
        counts.warnings++;
        tripWarningCount.textContent = counts.warnings;
      } else if (level === 'danger') {
        counts.dangers++;
        tripDangerCount.textContent = counts.dangers;
      } else if (level === 'microsleep') {
        counts.microsleeps++;
        tripMicrosleepCount.textContent = counts.microsleeps;
      }

      // Automatically capture snapshot on severe fatigue
      if (level === 'microsleep' || level === 'danger') {
        const now = Date.now();
        if (now - lastSnapshotTriggerTime > 4000) {
          lastSnapshotTriggerTime = now;
          captureWebcamSnapshot(level);
        }
      }
    };

    currentTrip = data;
    isTripRunning = true;
    tripStartTime = Date.now();
    counts = { warnings: 0, dangers: 0, microsleeps: 0 };
    tripWarningCount.textContent = '0';
    tripDangerCount.textContent = '0';
    tripMicrosleepCount.textContent = '0';

    document.getElementById('hudDriverName').textContent = currentDriver.name;
    document.getElementById('hudVehicleName').textContent = currentDriver.vehicle;

    showScreen(screenActiveTrip);

    // Start Telemetry and Loop
    if (tripTimerInterval) clearInterval(tripTimerInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (batchFlushInterval) clearInterval(batchFlushInterval);

    tripTimerInterval = setInterval(updateTripTimer, 1000);
    heartbeatInterval = setInterval(sendHeartbeat, 5000);
    batchFlushInterval = setInterval(flushEventQueue, 3000);

    setupWebSocket();
    loop();
  } catch (err) {
    showToast('Failed to start in-cab camera: ' + err.message, 'error');
  }
});

// ── In-Cab Detection Loop ─────────────────────────────────────────────────
function loop() {
  if (!isTripRunning) return;
  animFrameId = requestAnimationFrame(loop);

  if (isTripPaused) return;

  if (!videoSource.isReady()) return;
  const el = videoSource.getActiveElement();

  const { width: w, height: h } = videoSource.getSourceDimensions();
  if (kioskCanvas.width !== w || kioskCanvas.height !== h) {
    kioskCanvas.width = w;
    kioskCanvas.height = h;
  }

  faceDetector.send(el);
}

function handleFaceResults(faceData) {
  const state = fatigueEngine.update(faceData);
  const level = alertEngine.evaluate(state);

  // Update Face Badge
  if (faceData.detected) {
    kioskFaceBadge.textContent = '✓ Face Detected';
    kioskFaceBadge.className = 'status-chip safe';
  } else {
    kioskFaceBadge.textContent = '✗ No Face';
    kioskFaceBadge.className = 'status-chip offline';
  }

  // Update HUD Gauges
  updateKioskGauges(state, level);

  // Queue incidents for server telemetry
  if (level !== 'normal') {
    eventQueue.push({
      timestamp: new Date().toISOString(),
      type: state.microsleep ? 'microsleep' : state.yawning ? 'yawn' : level,
      severity: level === 'microsleep' ? 'critical' : level,
      duration_ms: 1000,
      ear: state.ear,
      mar: state.mar,
      perclos: state.perclos,
    });
  }

  // Draw landmarks
  ctx.clearRect(0, 0, kioskCanvas.width, kioskCanvas.height);
  if (faceData.detected) {
    drawLandmarks(faceData, level);
  }
}

function updateKioskGauges(state, level) {
  kioskEarVal.textContent = state.ear.toFixed(3);
  kioskEarState.textContent = state.eyesClosed ? 'Closed' : 'Open';
  kioskEarVal.style.color = state.eyesClosed ? 'var(--critical)' : 'var(--text)';

  kioskMarVal.textContent = state.mar.toFixed(3);
  kioskYawnCount.textContent = `Yawns: ${state.yawnCount}`;

  kioskBlinkVal.textContent = state.blinkRatePerMin;
  kioskTiltVal.textContent = `${state.headTilt.toFixed(0)}° / ${state.headNod.toFixed(0)}°`;

  // PERCLOS Arc
  const pct = Math.min(1, state.perclos);
  kioskPerclosVal.textContent = (pct * 100).toFixed(1) + '%';
  const offset = PERCLOS_CIRCUMFERENCE * (1 - pct);
  kioskPerclosArc.style.strokeDashoffset = offset;

  const color = state.microsleep ? 'var(--critical)' : pct > 0.7 ? 'var(--danger)' : pct > 0.4 ? 'var(--warning)' : 'var(--safe)';
  kioskPerclosArc.style.stroke = color;
  kioskPerclosVal.style.color = color;

  // Status chip and wrapper glow
  hudStatusChip.textContent = level;
  hudStatusChip.className = `status-chip ${level === 'microsleep' ? 'critical' : level}`;
  kioskVideoWrapper.className = `kiosk-video-wrapper level-${level}`;

  // Alert Banner
  if (level !== 'normal') {
    kioskAlertBanner.classList.remove('hidden');
    kioskAlertBanner.className = `alert-banner ${level === 'microsleep' ? 'microsleep' : level}`;
    kioskAlertMessage.textContent = state.microsleep ? 'CRITICAL: MICROSLEEP DETECTED' : level.toUpperCase() + ' FATIGUE';
  } else {
    kioskAlertBanner.classList.add('hidden');
  }

  // Microsleep Full-Screen In-Cab Overlay
  if (state.microsleep) {
    microsleepOverlay.classList.add('active');
  } else {
    microsleepOverlay.classList.remove('active');
  }
}

function drawLandmarks(faceData, level) {
  const W = kioskCanvas.width;
  const H = kioskCanvas.height;

  const eyeColor = level === 'normal' ? '#22C55E' : level === 'warning' ? '#F59E0B' : '#EF4444';

  for (const eye of [faceData.leftEye, faceData.rightEye]) {
    ctx.beginPath();
    eye.forEach((p, i) => {
      const x = p.x * W;
      const y = p.y * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = eyeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function updateTripTimer() {
  if (!tripStartTime) return;
  const elapsed = Math.floor((Date.now() - tripStartTime) / 1000);
  const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
  const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  hudTripTimer.textContent = `${h}:${m}:${s}`;
}

// ── Batch Event Ingestion ─────────────────────────────────────────────────
async function flushEventQueue() {
  if (eventQueue.length === 0 || !currentTrip) return;
  const eventsToSend = [...eventQueue];
  eventQueue = [];

  try {
    await fetch('/api/events/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${driverToken}`
      },
      body: JSON.stringify({ trip_id: currentTrip.tripId, events: eventsToSend })
    });
  } catch (_) {
    // Re-queue on failure
    eventQueue = [...eventsToSend, ...eventQueue];
  }
}

// ── WebSocket Heartbeat ───────────────────────────────────────────────────
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', role: 'driver', driverId: currentDriver.id }));
  };
}

function sendHeartbeat() {
  if (ws && ws.readyState === 1 && currentTrip) {
    ws.send(JSON.stringify({
      type: 'heartbeat',
      driverId: currentDriver.id,
      tripId: currentTrip.tripId,
      status: hudStatusChip.textContent,
      perclos: parseFloat(kioskPerclosVal.textContent) / 100,
      ear: parseFloat(kioskEarVal.textContent) || 0,
      blinkRate: parseInt(kioskBlinkVal.textContent, 10) || 0,
    }));
  }
}

// ── End Trip Shift Action ─────────────────────────────────────────────────
document.getElementById('hudEndTripBtn').addEventListener('click', async () => {
  if (!confirm('Conclude active driving trip?')) return;

  isTripRunning = false;
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (tripTimerInterval) clearInterval(tripTimerInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (batchFlushInterval) clearInterval(batchFlushInterval);
  if (breakTimerInterval) clearInterval(breakTimerInterval);
  isTripPaused = false;
  if (kioskBreakOverlay) kioskBreakOverlay.style.display = 'none';
  if (hudBreakBtn) {
    hudBreakBtn.innerHTML = '⏸ Take Break';
    hudBreakBtn.className = 'btn btn-secondary btn-sm';
  }

  await flushEventQueue();
  videoSource.destroy();
  ctx.clearRect(0, 0, kioskCanvas.width, kioskCanvas.height);

  try {
    const res = await fetch(`/api/trips/${currentTrip.tripId}/end`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${driverToken}` }
    });

    const summary = await res.json();
    document.getElementById('summaryDuration').textContent = `${Math.round(summary.durationSeconds / 60)} minutes`;
    const riskBadge = document.getElementById('summaryRiskBadge');
    riskBadge.textContent = `${summary.riskLevel} (${summary.riskScore})`;
    riskBadge.className = `risk-badge ${summary.riskLevel.toLowerCase()}`;

    document.getElementById('summaryWarnings').textContent = summary.warnings;
    document.getElementById('summaryDangers').textContent = summary.dangers;
    document.getElementById('summaryMicrosleeps').textContent = summary.microsleeps;

    tripSummaryModal.classList.add('active');
  } catch (err) {
    showToast('Error ending trip: ' + err.message, 'error');
  }
});

document.getElementById('finishShiftBtn').addEventListener('click', () => {
  tripSummaryModal.classList.remove('active');
  currentPin = '';
  pinDisplay.textContent = '····';
  showScreen(screenLogin);
});

// Check if already authenticated on load
if (driverToken) {
  const profile = localStorage.getItem('drowsyguard_driver_profile');
  if (profile) {
    currentDriver = JSON.parse(profile);
    setupPreTripScreen();
  }
}
