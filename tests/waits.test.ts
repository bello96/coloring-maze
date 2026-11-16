import { describe, expect, it } from 'vitest';
import { Waits } from '../src/view/waits.ts';

/** 这个承诺现在是不是已经兑现了（不等它） */
async function isSettled(p: Promise<void>): Promise<boolean> {
  let settled = false;
  void p.then(() => (settled = true));
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

describe('Waits', () => {
  it('keeps waiting until the animation says it is finished', async () => {
    const waits = new Waits();
    let finish = (): void => {};
    const p = waits.wait((f) => (finish = f));
    expect(await isSettled(p)).toBe(false);
    finish();
    expect(await isSettled(p)).toBe(true);
  });

  it('stops waiting when the animation is interrupted before it finished', async () => {
    // 回归：弹珠还在滚就换关时，等这一步演完的一方曾经永远等下去，之后再也操作不了
    const waits = new Waits();
    const p = waits.wait(() => {});
    waits.releaseAll();
    expect(await isSettled(p)).toBe(true);
  });

  it('releases every wait that is still open', async () => {
    const waits = new Waits();
    const a = waits.wait(() => {});
    const b = waits.wait(() => {});
    waits.releaseAll();
    expect(await isSettled(a)).toBe(true);
    expect(await isSettled(b)).toBe(true);
  });

  it('does not touch a wait that begins after the interruption', async () => {
    const waits = new Waits();
    waits.releaseAll();
    const p = waits.wait(() => {});
    expect(await isSettled(p)).toBe(false);
  });

  it('ignores a finish that arrives after the wait was already released', async () => {
    const waits = new Waits();
    let finishFirst = (): void => {};
    const first = waits.wait((f) => (finishFirst = f));
    waits.releaseAll();
    await first;
    const second = waits.wait(() => {});
    // 第一段动画迟到的"演完了"不能把第二段的等待也结束掉
    finishFirst();
    expect(await isSettled(second)).toBe(false);
  });

  it('runs the animation right away, before wait returns', () => {
    const waits = new Waits();
    let began = false;
    void waits.wait(() => (began = true));
    expect(began).toBe(true);
  });
});
