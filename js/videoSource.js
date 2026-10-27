/**
 * VideoSource — abstracts between webcam and ESP32-CAM MJPEG stream.
 * Mode: 'webcam' | 'esp32'
 * Centralized stream link loaded from config.json.
 */

import { loadAppConfig, parseEsp32Config } from './config.js';

export class VideoSource {
  constructor() {
    this.mode = 'esp32';
    this.esp32Url = '/esp32/stream';
    this.stream = null;
    this.videoEl = null;
    this.imgEl = null;
    this.onStatusChange = null; // callback(status: string)
    this._esp32Connected = false; // true once first MJPEG frame arrives

    // Async init from centralized config
    loadAppConfig().then(cfg => {
      if (cfg && (cfg.proxyStreamUrl || cfg.esp32StreamUrl)) {
        this.esp32Url = cfg.proxyStreamUrl || cfg.esp32StreamUrl;
      }
    }).catch(() => {});
  }

  /** Attach to a <video> element (webcam) or <img> element (ESP32) */
  async start(videoEl, imgEl = null) {
    this.videoEl = videoEl;
    this.imgEl = imgEl;
    await this._applyMode();
  }

  setEsp32Url(url) {
    if (!url) return;
    this.esp32Url = url.trim();
  }

  async switchMode(mode) {
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
    return this.mode === 'webcam' ? this.videoEl : (this.imgEl || this.videoEl);
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
        Boolean(this.videoEl) &&
        this.videoEl.readyState >= 2 &&
        !this.videoEl.paused
      );
    }
    // ESP32: rely on internal flag set by onload (naturalWidth can be unreliable for MJPEG)
    return this._esp32Connected;
  }

  async _applyMode() {
    if (this.mode === 'webcam') {
      if (this.imgEl) this.imgEl.style.display = 'none';
      if (this.videoEl) this.videoEl.style.display = 'block';
      await new Promise(resolve => setTimeout(resolve, 150));
      await this._startWebcam();
    } else {
      this._stopWebcam();
      this._disconnectEsp32();
      if (this.videoEl) this.videoEl.style.display = 'none';
      if (this.imgEl) this.imgEl.style.display = 'block';
      this._startEsp32();
    }
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

  _startEsp32() {
    if (!this.imgEl) {
      console.warn('[VideoSource] No <img> element provided for ESP32 stream');
      return;
    }

    const streamUrl = this.esp32Url || '/esp32/stream';
    console.log('[VideoSource] ESP32 stream connecting:', streamUrl);
    this._emit('ESP32-CAM: Connecting…');
    this._esp32Connected = false;

    this.imgEl.onload = null;
    this.imgEl.onerror = null;

    this.imgEl.onload = () => {
      this._esp32Connected = true;
      console.log(
        `[VideoSource] ESP32 stream connected — dimensions: ${this.imgEl.naturalWidth}x${this.imgEl.naturalHeight}`
      );
      this._emit('ESP32-CAM: Connected ✓');
    };

    this.imgEl.onerror = () => {
      this._esp32Connected = false;
      console.error('[VideoSource] ESP32 stream error — URL:', streamUrl);
      this._emit('ESP32-CAM: Connection failed — check camera IP in config.json');
    };

    this.imgEl.crossOrigin = 'anonymous';
    this.imgEl.src = '';
    setTimeout(() => {
      this.imgEl.src = streamUrl;
    }, 0);
  }

  _disconnectEsp32() {
    this._esp32Connected = false;
    if (this.imgEl) {
      this.imgEl.onload = null;
      this.imgEl.onerror = null;
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
