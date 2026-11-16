import type { Level } from '../game/level.ts';

/** 格线交点的坐标：x 是第几条竖线（0 … cols），y 是第几条横线（0 … rows），左上角是 (0, 0) */
export type Point = readonly [x: number, y: number];

export interface FloorOutline {
  /** 地面最外面的一圈 */
  readonly outer: Point[];
  /** 被地面围在中间的墙（"孤岛"），每块一圈 */
  readonly islands: Point[][];
}

/**
 * 沿着地面和墙的交界描出轮廓，托盘的上层木板就按这些轮廓挖空。
 * 只留拐角处的点。要求地面连成一片、没有只在角上相碰的墙（关卡测试保证了这两点）。
 */
export function traceFloor(level: Level): FloorOutline {
  const { rows, cols, floor } = level;
  const isFloor = (r: number, c: number): boolean => r >= 0 && r < rows && c >= 0 && c < cols && floor[r * cols + c] === 1;
  const key = (x: number, y: number): number => y * (cols + 1) + x;

  // 每一小段边界都记成"从哪个交点到哪个交点"，方向是绕着地面顺时针走（地面总在前进方向的右手边）。
  // 没有只在角上相碰的墙，所以每个交点最多是一小段的起点。
  const next = new Map<number, Point>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isFloor(r, c)) continue;
      if (!isFloor(r - 1, c)) next.set(key(c, r), [c + 1, r]);
      if (!isFloor(r, c + 1)) next.set(key(c + 1, r), [c + 1, r + 1]);
      if (!isFloor(r + 1, c)) next.set(key(c + 1, r + 1), [c, r + 1]);
      if (!isFloor(r, c - 1)) next.set(key(c, r + 1), [c, r]);
    }
  }

  const loops: Point[][] = [];
  while (next.size > 0) {
    const [firstKey] = next.keys();
    const start: Point = [firstKey % (cols + 1), Math.floor(firstKey / (cols + 1))];
    const points: Point[] = [];
    let at = start;
    do {
      points.push(at);
      const to = next.get(key(at[0], at[1]))!;
      next.delete(key(at[0], at[1]));
      at = to;
    } while (at[0] !== start[0] || at[1] !== start[1]);
    // 去掉直线中间的点，只留拐角
    const corners = points.filter((p, i) => {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[(i + 1) % points.length];
      return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
    });
    loops.push(corners);
  }

  // 绕地面顺时针走的圈面积为正，是外圈；绕孤岛的那些方向相反，面积为负
  const outers = loops.filter((loop) => signedArea(loop) > 0);
  if (outers.length !== 1) throw new Error('地面没有连成一片，描不出托盘的轮廓');
  return { outer: outers[0], islands: loops.filter((loop) => signedArea(loop) < 0) };
}

function signedArea(loop: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
