import { describe, expect, it } from 'vitest';
import { rollProfile, settle } from '../src/view/motion.ts';

describe('rollProfile', () => {
  // 加速度 100、最高速度 20：加速 0.2 秒、滚出 2 个单位后达到最高速度
  it('speeds up, then keeps its top speed until the end', () => {
    const p = rollProfile(6, 100, 20);
    expect(p.duration).toBeCloseTo(0.4, 10);
    expect(p.at(0)).toBe(0);
    expect(p.at(0.1)).toBeCloseTo(0.5, 10);
    expect(p.at(0.2)).toBeCloseTo(2, 10);
    expect(p.at(0.3)).toBeCloseTo(4, 10);
    expect(p.at(0.4)).toBeCloseTo(6, 10);
    expect(p.endSpeed).toBeCloseTo(20, 10);
  });

  it('never reaches top speed on a short roll', () => {
    const p = rollProfile(1, 100, 20);
    expect(p.duration).toBeCloseTo(Math.SQRT2 / 10, 10);
    expect(p.at(p.duration)).toBeCloseTo(1, 10);
    expect(p.endSpeed).toBeCloseTo(10 * Math.SQRT2, 10);
  });

  it('stays at the ends outside its time range', () => {
    const p = rollProfile(6, 100, 20);
    expect(p.at(-1)).toBe(0);
    expect(p.at(5)).toBe(6);
  });

  it('tells when the ball has covered a given distance', () => {
    const p = rollProfile(6, 100, 20);
    expect(p.timeAt(0)).toBe(0);
    expect(p.timeAt(0.5)).toBeCloseTo(0.1, 10);
    expect(p.timeAt(2)).toBeCloseTo(0.2, 10);
    expect(p.timeAt(4)).toBeCloseTo(0.3, 10);
    expect(p.timeAt(6)).toBeCloseTo(0.4, 10);
  });

  it('gives times and distances that agree with each other all along the way', () => {
    const p = rollProfile(7.3, 130, 30);
    for (let d = 0; d <= 7.3; d += 0.1) expect(p.at(p.timeAt(d))).toBeCloseTo(d, 9);
  });
});

describe('settle', () => {
  it('starts where the ball touched the wall', () => {
    expect(settle(0, 0.2, 10)).toBeCloseTo(0.2, 10);
  });

  it('first moves away from the wall, as a bounce does', () => {
    expect(settle(0.02, 0.2, 10)).toBeLessThan(0.2);
  });

  it('never goes further into the wall than the point of contact', () => {
    for (let t = 0; t <= 1; t += 0.002) expect(settle(t, 0.2, 10)).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it('bounces back past the resting place before coming to rest', () => {
    let lowest = Infinity;
    for (let t = 0; t <= 1; t += 0.002) lowest = Math.min(lowest, settle(t, 0.2, 10));
    expect(lowest).toBeLessThan(-0.01);
  });

  it('has come to rest within half a second', () => {
    for (let t = 0.5; t <= 1.5; t += 0.01) expect(Math.abs(settle(t, 0.2, 10))).toBeLessThan(0.004);
  });

  it('bounces further back after a faster hit', () => {
    let slow = Infinity;
    let fast = Infinity;
    for (let t = 0; t <= 1; t += 0.002) {
      slow = Math.min(slow, settle(t, 0.2, 5));
      fast = Math.min(fast, settle(t, 0.2, 25));
    }
    expect(fast).toBeLessThan(slow);
  });
});
