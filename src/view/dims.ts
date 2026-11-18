/** 托盘里面那块底板较长的一边有多长（世界单位）。每一关都一样，格子多了就各自变小。 */
export const FLOOR_SIZE = 10;
/** 四周边框的宽度 */
export const BORDER = 1.25;
/** 托盘最长能有多长（正方形的托盘四边都是这么长） */
export const OUTER = FLOOR_SIZE + BORDER * 2;
/** 下层底板的厚度 */
export const BASE_THICKNESS = 0.42;

/** 一个托盘的尺寸：宽是左右方向（x），深是前后方向（z） */
export interface TrayDims {
  /** 一格的边长 */
  readonly cell: number;
  readonly floorWidth: number;
  readonly floorDepth: number;
  readonly outerWidth: number;
  readonly outerDepth: number;
}

/** rows 行、cols 列的迷宫做成托盘有多大：长的一边总是 FLOOR_SIZE，短的一边按格子数缩 */
export function trayDims(rows: number, cols: number): TrayDims {
  const cell = FLOOR_SIZE / Math.max(rows, cols);
  const floorWidth = cols * cell;
  const floorDepth = rows * cell;
  return { cell, floorWidth, floorDepth, outerWidth: floorWidth + BORDER * 2, outerDepth: floorDepth + BORDER * 2 };
}
