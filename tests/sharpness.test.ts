import { describe, expect, it } from 'vitest';
import { coarser, Governor, isModestGpu, sharpnessFor } from '../src/view/sharpness.ts';

/** 连着报告 count 帧，每帧都花 ms 毫秒；返回这期间倍数变了几次 */
function run(governor: Governor, count: number, ms: number): number {
  let changes = 0;
  for (let i = 0; i < count; i++) if (governor.frame(ms / 1000)) changes++;
  return changes;
}

/** 集成显卡一类的机器，一帧最多画三百万个点 */
const MODEST = 3_000_000;
/** 独立显卡、苹果芯片：六百万 */
const STRONG = 6_000_000;

describe('sharpnessFor', () => {
  it('never draws more than two dots per screen pixel, however fine the screen', () => {
    // iPhone：402×874，屏幕是 3 倍的
    expect(sharpnessFor(402, 874, 3, MODEST)).toBe(2);
    expect(sharpnessFor(402, 874, 3, STRONG)).toBe(2);
  });

  it('never draws more dots than the screen has', () => {
    // 1920×1080 的普通显示器：预算够画 1.2 倍，但屏幕本身只有 1 倍
    expect(sharpnessFor(1920, 1080, 1, MODEST)).toBe(1);
  });

  it('draws fewer dots on a big fine screen when the graphics chip is modest', () => {
    // 1440×900 的 2 倍屏：全画是 518 万个点，超出预算，降到约 1.52 倍（正好 300 万）
    const ratio = sharpnessFor(1440, 900, 2, MODEST);
    expect(ratio).toBeCloseTo(1.5215, 3);
    expect(1440 * 900 * ratio * ratio).toBeCloseTo(MODEST, -2);
  });

  it('draws the same screen in full when the graphics chip is strong', () => {
    expect(sharpnessFor(1440, 900, 2, STRONG)).toBe(2);
  });

  it('does not go blurrier than three quarters, even on a huge screen', () => {
    expect(sharpnessFor(3840, 2160, 1, MODEST)).toBe(0.75);
  });
});

describe('coarser', () => {
  it('takes a fifth off', () => {
    expect(coarser(2)).toBeCloseTo(1.6, 10);
    expect(coarser(1.5)).toBeCloseTo(1.2, 10);
  });

  it('stops at three quarters', () => {
    expect(coarser(0.9)).toBe(0.75);
    expect(coarser(0.75)).toBe(0.75);
  });
});

describe('isModestGpu', () => {
  it.each([
    ['ANGLE (Intel, Intel(R) Graphics (0x00007DD5) Direct3D11 vs_5_0 ps_5_0, D3D11)', true],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', true],
    ['Mali-G52 MC2', true],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', true],
    ['', true],
    ['Apple GPU', false],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', false],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', false],
    ['ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', false],
    ['Adreno (TM) 740', false],
  ])('%s → %s', (name, modest) => {
    expect(isModestGpu(name)).toBe(modest);
  });
});

// 下面每次都报告 100 帧：足够它先跳过刚开始（或刚改完大小）的那一小段、再看满一轮，正好做出一次判断
describe('Governor', () => {
  it('leaves the picture alone while frames arrive on time', () => {
    const g = new Governor(2);
    expect(run(g, 400, 16.7)).toBe(0);
    expect(g.ratio).toBe(2);
  });

  it('shrugs off the odd slow frame', () => {
    const g = new Governor(2);
    for (let i = 0; i < 400; i++) g.frame(i % 10 === 0 ? 0.06 : 0.0167);
    expect(g.ratio).toBe(2);
  });

  it('draws coarser when most frames are late', () => {
    const g = new Governor(2);
    expect(run(g, 100, 30)).toBe(1);
    expect(g.ratio).toBeCloseTo(1.6, 10);
  });

  it('does not judge by the first moments after starting', () => {
    // 刚打开时要上传贴图、编译着色器，头几十帧慢是正常的，不代表这台机器带不动
    const g = new Governor(2);
    run(g, 40, 60);
    expect(run(g, 400, 16.7)).toBe(0);
    expect(g.ratio).toBe(2);
  });

  it('keeps going coarser while that keeps helping, and stops once frames are on time', () => {
    const g = new Governor(2);
    run(g, 100, 30); // 太慢 → 1.6
    run(g, 100, 23); // 快了一些但还是慢 → 1.28
    expect(g.ratio).toBeCloseTo(1.28, 10);
    run(g, 300, 16.7); // 跟上了
    expect(g.ratio).toBeCloseTo(1.28, 10);
  });

  it('does not take the hiccup of resizing the picture as proof that coarser did not help', () => {
    // 改画面大小的那一刻本身会卡几帧；紧接着的这几帧不能算进"改完之后有没有变快"里
    const g = new Governor(2);
    run(g, 100, 30); // → 1.6
    run(g, 10, 120); // 刚改完大小，卡了几帧
    run(g, 300, 16.7); // 之后一直很顺
    expect(g.ratio).toBeCloseTo(1.6, 10);
  });

  it('goes back and gives up when drawing coarser did not make frames any faster', () => {
    // 比如手机开了省电模式，浏览器把画面限制在每秒 30 帧：画得再粗也还是 33 毫秒一帧，白白变糊
    const g = new Governor(2);
    run(g, 100, 33.3);
    expect(g.ratio).toBeCloseTo(1.6, 10);
    expect(run(g, 100, 33.3)).toBe(1);
    expect(g.ratio).toBe(2);
    expect(run(g, 400, 33.3)).toBe(0);
    expect(g.ratio).toBe(2);
  });

  it('never goes below three quarters', () => {
    const g = new Governor(1);
    // 每降一档都快 20%，但始终不够快
    let ms = 80;
    for (let i = 0; i < 20; i++) {
      run(g, 100, ms);
      ms = Math.max(30, ms * 0.8);
    }
    expect(g.ratio).toBe(0.75);
  });

  it('does not let one long stall count as many slow frames', () => {
    // 切到别的标签页再回来，那一帧"花了"好几秒，不该因此变糊
    const g = new Governor(2);
    run(g, 60, 16.7);
    g.frame(5);
    run(g, 100, 16.7);
    expect(g.ratio).toBe(2);
  });
});
