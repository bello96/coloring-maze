// 托盘的尺寸：底板长的一边总是一样长，四周的边框跟着格子的大小变（和配置页上画的托盘一样，一格的 0.4 倍，屏幕上最窄 14 像素）。
import { describe, expect, it } from 'vitest';
import { LIMITS, sizeOk } from '../src/game/levelset.ts';
import { BORDER_LEAST_PX, FLOOR_SIZE, OUTER, trayDims, type Room } from '../src/view/dims.ts';

/** 关卡允许的每一种大小（行、列） */
function allSizes(): Array<[number, number]> {
  const sizes: Array<[number, number]> = [];
  for (let rows = LIMITS.minSide; rows <= LIMITS.maxLong; rows++) {
    for (let cols = LIMITS.minSide; cols <= LIMITS.maxLong; cols++) {
      if (sizeOk(rows, cols)) sizes.push([rows, cols]);
    }
  }
  return sizes;
}

/** 屏幕上留给托盘的地方：390×844 的手机竖着拿、1920×911 的电脑、一台很小的旧手机 */
const PHONE: Room = { width: 370, height: 677 };
const DESKTOP: Room = { width: 1900, height: 740 };
const TINY: Room = { width: 300, height: 400 };

describe('tray size', () => {
  it('has a border 0.4 cells wide, as the trays on the level-config page do', () => {
    for (const [rows, cols] of allSizes()) {
      const dims = trayDims(rows, cols);
      expect(dims.border, `${rows}×${cols}`).toBeCloseTo(dims.cell * 0.4, 12);
    }
  });

  it('gets a narrow border when the cells are small, and a wide one only when they are big', () => {
    // 第 1 关那样的 5×5：一格 2，边框 0.8
    expect(trayDims(5, 5).border).toBeCloseTo(0.8, 12);
    // 第 71–80 关的 23×17：以前边框有将近三格宽，现在不到半格
    const big = trayDims(17, 23);
    expect(big.border / big.cell).toBeLessThan(0.5);
    // 最大的 25×20
    expect(trayDims(20, 25).border).toBeCloseTo(0.16, 12);
  });

  it('keeps the border at least 14 px wide on the screen, as the level-config page does', () => {
    for (const room of [PHONE, DESKTOP, TINY]) {
      for (const [rows, cols] of allSizes()) {
        const dims = trayDims(rows, cols, room);
        // 托盘放大到正好塞满留出的地方时，一个世界单位有多少像素（实际取景比这小 5% 左右，按小的算）
        const px = Math.min((room.width * 0.95) / dims.outerWidth, (room.height * 0.95) / dims.outerDepth);
        expect(dims.border * px, `${rows}×${cols} 在 ${room.width}×${room.height} 里`).toBeGreaterThanOrEqual(BORDER_LEAST_PX - 1e-9);
        expect(dims.border).toBeGreaterThanOrEqual(dims.cell * 0.4 - 1e-12);
      }
    }
  });

  it('leaves the border at 0.4 cells where that is already wide enough, and widens it only where it is not', () => {
    // 电脑上第 80 关那样的 23×17 横着摆：0.4 格就有十几像素，不用放宽
    const desk = trayDims(17, 23, DESKTOP);
    expect(desk.border).toBeCloseTo(desk.cell * 0.4, 12);
    // 小图在手机上也不用放宽：5×5 一格就有六十来像素
    const small = trayDims(5, 5, PHONE);
    expect(small.border).toBeCloseTo(small.cell * 0.4, 12);
    // 手机上竖着摆的 23×17、25×20：0.4 格只有七八个像素，放宽到 14 像素
    for (const [rows, cols] of [
      [23, 17],
      [25, 20],
    ]) {
      const phone = trayDims(rows, cols, PHONE);
      expect(phone.border, `${rows}×${cols}`).toBeGreaterThan(phone.cell * 0.4);
      const px = Math.min((PHONE.width * 0.95) / phone.outerWidth, (PHONE.height * 0.95) / phone.outerDepth);
      expect(phone.border * px).toBeCloseTo(BORDER_LEAST_PX, 6);
    }
  });

  it('keeps the long side of the floor the same and never grows past the largest tray', () => {
    for (const room of [undefined, PHONE, DESKTOP, TINY]) {
      for (const [rows, cols] of allSizes()) {
        const dims = trayDims(rows, cols, room);
        expect(Math.max(dims.floorWidth, dims.floorDepth), `${rows}×${cols}`).toBeCloseTo(FLOOR_SIZE, 12);
        expect(dims.outerWidth).toBeCloseTo(dims.floorWidth + 2 * dims.border, 12);
        expect(dims.outerDepth).toBeCloseTo(dims.floorDepth + 2 * dims.border, 12);
        // 面板的木纹那张图按 OUTER 那么长铺，托盘不能比它长
        expect(Math.max(dims.outerWidth, dims.outerDepth)).toBeLessThanOrEqual(OUTER);
      }
    }
  });
});
