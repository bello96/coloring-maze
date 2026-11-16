import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sound } from '../src/audio/sound.ts';

/** 假的音频节点：什么都能连、什么都能设，只是不出声 */
function node(): Record<string, unknown> {
  const param = (): Record<string, unknown> => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
  });
  const self: Record<string, unknown> = {
    gain: param(),
    frequency: param(),
    Q: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    connect: (next: unknown) => next,
    start() {},
    stop() {},
  };
  return self;
}

/** 假的 AudioContext，状态由测试来定 */
function fakeAudio(state: string): { resumes: number; created: number } {
  const log = { resumes: 0, created: 0 };
  class FakeAudioContext {
    state = state;
    sampleRate = 8000;
    currentTime = 0;
    destination = node();
    constructor() {
      log.created++;
    }
    resume(): Promise<void> {
      log.resumes++;
      this.state = 'running';
      return Promise.resolve();
    }
    createGain = node;
    createOscillator = node;
    createBiquadFilter = node;
    createDynamicsCompressor = node;
    createBufferSource = node;
    createBuffer(_channels: number, length: number): unknown {
      return { getChannelData: () => new Float32Array(length) };
    }
  }
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  return log;
}

afterEach(() => vi.unstubAllGlobals());

describe('Sound.unlock', () => {
  it('creates the audio output only once', () => {
    const log = fakeAudio('running');
    const sound = new Sound();
    sound.unlock();
    sound.unlock();
    expect(log.created).toBe(1);
  });

  it('leaves audio alone when it is already running', () => {
    const log = fakeAudio('running');
    new Sound().unlock();
    expect(log.resumes).toBe(0);
  });

  it('asks the browser to resume audio that starts out suspended', () => {
    const log = fakeAudio('suspended');
    new Sound().unlock();
    expect(log.resumes).toBe(1);
  });

  it('asks the browser to resume audio that the phone interrupted', () => {
    // iPhone 上来电、锁屏、切到别的应用之后，音频会停在 "interrupted"，不是 "suspended"
    const log = fakeAudio('interrupted');
    new Sound().unlock();
    expect(log.resumes).toBe(1);
  });

  it('does nothing in a browser without Web Audio', () => {
    vi.stubGlobal('window', {});
    expect(() => new Sound().unlock()).not.toThrow();
  });
});
