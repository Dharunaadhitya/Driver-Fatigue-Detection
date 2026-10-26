/**
 * VideoSource — manages webcam video stream.
 * Mode: 'webcam'
 */
export class VideoSource {
  constructor() {
    this.mode = 'webcam';
    this.stream = null;
    this.videoEl = null;
    this.onStatusChange = null; // callback(status: string)
  }

  /** Attach to a <video> element */
  async start(videoEl, _unused = null) {
    this.videoEl = videoEl;
    await this._startWebcam();
  }

  async switchMode(mode = 'webcam') {
    this.mode = 'webcam';
    await this._startWebcam();
  }

  /** Returns the active element (video) for frame capture */
  getActiveElement() {
    return this.videoEl;
  }

  /**
   * Returns the actual pixel dimensions of the active source.
   */
  getSourceDimensions() {
    return {
      width: this.videoEl ? (this.videoEl.videoWidth || 640) : 640,
      height: this.videoEl ? (this.videoEl.videoHeight || 480) : 480,
    };
  }

  isReady() {
    return (
      Boolean(this.videoEl) &&
      this.videoEl.readyState >= 2 &&
      !this.videoEl.paused
    );
  }

  async _startWebcam() {
    try {
      this._emit('Requesting webcam access…');
      console.log('[VideoSource] Requesting webcam access…');
      if (this.videoEl) {
        this.videoEl.style.display = 'block';
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      console.log('[VideoSource] Webcam active');
      this._emit('Webcam active');
    } catch (err) {
      console.error('[VideoSource] Webcam error:', err.message);
      this._emit('Webcam error: ' + err.message);
      throw err;
    }
  }

  _stopWebcam() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  }

  destroy() {
    this._stopWebcam();
  }

  _emit(status) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(status);
    }
  }
}
