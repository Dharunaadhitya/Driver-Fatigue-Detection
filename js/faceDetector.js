/**
 * FaceDetector — wraps MediaPipe FaceMesh.
 * Extracts eye, mouth, and head-pose landmarks per frame.
 */

// MediaPipe landmark indices for key regions
export const LANDMARKS = {
  // Left eye (from driver's perspective = camera right)
  LEFT_EYE: [362, 385, 387, 263, 373, 380],
  // Right eye
  RIGHT_EYE: [33, 160, 158, 133, 153, 144],
  // Mouth outer
  MOUTH: [61, 291, 0, 17, 269, 405, 14, 181],
  // Mouth inner (for yawn MAR).
  // Order matches _calcMAR formula: [left-corner, upper-left, upper-right, right-corner, lower-right, lower-left]
  // p1=left, p2=upper-left, p3=upper-right, p4=right, p5=lower-right, p6=lower-left
  // MAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
  MOUTH_INNER: [78, 82, 312, 308, 317, 87],
  // Head pose reference points
  NOSE_TIP: 1,
  CHIN: 152,
  LEFT_EYE_CORNER: 263,
  RIGHT_EYE_CORNER: 33,
  LEFT_MOUTH: 61,
  RIGHT_MOUTH: 291,
};

export class FaceDetector {
  constructor() {
    this.faceMesh = null;
    this.latestResults = null;
    this.onResults = null; // callback(results)
    this.isRunning = false;
    this.camera = null;
    this._inferring = false; // gate: one MediaPipe inference at a time
  }

  async init() {
    return new Promise((resolve, reject) => {
      try {
        this.faceMesh = new FaceMesh({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
        });

        this.faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        this.faceMesh.onResults((results) => {
          this.latestResults = results;
          if (typeof this.onResults === 'function') {
            this.onResults(this._processResults(results));
          }
        });

        // Initialize by sending a blank frame
        this.faceMesh.initialize().then(resolve).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a video/img frame to FaceMesh for processing.
   * Skips the frame if a previous inference is still running (prevents
   * a 60fps rAF from stacking hundreds of stale MediaPipe calls).
   */
  async send(element) {
    if (!this.faceMesh || !element) return;
    if (this._inferring) return; // skip — previous frame still processing
    this._inferring = true;
    try {
      await this.faceMesh.send({ image: element });
    } catch (err) {
      if (err && err.name === 'SecurityError') {
        // Canvas taint: the img element is cross-origin without CORS headers.
        // Fix: set imgEl.crossOrigin = 'anonymous' before imgEl.src.
        console.error('[FaceDetector] Cross-origin canvas taint — ensure crossOrigin=anonymous is set on the img element before src is assigned.');
      }
      // Other errors (e.g. frame not ready): silently ignore
    } finally {
      this._inferring = false;
    }
  }

  /** Extract structured data from raw MediaPipe results */
  _processResults(results) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      return { detected: false };
    }

    const lm = results.multiFaceLandmarks[0];

    const leftEye = LANDMARKS.LEFT_EYE.map((i) => lm[i]);
    const rightEye = LANDMARKS.RIGHT_EYE.map((i) => lm[i]);
    const mouth = LANDMARKS.MOUTH.map((i) => lm[i]);
    const mouthInner = LANDMARKS.MOUTH_INNER.map((i) => lm[i]);

    // Head pose reference points
    const noseTip = lm[LANDMARKS.NOSE_TIP];
    const chin = lm[LANDMARKS.CHIN];
    const leftEyeCorner = lm[LANDMARKS.LEFT_EYE_CORNER];
    const rightEyeCorner = lm[LANDMARKS.RIGHT_EYE_CORNER];

    return {
      detected: true,
      landmarks: lm,
      leftEye,
      rightEye,
      mouth,
      mouthInner,
      headPose: { noseTip, chin, leftEyeCorner, rightEyeCorner },
    };
  }

  destroy() {
    this.isRunning = false;
    if (this.faceMesh) {
      this.faceMesh.close();
    }
  }
}
