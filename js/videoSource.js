/**
 * VideoSource — abstracts between webcam and ESP32-CAM MJPEG stream.
 * Mode: 'webcam' | 'esp32'
 */
export class VideoSource {
  constructor() {
    this.mode = 'webcam';
    // Routed through the local server proxy → server.js → config.json → real ESP32 IP
    // No CORS or mixed-content issues when served via npm start
    this.esp32Url = '/esp32/stream';
    this.stream = null;
    this.videoEl = null;
    this.imgEl = null;
    this.onStatusChange = null; // callback(status: string)
    this._esp32Connected = false; // true once first MJPEG frame arrives
  }

  /** Attach to a <video> element (webcam) or <img> element (ESP32) */
  async start(videoEl, imgEl) {
    this.videoEl = videoEl;
    this.imgEl = imgEl;
    await this._applyMode();
  }

  setEsp32Url(url) {
    this.esp32Url = url.trim();
  }

  async switchMode(mode) {
    // Always tear down both sources before switching
    this._stopWebcam();
    this._disconnectEsp32();
    this.mode = mode;
    try {
      await this._applyMode();
    } catch (err) {
      this._emit('Source switch failed: ' + err.message);
      throw err;
    }
  }

  /** Returns the active element (video or img) for frame capture */
  getActiveElement() {
    return this.mode === 'webcam' ? this.videoEl : this.imgEl;
  }

  /**
   * Returns the actual pixel dimensions of the active source.
   * Works for both HTMLVideoElement and HTMLImageElement.
   */
  getSourceDimensions() {
    if (this.mode === 'webcam') {
      return {
        width: this.videoEl ? (this.videoEl.videoWidth || 640) : 640,
        height: this.videoEl ? (this.videoEl.videoHeight || 480) : 480,
      };
    }
    return {
      width: this.imgEl ? (this.imgEl.naturalWidth || 640) : 640,
      height: this.imgEl ? (this.imgEl.naturalHeight || 480) : 480,
    };
  }

  isReady() {
    if (this.mode === 'webcam') {
      return (
        this.videoEl &&
        this.videoEl.readyState >= 2 &&
        !this.videoEl.paused
      );
    }
    // ESP32: rely on internal flag set by onload (naturalWidth unreliable for MJPEG)
    return this._esp32Connected;
  }

  async _applyMode() {
    if (this.mode === 'webcam') {
      // Hide ESP32 img, show video
      this.imgEl.style.display = 'none';
      this.videoEl.style.display = 'block';
      // Give the browser a moment to fully release the previous stream/connection
      // before requesting a new getUserMedia — fixes ESP32 → webcam switching.
      await new Promise(resolve => setTimeout(resolve, 150));
      await this._startWebcam();
    } else {
      // Ensure webcam is stopped and img is clean before connecting ESP32
      this._stopWebcam();
      this._disconnectEsp32(); // clears src + listeners so browser drops old connection
      this.videoEl.style.display = 'none';
      this.imgEl.style.display = 'block';
      this._startEsp32();
    }
  }

  async _startWebcam() {
    try {
      this._emit('Requesting webcam access…');
      console.log('[VideoSource] Requesting webcam access…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      console.log('[VideoSource] Webcam started');
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

  _startEsp32() {
    if (!this.esp32Url) {
      this._emit('ESP32 URL not set — enter stream URL in Settings');
      console.warn('[VideoSource] ESP32 URL not set');
      return;
    }

    console.log('[VideoSource] ESP32 stream connecting:', this.esp32Url);
    this._emit('ESP32-CAM: Connecting…');
    this._esp32Connected = false; // reset so isReady() returns false until frame arrives

    // Remove old listeners before attaching new ones (avoid duplicates on reconnect)
    this.imgEl.onload = null;
    this.imgEl.onerror = null;

    // First successful frame → connected
    this.imgEl.onload = () => {
      this._esp32Connected = true;
      console.log(
        `[VideoSource] ESP32 stream connected — dimensions: ${this.imgEl.naturalWidth}x${this.imgEl.naturalHeight}`
      );
      this._emit('ESP32-CAM: Connected ✓');
    };

    // Stream error or unreachable host
    this.imgEl.onerror = () => {
      this._esp32Connected = false;
      console.error('[VideoSource] ESP32 stream error — URL:', this.esp32Url);
      this._emit(
        'ESP32-CAM: Connection failed — check IP, port (:81), and stream path (/stream)'
      );
    };

    // IMPORTANT: crossOrigin must be set BEFORE .src so MediaPipe can read pixels
    // without a canvas SecurityError (cross-origin taint). ESP32 CameraWebServer
    // sends Access-Control-Allow-Origin: * on the stream endpoint.
    this.imgEl.crossOrigin = 'anonymous';

    // Force the browser to re-open the MJPEG connection by clearing src first.
    // Without this, switching webcam → ESP32 → webcam → ESP32 may silently
    // reuse a stale/aborted connection and never fire onload.
    this.imgEl.src = '';
    // Defer assignment one microtask so the browser processes the empty src
    setTimeout(() => {
      this.imgEl.src = this.esp32Url;
    }, 0);
  }

  /** Clear the ESP32 image source and remove event listeners. */
  _disconnectEsp32() {
    this._esp32Connected = false;
    if (this.imgEl) {
      this.imgEl.onload = null;
      this.imgEl.onerror = null;
      // Remove crossOrigin BEFORE clearing src so the browser does not
      // treat the blank URL as a cross-origin tainted resource.
      this.imgEl.removeAttribute('crossorigin');
      this.imgEl.src = '';
    }
  }

  destroy() {
    this._stopWebcam();
    this._disconnectEsp32();
    if (this.imgEl) {
      this.imgEl.style.display = 'none';
    }
  }

  _emit(status) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(status);
    }
  }
}
