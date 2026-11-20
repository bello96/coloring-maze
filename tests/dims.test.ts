// 托盘的尺寸：底板长的一边总是一样长，四周的边框跟着格子的大小变（和配置页上画的托盘一样，一格的 0.4 倍）。
import { describe, expect, it } from 'vitest';
import { LIMITS, sizeOk } from '../src/game/levelset.ts';
import { FLOOR_SIZE, OUTER, trayDims } from '../src/view/dims.ts';

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

  it('keeps the long side of the floor the same and never grows past the largest tray', () => {
    for (const [rows, cols] of allSizes()) {
      const dims = trayDims(rows, cols);
      expect(Math.max(dims.floorWidth, dims.floorDepth), `${rows}×${cols}`).toBeCloseTo(FLOOR_SIZE, 12);
      expect(dims.outerWidth).toBeCloseTo(dims.floorWidth + 2 * dims.border, 12);
      expect(dims.outerDepth).toBeCloseTo(dims.floorDepth + 2 * dims.border, 12);
      // 面板的木纹那张图按 OUTER 那么长铺，托盘不能比它长
      expect(Math.max(dims.outerWidth, dims.outerDepth)).toBeLessThanOrEqual(OUTER);
    }
  });
});
