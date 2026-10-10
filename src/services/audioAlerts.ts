// Web Audio API based chimes and tones for scalp orderbook events
class AudioAlertService {
  private ctx: AudioContext | null = null;

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new AudioCtx();
      } catch {
        // audio context unavailable
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private beep(freq: number, duration: number, type: OscillatorType = 'sine', volume: number = 0.5) {
    const ctx = this.getContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch {
      // silent catch
    }
  }

  // Bullish opportunity or defended support wall
  playBullishChime(volume = 0.5) {
    this.beep(587.33, 0.08, 'sine', volume); // D5
    setTimeout(() => this.beep(880, 0.12, 'sine', volume), 90); // A5
  }

  // Bearish opportunity or defended resistance wall
  playBearishChime(volume = 0.5) {
    this.beep(880, 0.08, 'sine', volume); // A5
    setTimeout(() => this.beep(554.37, 0.12, 'sine', volume), 90); // C#5
  }

  // Liquidity Sweep alert
  playSweepAlert(volume = 0.4) {
    this.beep(1046.5, 0.06, 'triangle', volume);
    setTimeout(() => this.beep(1318.5, 0.09, 'sine', volume), 70);
  }

  // Iceberg or big wall absorption alert
  playAbsorptionAlert(volume = 0.4) {
    this.beep(740, 0.07, 'sine', volume);
    setTimeout(() => this.beep(987.77, 0.1, 'sine', volume), 80);
  }

  // Target hit triumphant chime
  playTargetHit(volume = 0.5) {
    this.beep(523.25, 0.08, 'sine', volume); // C5
    setTimeout(() => this.beep(659.25, 0.08, 'sine', volume), 80); // E5
    setTimeout(() => this.beep(783.99, 0.14, 'triangle', volume), 160); // G5
  }

  // Stop loss tone
  playStopLoss(volume = 0.45) {
    this.beep(440, 0.1, 'sawtooth', volume); // A4
    setTimeout(() => this.beep(329.63, 0.15, 'sine', volume), 100); // E4
  }

  vibrate(pattern: number[] = [60]) {

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(pattern);
      } catch {
        // unsupported
      }
    }
  }
}

export const audioAlerts = new AudioAlertService();
