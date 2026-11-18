// 关卡生成用到的零件：三种造迷宫的办法、迷宫的检查、以及"普通玩法要走几步"的估计。
// 这里的东西只在生成关卡时用（npm run levels），不会打进游戏里。
// 棋盘可以是长方形：rows 行、cols 列。正方形的图上，这里每个函数取随机数的次数和先后都和只支持正方形时一样，
// 所以以前的种子造出来的还是以前那批图。
import { DIRS, STEP, parseLevel, type Dir, type Level } from '../src/game/level.ts';
import { isDone, newGame, roll, slide, steps } from '../src/game/rules.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { shortfall } from '../src/game/solver.ts';

export type Rand = () => number;

const pick = <T>(rand: Rand, list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const int = (rand: Rand, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

/** 把 0/1 网格和起点写成字符画 */
export function toRows(floor: Uint8Array, rows: number, cols: number, start: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let row = '';
    for (let c = 0; c < cols; c++) {
      const cell = r * cols + c;
      row += cell === start ? 'S' : floor[cell] ? '.' : '#';
    }
    out.push(row);
  }
  return out;
}

/**
 * 造法一"开凿"：从一整块木头开始，让小球一步步滚，滚到哪凿到哪。
 * 每一步停下的地方，前面那格记成"必须留着的墙"，这样先前的每一步以后都还成立，
 * 所以凿出来的迷宫一定能通关（照着凿的顺序走就行）。出来的是走廊和小房间的样子。
 */
export function carve(rand: Rand, rows: number, cols: number, moves: number, longRuns: number): { rows: string[]; route: string } | null {
  const floor = new Uint8Array(rows * cols);
  const locked = new Uint8Array(rows * cols);
  const start = int(rand, 0, rows * cols - 1);
  floor[start] = 1;
  let pos = start;
  let last: Dir | null = null;
  let route = '';
  const opposite: Record<Dir, Dir> = { U: 'D', D: 'U', L: 'R', R: 'L' };

  for (let m = 0; m < moves; m++) {
    const options: Array<{ dir: Dir; len: number; fresh: number }> = [];
    for (const dir of DIRS) {
      if (last && dir === opposite[last]) continue;
      const [dr, dc] = STEP[dir];
      let r = Math.floor(pos / cols);
      let c = pos % cols;
      let len = 0;
      let fresh = 0;
      for (;;) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) break;
        const cell = nr * cols + nc;
        if (locked[cell]) break;
        len++;
        if (!floor[cell]) fresh++;
        r = nr;
        c = nc;
        // 能在这里停下的条件：再往前一格是棋盘外，或者还不是地面（可以定成墙）
        const br = r + dr;
        const bc = c + dc;
        const beyondOut = br < 0 || br >= rows || bc < 0 || bc >= cols;
        if (beyondOut || !floor[br * cols + bc]) options.push({ dir, len, fresh });
      }
    }
    const useful = options.filter((o) => o.fresh > 0);
    const pool = useful.length ? useful : options;
    if (pool.length === 0) break;
    // longRuns 越大越偏爱长的直道
    let best = pick(rand, pool);
    for (let i = 0; i < longRuns; i++) {
      const other = pick(rand, pool);
      if (other.len > best.len) best = other;
    }
    const [dr, dc] = STEP[best.dir];
    let r = Math.floor(pos / cols);
    let c = pos % cols;
    for (let i = 0; i < best.len; i++) {
      r += dr;
      c += dc;
      floor[r * cols + c] = 1;
    }
    const br = r + dr;
    const bc = c + dc;
    if (br >= 0 && br < rows && bc >= 0 && bc < cols) locked[br * cols + bc] = 1;
    pos = r * cols + c;
    last = best.dir;
    route += best.dir;
  }
  if (route.length < 2) return null;
  return { rows: toRows(floor, rows, cols, start), route };
}

/** 几种木块的形状（相对坐标） */
const PIECES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0, 0]],
  [[0, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [1, 0]],
  [[0, 0], [0, 1], [0, 2]],
  [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [0, 1], [1, 0]],
  [[0, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1]],
  [[0, 1], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [1, 0], [1, 1]],
];

/**
 * 造法二"摆木块"：一整片空地上随机摆几块木块，再随机挑个起点。
 * 出来的是开阔的样子，但大多数通不了关，要靠求解器筛。
 * @param symmetric 木块是否摆成中心对称的样子
 */
export function blocks(rand: Rand, rows: number, cols: number, pieces: number, symmetric: boolean): string[] | null {
  const total = rows * cols;
  const floor = new Uint8Array(total).fill(1);
  for (let p = 0; p < pieces; p++) {
    const shape = pick(rand, PIECES);
    const r0 = int(rand, 0, rows - 1);
    const c0 = int(rand, 0, cols - 1);
    for (const [dr, dc] of shape) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r >= rows || c >= cols) continue;
      floor[r * cols + c] = 0;
      if (symmetric) floor[(rows - 1 - r) * cols + (cols - 1 - c)] = 0;
    }
  }
  if (hasPinch(floor, rows, cols) || !floorConnected(floor, rows, cols)) return null;
  const floors: number[] = [];
  floor.forEach((v, i) => {
    if (v) floors.push(i);
  });
  if (floors.length < total * 0.5) return null;
  return toRows(floor, rows, cols, pick(rand, floors));
}

/**
 * 造法三"修补"：给 15×15 这样的大图用。图一大，随机摆出来的木块几乎不可能正好通得了关
 * （两千张里也就一两张），所以摆完之后接着改：随便挑一格，墙改成地面或者地面改成墙，
 * 只要离"保证不会困死"没有变得更远（见求解器的 shortfall）就留下，否则改回去；偶尔也换个起点试试。
 * 改到差距为 0 就得到一张一定能通关、也不会困死的图。
 * @param symmetric 是否始终保持中心对称
 * @param patience 最多改多少次，还不行就放弃
 * @param density 地面最少、最多占多大比例：再少就成了走廊，再多就空得没什么可想的
 */
export function mend(
  rand: Rand,
  rows: number,
  cols: number,
  pieces: number,
  symmetric: boolean,
  patience = 4000,
  density: readonly [number, number] = [0.55, 0.85],
): string[] | null {
  const total = rows * cols;
  const floor = new Uint8Array(total).fill(1);
  const mate = (cell: number): number => (symmetric ? total - 1 - cell : cell);
  for (let p = 0; p < pieces; p++) {
    const shape = pick(rand, PIECES);
    const r0 = int(rand, 0, rows - 1);
    const c0 = int(rand, 0, cols - 1);
    for (const [dr, dc] of shape) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r >= rows || c >= cols) continue;
      floor[r * cols + c] = 0;
      floor[mate(r * cols + c)] = 0;
    }
  }
  const shapely = (): Level | null => {
    let floorCount = 0;
    for (const v of floor) floorCount += v;
    if (floorCount < total * density[0] || floorCount > total * density[1]) return null;
    if (hasPinch(floor, rows, cols) || !floorConnected(floor, rows, cols)) return null;
    return { rows, cols, floor, start: 0, floorCount };
  };
  let board = shapely();
  if (!board) return null;
  const floors: number[] = [];
  floor.forEach((v, i) => {
    if (v) floors.push(i);
  });
  let start = pick(rand, floors);
  /** 现在这张图离"保证不会困死"还差多少 */
  let lack = shortfall({ ...board, start });
  for (let i = 0; i < patience && lack > 0; i++) {
    const cell = int(rand, 0, total - 1);
    if (rand() < 0.08) {
      if (!floor[cell] || cell === start) continue;
      const next = shortfall({ ...board, start: cell });
      if (next <= lack) {
        lack = next;
        start = cell;
      }
      continue;
    }
    const other = mate(cell);
    if (cell === start || other === start) continue;
    const was = floor[cell];
    const wasOther = floor[other];
    floor[cell] = floor[other] = was ? 0 : 1;
    const changed = shapely();
    const next = changed ? shortfall({ ...changed, start }) : Infinity;
    if (changed && next <= lack) {
      lack = next;
      board = changed;
    } else {
      floor[cell] = was;
      floor[other] = wasOther;
    }
  }
  return lack === 0 ? toRows(floor, rows, cols, start) : null;
}

/**
 * 估计"不做规划、走一步看一步"的玩法要走几步：每一步都选能新染最多格子的方向；
 * 四个方向都染不到新的，就走最近的路去一个能染到新格子的地方。
 * 走了 limit 步还没完就放弃，返回 limit。
 */
export function greedySteps(level: Level, rand: Rand, limit = 400): number {
  const game = newGame(level);
  while (!isDone(game) && steps(game) < limit) {
    let bestGain = 0;
    let best: Dir[] = [];
    for (const dir of DIRS) {
      const gain = slide(level, game.pos, dir).path.filter((cell) => !game.dyed[cell]).length;
      if (gain > bestGain) {
        bestGain = gain;
        best = [dir];
      } else if (gain === bestGain && gain > 0) {
        best.push(dir);
      }
    }
    if (bestGain > 0) {
      roll(game, pick(rand, best));
      continue;
    }
    // 广度优先，找最近的"下一步能染到新格子"的停靠点，朝它走第一步
    const first = new Map<number, Dir>();
    const queue: number[] = [game.pos];
    const seen = new Set<number>(queue);
    let go: Dir | null = null;
    for (let head = 0; head < queue.length && !go; head++) {
      const at = queue[head];
      const order = [...DIRS].sort(() => rand() - 0.5);
      for (const dir of order) {
        const s = slide(level, at, dir);
        if (s.path.length === 0) continue;
        const firstDir = at === game.pos ? dir : first.get(at)!;
        if (s.path.some((cell) => !game.dyed[cell])) {
          go = firstDir;
          break;
        }
        if (!seen.has(s.to)) {
          seen.add(s.to);
          first.set(s.to, firstDir);
          queue.push(s.to);
        }
      }
    }
    if (!go) return limit;
    roll(game, go);
  }
  return steps(game);
}

/** 读一关并顺手检查形状上的要求 */
export function shapeOk(rows: string[]): Level | null {
  const level = parseLevel(rows);
  if (hasPinch(level.floor, level.rows, level.cols)) return null;
  if (!floorConnected(level.floor, level.rows, level.cols)) return null;
  return level;
}
