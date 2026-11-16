import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { applyFraming, frameBox, type FrameRequest } from '../src/view/framing.ts';

/** 用算出来的取景摆好相机，把盒子的 8 个角投到屏幕上，返回它们在屏幕上占的范围（像素，左上角为原点） */
function projectedBounds(req: FrameRequest): { left: number; right: number; top: number; bottom: number } {
  const camera = new PerspectiveCamera(req.fov, req.width / req.height, 0.1, 500);
  applyFraming(camera, frameBox(req), req);
  camera.updateMatrixWorld(true);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const x of [-req.halfWidth, req.halfWidth]) {
    for (const y of [0, req.boxHeight]) {
      for (const z of [-req.halfDepth, req.halfDepth]) {
        const p = new Vector3(x, y, z).project(camera);
        const px = ((p.x + 1) / 2) * req.width;
        const py = ((1 - p.y) / 2) * req.height;
        left = Math.min(left, px);
        right = Math.max(right, px);
        top = Math.min(top, py);
        bottom = Math.max(bottom, py);
      }
    }
  }
  return { left, right, top, bottom };
}

const base = { fov: 30, tilt: 14, halfWidth: 6.25, halfDepth: 6.25, boxHeight: 0.8 };

describe('frameBox', () => {
  const screens: Array<{ name: string; req: FrameRequest }> = [
    { name: 'a wide desktop window', req: { ...base, width: 1440, height: 900, safe: { left: 40, right: 40, top: 110, bottom: 90 } } },
    { name: 'a phone held upright', req: { ...base, width: 402, height: 874, safe: { left: 12, right: 12, top: 150, bottom: 130 } } },
    { name: 'a phone on its side', req: { ...base, width: 874, height: 402, safe: { left: 60, right: 60, top: 70, bottom: 60 } } },
    { name: 'a square window', req: { ...base, width: 800, height: 800, safe: { left: 20, right: 20, top: 100, bottom: 100 } } },
    { name: 'a taller, lower tray', req: { ...base, boxHeight: 0.45, width: 1024, height: 768, safe: { left: 30, right: 30, top: 90, bottom: 80 } } },
  ];

  it.each(screens)('keeps the whole tray inside the free area of $name', ({ req }) => {
    const b = projectedBounds(req);
    expect(b.left).toBeGreaterThanOrEqual(req.safe.left - 0.5);
    expect(b.right).toBeLessThanOrEqual(req.width - req.safe.right + 0.5);
    expect(b.top).toBeGreaterThanOrEqual(req.safe.top - 0.5);
    expect(b.bottom).toBeLessThanOrEqual(req.height - req.safe.bottom + 0.5);
  });

  it.each(screens)('makes the tray as large as that area allows on $name', ({ req }) => {
    const b = projectedBounds(req);
    const slackX = b.left - req.safe.left + (req.width - req.safe.right - b.right);
    const slackY = b.top - req.safe.top + (req.height - req.safe.bottom - b.bottom);
    // 宽和高至少有一个方向是顶满的
    expect(Math.min(slackX, slackY)).toBeLessThan(2);
  });

  it.each(screens)('centres the tray in that area on $name', ({ req }) => {
    const b = projectedBounds(req);
    expect((b.left + b.right) / 2).toBeCloseTo((req.safe.left + req.width - req.safe.right) / 2, 0);
    expect((b.top + b.bottom) / 2).toBeCloseTo((req.safe.top + req.height - req.safe.bottom) / 2, 0);
  });

  it('looks down at the tray from the tilt it was asked for', () => {
    const req = screens[0].req;
    const camera = new PerspectiveCamera(req.fov, req.width / req.height, 0.1, 500);
    applyFraming(camera, frameBox(req), req);
    const dir = camera.getWorldDirection(new Vector3());
    // 与正下方的夹角就是倾角；相机在托盘靠近玩家的一侧（+z），所以视线朝 -z 偏
    expect((Math.acos(-dir.y) * 180) / Math.PI).toBeCloseTo(14, 5);
    expect(dir.z).toBeLessThan(0);
    expect(dir.x).toBeCloseTo(0, 10);
  });
});
