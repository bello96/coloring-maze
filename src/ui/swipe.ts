import type { Dir } from '../game/level.ts';

/** 横竖两个方向里，要有一个比另一个至少多出四分之一，才算分得清 */
const CLEAR_LEAD = 1.25;

/**
 * 手指从按下的地方滑出了 (dx, dy) 像素（向右、向下为正），这算往哪个方向滑？
 * 滑得还不够远，或者几乎是正斜着滑、分不清横竖，都返回 null（等手指再滑一点）。
 */
export function swipeDir(dx: number, dy: number, threshold: number): Dir | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return null;
  if (ax > ay * CLEAR_LEAD) return dx > 0 ? 'R' : 'L';
  if (ay > ax * CLEAR_LEAD) return dy > 0 ? 'D' : 'U';
  return null;
}
