import { DIRS, STEP } from './level.ts';

/**
 * 有没有"只在角上相碰"的地方：2×2 的四格里，恰好对角两格是地面、另外两格是墙。
 * 这种地方做成木头会是两块墙只靠一个尖角连着，托盘的轮廓也没法干净地描出来，所以关卡里不允许。
 */
export function hasPinch(floor: Uint8Array, rows: number, cols: number): boolean {
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = floor[r * cols + c];
      const b = floor[r * cols + c + 1];
      const d = floor[(r + 1) * cols + c];
      const e = floor[(r + 1) * cols + c + 1];
      if (a === e && b === d && a !== b) return true;
    }
  }
  return false;
}

/** 地面是不是连成一片（上下左右相邻才算连着） */
export function floorConnected(floor: Uint8Array, rows: number, cols: number): boolean {
  const first = floor.indexOf(1);
  if (first < 0) return false;
  const seen = new Uint8Array(floor.length);
  const stack = [first];
  seen[first] = 1;
  let count = 0;
  while (stack.length) {
    const cell = stack.pop()!;
    count++;
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    for (const dir of DIRS) {
      const nr = r + STEP[dir][0];
      const nc = c + STEP[dir][1];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const next = nr * cols + nc;
      if (floor[next] && !seen[next]) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  let total = 0;
  for (const v of floor) total += v;
  return count === total;
}
