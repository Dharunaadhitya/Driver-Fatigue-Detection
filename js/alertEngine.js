/**
 * AlertEngine — manages alert levels, sounds (Web Audio API), and history.
 * Levels: 'normal' | 'warning' | 'danger' | 'microsleep'
 */
export class AlertEngine {
  constructor() {
    this.audioCtx = null;
    this.currentLevel = 'normal';
    this.history = this._loadHistory();
    this.onLevelChange = null; // callback(level, message)
    this.isMuted = false;

    // Cooldown tracking to prevent spam
    this.lastAlertTime = { warning: 0, danger: 0, microsleep: 0 };
    this.COOLDOWN_MS = { warning: 5000, danger: 3000, microsleep: 1000 };

    // Continuous alarm oscillator
    this._alarmNode = null;
    this._alarmInterval = null;
  }

  /** Evaluate fatigue state and fire alerts as needed */
  evaluate(state) {
    let newLevel = 'normal';
    let message = '';

    if (!state.detected) {
      newLevel = 'normal';
    } else if (state.microsleep) {
      newLevel = 'microsleep';
      message = '🚨 MICROSLEEP DETECTED — Wake up!';
    } else if (state.perclos > 0.7 || (state.eyesClosedFrames > 30)) {
      newLevel = 'danger';
      message = '🚨 High drowsiness — PERCLOS critical!';
    } else if (state.perclos > 0.4 || state.yawning || state.headNodAlert) {
      newLevel = 'warning';
      message = state.yawning
        ? '⚠️ Yawning detected — take a break soon'
        : state.headNodAlert
        ? '⚠️ Head nodding detected'
        : '⚠️ Drowsiness increasing — stay alert';
    }

    // Level transition
    if (newLevel !== this.currentLevel) {
      this._onLevelTransition(newLevel, message);
    }

    // For microsleep: keep alarm playing
    if (newLevel === 'microsleep' && this.currentLevel === 'microsleep') {
      this._ensureAlarmPlaying();
    }

    return newLevel;
  }

  _onLevelTransition(newLevel, message) {
    const prev = this.currentLevel;
    this.currentLevel = newLevel;

    // Stop any continuous alarm if dropping below microsleep
    if (newLevel !== 'microsleep') {
      this._stopContinuousAlarm();
    }

    if (newLevel === 'normal') {
      if (typeof this.onLevelChange === 'function') {
        this.onLevelChange('normal', '');
      }
      return;
    }

    const now = Date.now();
    if (now - this.lastAlertTime[newLevel] < this.COOLDOWN_MS[newLevel]) return;
    this.lastAlertTime[newLevel] = now;

    // Log to history
    const entry = { time: now, level: newLevel, message };
    this.history.unshift(entry);
    if (this.history.length > 100) this.history = this.history.slice(0, 100);
    this._saveHistory();

    // Play sound
    if (!this.isMuted) this._playAlert(newLevel);

    // Callback
    if (typeof this.onLevelChange === 'function') {
      this.onLevelChange(newLevel, message);
    }
  }

  _playAlert(level) {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    if (level === 'microsleep') {
      this._startContinuousAlarm();
    } else if (level === 'danger') {
      this._playTone(880, 0.8, 0.5, 'square');
      setTimeout(() => this._playTone(660, 0.8, 0.5, 'square'), 600);
    } else if (level === 'warning') {
      this._playTone(520, 0.4, 0.3, 'sine');
    }
  }

  _playTone(frequency, gain, duration, type = 'sine') {
    const ctx = this.audioCtx;
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    gainNode.gain.setValueAtTime(gain, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  }

  _startContinuousAlarm() {
    if (this._alarmInterval) return; // already playing
    const play = () => {
      if (this.isMuted || this.currentLevel !== 'microsleep') {
        this._stopContinuousAlarm();
        return;
      }
      this._playTone(1000, 1.0, 0.3, 'sawtooth');
      setTimeout(() => this._playTone(800, 1.0, 0.3, 'sawtooth'), 400);
    };
    play();
    this._alarmInterval = setInterval(play, 900);
  }

  _stopContinuousAlarm() {
    if (this._alarmInterval) {
      clearInterval(this._alarmInterval);
      this._alarmInterval = null;
    }
  }

  _ensureAlarmPlaying() {
    if (!this._alarmInterval && !this.isMuted) {
      this._startContinuousAlarm();
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isMuted) this._stopContinuousAlarm();
    return this.isMuted;
  }

  getHistory() {
    return this.history;
  }

  clearHistory() {
    this.history = [];
    this._saveHistory();
  }

  _loadHistory() {
    try {
      return JSON.parse(localStorage.getItem('fatigue_alert_history') || '[]');
    } catch {
      return [];
    }
  }

  _saveHistory() {
    try {
      localStorage.setItem('fatigue_alert_history', JSON.stringify(this.history));
    } catch (_) {}
  }

  destroy() {
    this._stopContinuousAlarm();
    if (this.audioCtx) this.audioCtx.close();
  }
}
