/** 托盘里面那块底板较长的一边有多长（世界单位）。每一关都一样，格子多了就各自变小。 */
export const FLOOR_SIZE = 10;
/**
 * 四周边框有多宽：一格边长的 0.4 倍，和配置页上画的托盘一样（见 config/grid.ts）。
 * 格子多了、每一格小了，边框跟着变窄，不会格子已经和弹珠差不多大了，四周还是宽宽的一圈木头。
 */
const BORDER_PER_CELL = 0.4;
/**
 * 边框在屏幕上最窄有多宽（CSS 像素），也和配置页一样。手机上的大图一格只有十几像素，
 * 只按 0.4 格算的话边框只剩六七个像素，几乎看不见
 */
export const BORDER_LEAST_PX = 14;
/** 边框最宽有多宽：原来所有托盘都是这么宽。按每边 5 格的小图算也只到 0.8，这里只是兜底 */
const BORDER_MOST = 1.25;
/** 托盘最长能有多长：底板加上最宽的边框。面板的木纹那张图就按这个长度铺 */
export const OUTER = FLOOR_SIZE + BORDER_MOST * 2;
/** 下层底板的厚度 */
export const BASE_THICKNESS = 0.42;
/**
 * 托盘在屏幕上实际比"正好塞满留出的地方"略小一点：相机是斜着往下看的，近的那一边、墙顶看着比底板大，
 * 取景时是它们碰到边。实测窄的那一边差 5% 左右
 */
const FIT = 0.95;

/** 屏幕上留给托盘的那一块有多大（CSS 像素） */
export interface Room {
  readonly width: number;
  readonly height: number;
}

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

/**
 * 底板这一边长 floor（世界单位）、屏幕上这一边留出 room 像素时，边框至少要多宽（世界单位），在屏幕上才有 BORDER_LEAST_PX。
 * 托盘放大到这一边正好塞满时，一个世界单位是 room / (floor + 2 × 边框) 个像素，边框乘上它不小于 BORDER_LEAST_PX，解出来就是下面这个式子
 */
function leastBorder(floor: number, room: number): number {
  const px = room * FIT - 2 * BORDER_LEAST_PX;
  return px > 0 ? (BORDER_LEAST_PX * floor) / px : BORDER_MOST;
}

/**
 * rows 行、cols 列的迷宫做成托盘有多大：底板长的一边总是 FLOOR_SIZE，短的一边按格子数缩；边框按一格的大小定。
 * @param room 屏幕上留给托盘的那一块；给了的话，边框在屏幕上至少 BORDER_LEAST_PX 宽（托盘塞得满哪一边，按哪一边算）
 */
export function trayDims(rows: number, cols: number, room?: Room): TrayDims {
  const cell = FLOOR_SIZE / Math.max(rows, cols);
  const floorWidth = cols * cell;
  const floorDepth = rows * cell;
  let border = cell * BORDER_PER_CELL;
  if (room) border = Math.max(border, leastBorder(floorWidth, room.width), leastBorder(floorDepth, room.height));
  border = Math.min(BORDER_MOST, border);
  return { cell, border, floorWidth, floorDepth, outerWidth: floorWidth + border * 2, outerDepth: floorDepth + border * 2 };
}
