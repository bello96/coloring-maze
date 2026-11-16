// 声音全部现场合成，没有音频文件：玻璃弹珠磕在木头上的"嗒"、落在底板上的"咚"、
// 滚动时的沙沙声、托盘在桌面上滑动的声音，以及通关时的几声铃音。

type Ctx = AudioContext;

export class Sound {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rollGain: GainNode | null = null;
  private rollTone: BiquadFilterNode | null = null;
  private muted = false;

  /**
   * 浏览器要求先有一次点击或按键才能出声。在第一次操作时调用它。
   * 之后被系统挂起（比如切到后台再回来）也靠它恢复。
   */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      // 几个声音叠在一起时（比如刚撞墙又通关）压一压，免得爆音
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -9;
      limiter.knee.value = 6;
      limiter.ratio.value = 10;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.09;
      this.master.connect(limiter).connect(ctx.destination);

      // 一秒钟的白噪声，各种"沙沙""咔"都从它滤出来
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      // 滚动声一直开着，平时音量为零，滚起来才放大
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      this.rollTone = ctx.createBiquadFilter();
      this.rollTone.type = 'bandpass';
      this.rollTone.frequency.value = 400;
      this.rollTone.Q.value = 0.8;
      this.rollGain = ctx.createGain();
      this.rollGain.gain.value = 0;
      source.connect(this.rollTone).connect(this.rollGain).connect(this.master);
      source.start();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.02);
  }

  private get ready(): Ctx | null {
    return this.ctx && this.master && this.ctx.state === 'running' && !this.muted ? this.ctx : null;
  }

  /** 一个很快衰减的正弦音；glideTo 不为 0 时音高同时滑过去 */
  private ping(ctx: Ctx, freq: number, peak: number, decay: number, glideTo = 0, type: OscillatorType = 'sine', at = ctx.currentTime): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (glideTo > 0) osc.frequency.exponentialRampToValueAtTime(glideTo, at + decay);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }

  /** 一小段滤过的噪声 */
  private hiss(ctx: Ctx, kind: BiquadFilterType, freq: number, peak: number, attack: number, decay: number, at = ctx.currentTime): void {
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = kind;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    source.connect(filter).connect(gain).connect(this.master!);
    source.start(at, Math.random() * 0.5);
    source.stop(at + attack + decay + 0.03);
  }

  /** 弹珠撞墙：清脆的一声"嗒"，带一点托盘的闷响 */
  impact(strength: number): void {
    const ctx = this.ready;
    if (!ctx) return;
    const s = Math.max(0.08, Math.min(1, strength));
    const v = Math.pow(s, 1.25);
    const detune = 1 + (Math.random() - 0.5) * 0.07;
    this.ping(ctx, 590 * detune, 0.34 * v, 0.055);
    this.ping(ctx, 1520 * detune, 0.16 * v, 0.03);
    this.ping(ctx, 180, 0.42 * v, 0.085, 92);
    this.hiss(ctx, 'highpass', 2400, 0.3 * v, 0.001, 0.014);
  }

  /** 弹珠落在底板上：比撞墙低沉 */
  land(strength: number): void {
    const ctx = this.ready;
    if (!ctx) return;
    const s = Math.max(0.05, Math.min(1, strength));
    const v = Math.pow(s, 1.1);
    const detune = 1 + (Math.random() - 0.5) * 0.06;
    this.ping(ctx, 410 * detune, 0.3 * v, 0.06);
    this.ping(ctx, 980 * detune, 0.12 * v, 0.03);
    this.ping(ctx, 140, 0.6 * v, 0.12, 68);
    this.hiss(ctx, 'highpass', 1800, 0.2 * v, 0.001, 0.016);
  }

  /** 滚动的沙沙声：speed 是 0–1，0 就是停了 */
  rolling(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.rollGain || !this.rollTone) return;
    const v = Math.max(0, Math.min(1, speed));
    this.rollGain.gain.setTargetAtTime(0.11 * Math.pow(v, 1.3), ctx.currentTime, v > 0 ? 0.03 : 0.012);
    this.rollTone.frequency.setTargetAtTime(280 + 620 * v, ctx.currentTime, 0.04);
  }

  /** 托盘在桌面上滑动 */
  slide(): void {
    const ctx = this.ready;
    if (!ctx) return;
    this.hiss(ctx, 'lowpass', 520, 0.16, 0.22, 0.6);
    this.hiss(ctx, 'bandpass', 1900, 0.03, 0.2, 0.5);
  }

  /** 通关：几声往上走的铃音，星越多响得越多 */
  win(stars: number): void {
    const ctx = this.ready;
    if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5].slice(0, stars + 1);
    notes.forEach((f, i) => {
      const at = ctx.currentTime + 0.08 + i * 0.115;
      this.ping(ctx, f, 0.15, 0.95, 0, 'sine', at);
      this.ping(ctx, f * 2, 0.045, 0.5, 0, 'sine', at);
      this.ping(ctx, f * 3.01, 0.018, 0.25, 0, 'sine', at);
    });
  }

  /** 按下木片按钮 */
  tap(): void {
    const ctx = this.ready;
    if (!ctx) return;
    this.ping(ctx, 760, 0.1, 0.03);
    this.ping(ctx, 210, 0.14, 0.05, 130);
  }
}
