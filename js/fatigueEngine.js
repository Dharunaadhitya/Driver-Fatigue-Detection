/**
 * FatigueEngine — calculates EAR, MAR, PERCLOS, blink rate, head pose.
 * All thresholds are configurable.
 */
export class FatigueEngine {
  constructor(config = {}) {
    // --- Thresholds ---
    this.EAR_THRESHOLD = config.earThreshold ?? 0.22;      // below = eyes closing
    this.MAR_THRESHOLD = config.marThreshold ?? 0.55;       // above = possible yawn
    this.HEAD_TILT_THRESHOLD = config.headTiltThreshold ?? 20; // degrees
    this.HEAD_NOD_THRESHOLD = config.headNodThreshold ?? 15;   // degrees
    this.MICROSLEEP_FRAMES = config.microsleepFrames ?? 45;    // ~1.5s at 30fps
    this.PERCLOS_WINDOW_MS = config.perclosWindowMs ?? 30000;  // 30s window
    // Yawn must be sustained for this many consecutive frames to count (~0.7s at 30fps)
    this.YAWN_SUSTAIN_FRAMES = config.yawnSustainFrames ?? 20;

    // --- State ---
    this.earHistory = []; // { time, ear, closed }
    this.blinkLog = [];   // timestamps of blink starts
    this.earBuffer = [];  // rolling EAR smoothing
    this.marBuffer = [];  // rolling MAR smoothing
    this.SMOOTH_N = 5;

    this.eyesClosedFrames = 0;
    this.lastBlinkStart = null;
    this.isBlinking = false;
    this.blinkCount = 0;

    // Yawn state
    this.yawnFrames = 0;    // consecutive frames mouth has been open wide
    this.yawnDetected = false;
    this.yawnCount = 0;

    this.currentEAR = 0;
    this.currentMAR = 0;
    this.headTilt = 0;
    this.headNod = 0;

    this.calibrationEAR = null; // auto-calibrated open-eye baseline
    this.calibFrames = [];
    this.calibrated = false;
    this.CALIB_FRAMES = 60; // ~2s of frames for calibration
  }

  /**
   * Main update — call every frame with face landmark data.
   * Returns a FatigueState object.
   */
  update(faceData) {
    if (!faceData.detected) {
      return this._noFaceState();
    }

    const { leftEye, rightEye, mouth, mouthInner, headPose } = faceData;

    const leftEAR = this._calcEAR(leftEye);
    const rightEAR = this._calcEAR(rightEye);
    const ear = (leftEAR + rightEAR) / 2;

    // Smooth EAR
    this.earBuffer.push(ear);
    if (this.earBuffer.length > this.SMOOTH_N) this.earBuffer.shift();
    const smoothEAR = this.earBuffer.reduce((a, b) => a + b, 0) / this.earBuffer.length;

    // Auto-calibration (first N frames, eyes open)
    if (!this.calibrated) {
      this._calibrate(smoothEAR);
    }

    // Use calibrated threshold if available
    const threshold = this.calibrated
      ? this.calibrationEAR * 0.75
      : this.EAR_THRESHOLD;

    const eyesClosed = smoothEAR < threshold;

    // Track blink / microsleep
    if (eyesClosed) {
      this.eyesClosedFrames++;
      if (!this.isBlinking) {
        this.isBlinking = true;
        this.lastBlinkStart = Date.now();
      }
    } else {
      if (this.isBlinking) {
        const duration = Date.now() - this.lastBlinkStart;
        this.blinkLog.push({ time: Date.now(), duration });
        this.blinkCount++;
        this.isBlinking = false;
      }
      this.eyesClosedFrames = 0;
    }

    // MAR — smooth then apply sustained-frame yawn detection
    const rawMAR = this._calcMAR(mouthInner);
    this.marBuffer.push(rawMAR);
    if (this.marBuffer.length > this.SMOOTH_N) this.marBuffer.shift();
    const mar = this.marBuffer.reduce((a, b) => a + b, 0) / this.marBuffer.length;

    if (mar > this.MAR_THRESHOLD) {
      this.yawnFrames++;
      // Only register a new yawn once it has been sustained long enough
      if (this.yawnFrames === this.YAWN_SUSTAIN_FRAMES) {
        this.yawnDetected = true;
        this.yawnCount++;
      }
    } else if (mar < this.MAR_THRESHOLD * 0.75) {
      // Hysteresis: only clear yawn flag once mouth is clearly closed
      this.yawnFrames = 0;
      this.yawnDetected = false;
    }

    // Head pose
    const { tilt, nod } = this._calcHeadPose(headPose);

    // PERCLOS calculation
    const perclos = this._calcPERCLOS(smoothEAR < threshold);

    // Record history
    this.earHistory.push({ time: Date.now(), ear: smoothEAR, closed: eyesClosed });
    const cutoff = Date.now() - this.PERCLOS_WINDOW_MS;
    this.earHistory = this.earHistory.filter((e) => e.time > cutoff);

    // Clean blink log
    this.blinkLog = this.blinkLog.filter((b) => b.time > cutoff);

    // Store current values
    this.currentEAR = smoothEAR;
    this.currentMAR = mar;
    this.headTilt = tilt;
    this.headNod = nod;

    return {
      detected: true,
      calibrated: this.calibrated,
      ear: smoothEAR,
      mar,
      perclos,
      eyesClosed,
      eyesClosedFrames: this.eyesClosedFrames,
      microsleep: this.eyesClosedFrames >= this.MICROSLEEP_FRAMES,
      yawning: this.yawnDetected,
      yawnCount: this.yawnCount,
      blinkCount: this.blinkCount,
      blinkRatePerMin: this._blinkRate(),
      headTilt: tilt,
      headNod: nod,
      headTiltAlert: Math.abs(tilt) > this.HEAD_TILT_THRESHOLD,
      headNodAlert: Math.abs(nod) > this.HEAD_NOD_THRESHOLD,
    };
  }

  /**
   * Eye Aspect Ratio: ratio of vertical to horizontal eye distance.
   * EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
   * Landmarks order: [p1, p2, p3, p4, p5, p6] = corners + top/bottom
   */
  _calcEAR(eye) {
    const [p1, p2, p3, p4, p5, p6] = eye;
    const vertical1 = this._dist(p2, p6);
    const vertical2 = this._dist(p3, p5);
    const horizontal = this._dist(p1, p4);
    return (vertical1 + vertical2) / (2.0 * horizontal);
  }

  /**
   * Mouth Aspect Ratio: vertical mouth opening / horizontal width.
   */
  _calcMAR(mouth) {
    if (!mouth || mouth.length < 6) return 0;
    const [p1, p2, p3, p4, p5, p6] = mouth;
    const vertical1 = this._dist(p2, p6);
    const vertical2 = this._dist(p3, p5);
    const horizontal = this._dist(p1, p4);
    if (horizontal === 0) return 0;
    return (vertical1 + vertical2) / (2.0 * horizontal);
  }

  /**
   * Head pose — estimate tilt and nod from eye corners and nose/chin.
   * Returns angles in degrees.
   */
  _calcHeadPose({ leftEyeCorner, rightEyeCorner, noseTip, chin }) {
    // Tilt: angle of the eye line relative to horizontal
    const dx = rightEyeCorner.x - leftEyeCorner.x;
    const dy = rightEyeCorner.y - leftEyeCorner.y;
    const tilt = Math.atan2(dy, dx) * (180 / Math.PI);

    // Nod: vertical displacement of nose relative to eye midpoint
    const eyeMidY = (leftEyeCorner.y + rightEyeCorner.y) / 2;
    const eyeSpan = Math.abs(dx) || 0.01;
    const nod = ((noseTip.y - eyeMidY) / eyeSpan) * 90; // normalize

    return { tilt, nod };
  }

  /** Rolling PERCLOS: % of frames where eyes were closed in the last window */
  _calcPERCLOS(eyesClosed) {
    const now = Date.now();
    if (!this._perclosBuffer) this._perclosBuffer = [];
    this._perclosBuffer.push({ time: now, closed: eyesClosed });
    const cutoff = now - this.PERCLOS_WINDOW_MS;
    this._perclosBuffer = this._perclosBuffer.filter((e) => e.time > cutoff);
    const closedCount = this._perclosBuffer.filter((e) => e.closed).length;
    return closedCount / this._perclosBuffer.length;
  }

  _blinkRate() {
    const windowMs = 60000;
    const cutoff = Date.now() - windowMs;
    return this.blinkLog.filter((b) => b.time > cutoff).length;
  }

  _calibrate(ear) {
    this.calibFrames.push(ear);
    if (this.calibFrames.length >= this.CALIB_FRAMES) {
      // Use 90th percentile as "open eye" baseline
      const sorted = [...this.calibFrames].sort((a, b) => a - b);
      const p90idx = Math.floor(sorted.length * 0.9);
      this.calibrationEAR = sorted[p90idx];
      this.calibrated = true;
    }
  }

  _dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _noFaceState() {
    return {
      detected: false,
      calibrated: this.calibrated,
      ear: 0,
      mar: 0,
      perclos: 0,
      eyesClosed: false,
      eyesClosedFrames: 0,
      microsleep: false,
      yawning: false,
      yawnCount: this.yawnCount,
      blinkCount: this.blinkCount,
      blinkRatePerMin: this._blinkRate(),
      headTilt: 0,
      headNod: 0,
      headTiltAlert: false,
      headNodAlert: false,
    };
  }

  reset() {
    this.earHistory = [];
    this.blinkLog = [];
    this.earBuffer = [];
    this.marBuffer = [];
    this._perclosBuffer = [];
    this.eyesClosedFrames = 0;
    this.isBlinking = false;
    this.blinkCount = 0;
    this.yawnFrames = 0;
    this.yawnCount = 0;
    this.yawnDetected = false;
    this.calibFrames = [];
    this.calibrated = false;
    this.calibrationEAR = null;
  }

  updateThresholds(config) {
    if (config.earThreshold !== undefined) this.EAR_THRESHOLD = config.earThreshold;
    if (config.marThreshold !== undefined) this.MAR_THRESHOLD = config.marThreshold;
    if (config.headTiltThreshold !== undefined) this.HEAD_TILT_THRESHOLD = config.headTiltThreshold;
  }
}
