/** 托盘里面那块底板较长的一边有多长（世界单位）。每一关都一样，格子多了就各自变小。 */
export const FLOOR_SIZE = 10;
/**
 * 四周边框有多宽：一格边长的 0.4 倍，和配置页上画的托盘一样（见 config/grid.ts）。
 * 格子多了、每一格小了，边框跟着变窄，不会格子已经和弹珠差不多大了，四周还是宽宽的一圈木头。
 */
const BORDER_PER_CELL = 0.4;
/** 边框最窄、最宽有多宽。按每边 5–25 格的图，实际是 0.16（25 格）到 0.8（5 格），这两头只是兜底 */
const BORDER_LEAST = 0.15;
const BORDER_MOST = 1.25;
/** 托盘最长能有多长：底板加上最宽的边框。面板的木纹那张图就按这个长度铺 */
export const OUTER = FLOOR_SIZE + BORDER_MOST * 2;
/** 下层底板的厚度 */
export const BASE_THICKNESS = 0.42;

/** 一个托盘的尺寸：宽是左右方向（x），深是前后方向（z） */
export interface TrayDims {
  /** 一格的边长 */
  readonly cell: number;
  /** 四周边框的宽度 */
  readonly border: number;
  readonly floorWidth: number;
  readonly floorDepth: number;
  readonly outerWidth: number;
  readonly outerDepth: number;
}

/** rows 行、cols 列的迷宫做成托盘有多大：底板长的一边总是 FLOOR_SIZE，短的一边按格子数缩；边框按一格的大小定 */
export function trayDims(rows: number, cols: number): TrayDims {
  const cell = FLOOR_SIZE / Math.max(rows, cols);
  const border = Math.min(BORDER_MOST, Math.max(BORDER_LEAST, cell * BORDER_PER_CELL));
  const floorWidth = cols * cell;
  const floorDepth = rows * cell;
  return { cell, border, floorWidth, floorDepth, outerWidth: floorWidth + border * 2, outerDepth: floorDepth + border * 2 };
}
