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
const preTripCameraSelect = document.getElementById('preTripCameraSelect');
const preTripStreamUrl = document.getElementById('preTripStreamUrl');
const esp32UrlGroup = document.getElementById('esp32UrlGroup');
const preTripCalibInfo = document.getElementById('preTripCalibInfo');

// Active Trip Elements
const kioskVideo = document.getElementById('kioskVideo');
const kioskEsp32 = document.getElementById('kioskEsp32');
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
function applyCanvasMirror(mode) {
  if (mode === 'esp32') {
    kioskCanvas.style.transform = 'none';
  } else {
    kioskCanvas.style.transform = 'scaleX(-1)';
  }
}

// Camera selection
preTripCameraSelect.addEventListener('change', () => {
  const isEsp = preTripCameraSelect.value === 'esp32';
  esp32UrlGroup.style.display = isEsp ? 'block' : 'none';
  kioskSourceLabel.textContent = isEsp ? 'ESP32-CAM' : 'WEBCAM';
});

// Test Stream Button
const testStreamBtn = document.getElementById('testStreamBtn');
const preTripCameraStatus = document.getElementById('preTripCameraStatus');
if (testStreamBtn) {
  testStreamBtn.addEventListener('click', async () => {
    const mode = preTripCameraSelect.value;
    preTripCameraStatus.textContent = 'Testing…';
    preTripCameraStatus.className = 'status-chip warning';

    if (mode === 'webcam') {
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
    } else {
      const url = preTripStreamUrl.value.trim() || '/esp32/stream';
      const testImg = new Image();
      testImg.onload = () => {
        preTripCameraStatus.textContent = 'ESP32 Linked ✓';
        preTripCameraStatus.className = 'status-chip safe';
        showToast('ESP32 stream reachable', 'success');
      };
      testImg.onerror = () => {
        preTripCameraStatus.textContent = 'ESP32 Offline ✗';
        preTripCameraStatus.className = 'status-chip offline';
        showToast('ESP32 stream unreachable. Please check WiFi or use Webcam.', 'error');
      };
      testImg.src = url + '?t=' + Date.now();
    }
  });
}

// HUD Camera Quick Switch Button
const hudSwitchCameraBtn = document.getElementById('hudSwitchCameraBtn');
if (hudSwitchCameraBtn) {
  hudSwitchCameraBtn.addEventListener('click', async () => {
    const newMode = videoSource.mode === 'webcam' ? 'esp32' : 'webcam';
    try {
      await videoSource.switchMode(newMode);
      applyCanvasMirror(newMode);
      kioskSourceLabel.textContent = newMode === 'webcam' ? 'WEBCAM' : 'ESP32-CAM';
      showToast(`Switched camera to ${newMode === 'webcam' ? 'Webcam' : 'ESP32-CAM'}`, 'info');
    } catch (err) {
      showToast('Camera switch failed: ' + err.message, 'error');
    }
  });
}

// ── Camera Image Tuning Controls ──────────────────────────────────────────
const hudTuneCameraBtn = document.getElementById('hudTuneCameraBtn');
const cameraTunePanel = document.getElementById('cameraTunePanel');
const tuneCloseBtn = document.getElementById('tuneCloseBtn');
const tuneSat = document.getElementById('tuneSat');
const tuneContrast = document.getElementById('tuneContrast');
const tuneBright = document.getElementById('tuneBright');
const tuneQuality = document.getElementById('tuneQuality');
const valSat = document.getElementById('valSat');
const valContrast = document.getElementById('valContrast');
const valBright = document.getElementById('valBright');
const btnAutoTune = document.getElementById('btnAutoTune');

if (hudTuneCameraBtn && cameraTunePanel) {
  hudTuneCameraBtn.addEventListener('click', () => {
    const isHidden = cameraTunePanel.style.display === 'none';
    cameraTunePanel.style.display = isHidden ? 'block' : 'none';
  });
}

if (tuneCloseBtn && cameraTunePanel) {
  tuneCloseBtn.addEventListener('click', () => {
    cameraTunePanel.style.display = 'none';
  });
}

async function sendCameraControl(varName, val) {
  try {
    await fetch('/api/camera/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ var: varName, val: parseInt(val, 10) })
    });
  } catch (err) {
    console.warn('Camera control error:', err);
  }
}

if (tuneSat) {
  tuneSat.addEventListener('input', (e) => {
    valSat.textContent = (e.target.value > 0 ? '+' : '') + e.target.value;
  });
  tuneSat.addEventListener('change', (e) => {
    sendCameraControl('saturation', e.target.value);
  });
}

if (tuneContrast) {
  tuneContrast.addEventListener('input', (e) => {
    valContrast.textContent = (e.target.value > 0 ? '+' : '') + e.target.value;
  });
  tuneContrast.addEventListener('change', (e) => {
    sendCameraControl('contrast', e.target.value);
  });
}

if (tuneBright) {
  tuneBright.addEventListener('input', (e) => {
    valBright.textContent = (e.target.value > 0 ? '+' : '') + e.target.value;
  });
  tuneBright.addEventListener('change', (e) => {
    sendCameraControl('brightness', e.target.value);
  });
}

if (tuneQuality) {
  tuneQuality.addEventListener('change', (e) => {
    sendCameraControl('quality', e.target.value);
    showToast(`Camera compression set to ${e.target.options[e.target.selectedIndex].text}`, 'info');
  });
}

if (btnAutoTune) {
  btnAutoTune.addEventListener('click', async () => {
    try {
      await fetch('/api/camera/tune', { method: 'POST' });
      if (tuneSat) { tuneSat.value = 1; valSat.textContent = '+1'; }
      if (tuneContrast) { tuneContrast.value = 1; valContrast.textContent = '+1'; }
      if (tuneBright) { tuneBright.value = 0; valBright.textContent = '0'; }
      if (tuneQuality) { tuneQuality.value = 10; }
      showToast('Camera auto-calibrated: rich color & high sharpness ✓', 'success');
    } catch (err) {
      showToast('Auto-tuning error: ' + err.message, 'error');
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
  const mode = preTripCameraSelect.value;
  const streamUrl = preTripStreamUrl.value.trim() || '/esp32/stream';

  videoSource.mode = mode;
  if (mode === 'esp32') {
    videoSource.setEsp32Url(streamUrl);
  }
  applyCanvasMirror(mode);
  kioskSourceLabel.textContent = mode === 'webcam' ? 'WEBCAM' : 'ESP32-CAM';

  try {
    // 1. Initialize face detection engine if not already loaded
    if (!faceDetector.faceMesh) {
      await faceDetector.init();
      faceDetector.onResults = handleFaceResults;
    }

    // 2. Start Video Source
    await videoSource.start(kioskVideo, kioskEsp32);

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

      // Fire-and-forget incident snapshot capture to ESP32 on severe fatigue
      if ((level === 'microsleep' || level === 'danger') && driverToken) {
        const now = Date.now();
        if (now - lastSnapshotTriggerTime > 8000) {
          lastSnapshotTriggerTime = now;
          fetch('/api/snapshots/trigger', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${driverToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trigger: level })
          }).catch(() => {});
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
