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

/**
 * 地面是不是连成一片（上下左右相邻才算连着）。
 *
 * 写法是特意往快里写的：邻格直接用格子编号加减，不查方向表，栈也用定长的数组。
 * 服务端发布关卡时要把最多 200 张图各查一遍，而它每次请求只有 10 毫秒的 CPU 时间，
 * 原来那种写法光这一项就要七八毫秒（见 worker/api.ts 开头的数字）。
 */
export function floorConnected(floor: Uint8Array, rows: number, cols: number): boolean {
  const first = floor.indexOf(1);
  if (first < 0) return false;
  const size = rows * cols;
  const seen = new Uint8Array(size);
  const stack = new Int32Array(size);
  let top = 0;
  stack[top++] = first;
  seen[first] = 1;
  let count = 0;
  while (top > 0) {
    const cell = stack[--top];
    count++;
    const col = cell % cols;
    // 上、下：编号差一整行。左、右：编号差 1，但不能跨到上一行的末尾、下一行的开头去
    const up = cell - cols;
    if (up >= 0 && floor[up] && !seen[up]) {
      seen[up] = 1;
      stack[top++] = up;
    }
    const down = cell + cols;
    if (down < size && floor[down] && !seen[down]) {
      seen[down] = 1;
      stack[top++] = down;
    }
    if (col > 0 && floor[cell - 1] && !seen[cell - 1]) {
      seen[cell - 1] = 1;
      stack[top++] = cell - 1;
    }
    if (col + 1 < cols && floor[cell + 1] && !seen[cell + 1]) {
      seen[cell + 1] = 1;
      stack[top++] = cell + 1;
    }
  }
  let total = 0;
  for (let i = 0; i < size; i++) total += floor[i];
  return count === total;
}

/**
 * 只在角上相碰的那些 2×2 里的格子（去重，从小到大）。查的和 hasPinch 是同一件事，
 * 只是把有问题的格子都列出来，配置页好在画布上圈给人看。
 */
export function pinchCells(floor: Uint8Array, rows: number, cols: number): number[] {
  const marked = new Uint8Array(rows * cols);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const at = r * cols + c;
      const a = floor[at];
      const b = floor[at + 1];
      const d = floor[at + cols];
      const e = floor[at + cols + 1];
      if (a === e && b === d && a !== b) marked[at] = marked[at + 1] = marked[at + cols] = marked[at + cols + 1] = 1;
    }
  }
  const cells: number[] = [];
  for (let cell = 0; cell < marked.length; cell++) if (marked[cell]) cells.push(cell);
  return cells;
}

/**
 * 和 from 那一格不连着的地面格（上下左右相邻才算连着），从小到大。
 * from 一般是起点；它自己不是地面的话，所有地面都算不连着。
 */
export function strayCells(floor: Uint8Array, rows: number, cols: number, from: number): number[] {
  const seen = new Uint8Array(floor.length);
  if (floor[from]) {
    const stack = [from];
    seen[from] = 1;
    while (stack.length) {
      const cell = stack.pop()!;
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
  }
  const cells: number[] = [];
  for (let cell = 0; cell < floor.length; cell++) if (floor[cell] && !seen[cell]) cells.push(cell);
  return cells;
}
