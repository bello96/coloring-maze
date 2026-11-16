import { DIRS, type Dir, type Level } from './level.ts';
import { slide } from './rules.ts';

/** 对一关的分析结果 */
export interface Analysis {
  /** 能不能把所有地面都染上 */
  readonly solvable: boolean;
  /** 最少要走几步；通不了关是 -1 */
  readonly par: number;
  /** 一种步数最少的走法，例如 "DRULUL"；通不了关是空串 */
  readonly solution: string;
  /** 是否保证不会把自己困死（无论怎么走，剩下的格子都还染得到） */
  readonly safe: boolean;
  /** 小球能停下来的格子有多少个 */
  readonly stops: number;
}

/** 搜索量超过上限时抛出：这一关太复杂，没法在限定的工作量内算出最少步数 */
export class SolverLimitError extends Error {}

/** 从一个停靠点往一个方向滚出去的一步 */
interface Roll {
  readonly from: number;
  readonly to: number;
  readonly dir: Dir;
  /** 这一步滚过的格子 */
  readonly cells: readonly number[];
  /** 这一步能染到哪几个"关键格"，拆成高低两半存（见 analyze 里的说明） */
  lo: number;
  hi: number;
}

/** 关键格的染色情况用两个 26 位的整数表示，合起来最多 52 个，正好能无损地放进一个 JS 数字里当键 */
const HALF_BITS = 26;
const HALF_SIZE = 2 ** HALF_BITS;
const MAX_KEY_CELLS = HALF_BITS * 2;

/**
 * 分析一关：能不能通关、最少几步、会不会走进死局。
 *
 * 做法：
 * 1. 小球只会停在少数几个格子上（"停靠点"）。先从起点出发，找出所有到得了的停靠点，
 *    以及从每个停靠点往四个方向各能滚到哪、一路染哪些格子。
 * 2. 很多格子总是"顺带"被染上：只要染了甲，乙一定也染了。这样的乙不用单独记。
 *    剩下必须单独记的叫"关键格"，通常只有十几二十个。
 * 3. 把"停在哪 + 哪些关键格染了"当成一个局面，从开局一层层往外搜，
 *    最先搜到"关键格全染了"的那一层就是最少步数。
 *
 * @param maxStates 最多搜多少个局面，超过就抛 SolverLimitError
 */
export function analyze(level: Level, maxStates = 4_000_000): Analysis {
  const total = level.rows * level.cols;

  // 1. 停靠点和每一步
  const stopOf = new Int32Array(total).fill(-1);
  const stopCells: number[] = [level.start];
  stopOf[level.start] = 0;
  const rolls: Roll[] = [];
  const rollsFrom: Roll[][] = [];
  for (let s = 0; s < stopCells.length; s++) {
    const list: Roll[] = [];
    for (const dir of DIRS) {
      const { to, path } = slide(level, stopCells[s], dir);
      if (path.length === 0) continue;
      if (stopOf[to] < 0) {
        stopOf[to] = stopCells.length;
        stopCells.push(to);
      }
      const r: Roll = { from: s, to: stopOf[to], dir, cells: path, lo: 0, hi: 0 };
      list.push(r);
      rolls.push(r);
    }
    rollsFrom.push(list);
  }
  const stops = stopCells.length;
  const unsolvable: Analysis = { solvable: false, par: -1, solution: '', safe: false, stops };

  // 每个地面格都得在某一步的路上，否则肯定染不到
  const reach = new Uint8Array(total);
  reach[level.start] = 1;
  let reachCount = 1;
  for (const r of rolls) {
    for (const cell of r.cells) {
      if (!reach[cell]) {
        reach[cell] = 1;
        reachCount++;
      }
    }
  }
  if (reachCount !== level.floorCount) return unsolvable;

  // 2. 关键格。先给每个格子记下"哪几步会染到它"，用一个大整数当集合。
  const coveredBy: bigint[] = new Array(total).fill(0n);
  rolls.forEach((r, i) => {
    const bit = 1n << BigInt(i);
    for (const cell of r.cells) coveredBy[cell] |= bit;
  });
  const distinct = new Set<bigint>();
  for (let cell = 0; cell < total; cell++) {
    if (level.floor[cell] && cell !== level.start) distinct.add(coveredBy[cell]);
  }
  const sets = [...distinct];
  // 如果能染到乙的每一步也都能染到甲，那么乙染上时甲必然已经染上，甲不用记
  const keySets = sets.filter((a) => !sets.some((b) => b !== a && (a & b) === b));
  if (keySets.length > MAX_KEY_CELLS) {
    throw new SolverLimitError(`这一关有 ${keySets.length} 个关键格，超过了求解器能处理的 ${MAX_KEY_CELLS} 个`);
  }
  keySets.forEach((set, k) => {
    rolls.forEach((r, i) => {
      if ((set >> BigInt(i)) & 1n) {
        if (k < HALF_BITS) r.lo |= 1 << k;
        else r.hi |= 1 << (k - HALF_BITS);
      }
    });
  });
  const k = keySets.length;
  const fullLo = k >= HALF_BITS ? HALF_SIZE - 1 : 2 ** k - 1;
  const fullHi = k > HALF_BITS ? 2 ** (k - HALF_BITS) - 1 : 0;

  // 3. 一层层搜
  const path = search(stops, rollsFrom, fullLo, fullHi, maxStates);
  if (!path) return unsolvable;

  return {
    solvable: true,
    par: path.length,
    solution: path.map((r) => r.dir).join(''),
    safe: neverStuck(level, stops, rolls, rollsFrom),
    stops,
  };
}

/** 广度优先搜索；返回一条最短的走法，走不通返回 null */
function search(
  stops: number,
  rollsFrom: readonly Roll[][],
  fullLo: number,
  fullHi: number,
  maxStates: number,
): Roll[] | null {
  if (fullLo === 0 && fullHi === 0) return [];
  if (stops > MAX_STOPS) throw new SolverLimitError(`这一关有 ${stops} 个停靠点，超过了求解器能处理的 ${MAX_STOPS} 个`);

  // 每个局面占两个 32 位整数：a = 低一半关键格 + 停靠点 × 2^26，b = 高一半关键格。
  // 局面按搜到的先后排成一列（这一列同时就是广度优先的队列），另有一张散列表用来查"这个局面见过没有"。
  let cap = 1 << 12;
  let stateA = new Int32Array(cap);
  let stateB = new Int32Array(cap);
  let parent = new Int32Array(cap);
  let via = new Uint8Array(cap);
  let count = 1;
  let tableSize = 1 << 13;
  let table = new Int32Array(tableSize); // 存"局面编号 + 1"，0 表示空位
  const slotOf = (a: number, b: number): number => {
    let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return h & (tableSize - 1);
  };
  table[slotOf(0, 0)] = 1;

  for (let head = 0; head < count; head++) {
    const a = stateA[head];
    const hi = stateB[head];
    const lo = a & (HALF_SIZE - 1);
    const list = rollsFrom[a >>> HALF_BITS];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const nextLo = lo | r.lo;
      const nextHi = hi | r.hi;
      const nextA = nextLo | (r.to << HALF_BITS);
      let slot = slotOf(nextA, nextHi);
      let known = false;
      for (let id = table[slot]; id !== 0; id = table[slot]) {
        if (stateA[id - 1] === nextA && stateB[id - 1] === nextHi) {
          known = true;
          break;
        }
        slot = (slot + 1) & (tableSize - 1);
      }
      if (known) continue;

      if (count === cap) {
        if (cap >= maxStates) throw new SolverLimitError(`搜了 ${maxStates} 个局面还没有结果`);
        cap = Math.min(cap * 2, maxStates);
        stateA = grow(stateA, cap);
        stateB = grow(stateB, cap);
        parent = grow(parent, cap);
        via = grow(via, cap);
      }
      stateA[count] = nextA;
      stateB[count] = nextHi;
      parent[count] = head;
      via[count] = i;
      table[slot] = ++count;

      if (nextLo === fullLo && nextHi === fullHi) {
        const out: Roll[] = [];
        for (let s = count - 1; s > 0; s = parent[s]) out.push(rollsFrom[stateA[parent[s]] >>> HALF_BITS][via[s]]);
        return out.reverse();
      }

      // 散列表超过六成满就翻倍重排，保证查找一直很快
      if (count * 5 > tableSize * 3) {
        tableSize *= 2;
        table = new Int32Array(tableSize);
        for (let s = 0; s < count; s++) {
          let at = slotOf(stateA[s], stateB[s]);
          while (table[at] !== 0) at = (at + 1) & (tableSize - 1);
          table[at] = s + 1;
        }
      }
    }
  }
  return null;
}

/** 停靠点编号要和低一半关键格挤在同一个 32 位整数里，只剩 6 位 */
const MAX_STOPS = 64;

function grow<T extends Int32Array | Uint8Array>(old: T, size: number): T {
  const next = new (old.constructor as new (n: number) => T)(size);
  next.set(old);
  return next;
}

/**
 * 是否保证不会困死。
 *
 * 把停靠点按"能互相到达"分成几组。小球不管怎么走，最后总会落进一个"进得去出不来"的组。
 * 如果这样的组只有一个，而且光在这个组里滚就能把所有格子染到（起点开局已染，不算），
 * 那么任何时候都还能通关。这是一个保守的判断：说安全就一定安全，说不安全则不一定真有死局。
 */
function neverStuck(level: Level, stops: number, rolls: readonly Roll[], rollsFrom: readonly Roll[][]): boolean {
  const group = strongGroups(stops, rollsFrom);
  const leaves = new Set<number>();
  for (const r of rolls) if (group[r.from] !== group[r.to]) leaves.add(group[r.from]);
  const sinks = new Set<number>();
  for (let s = 0; s < stops; s++) if (!leaves.has(group[s])) sinks.add(group[s]);
  if (sinks.size !== 1) return false;
  const [sink] = sinks;

  const dyed = new Uint8Array(level.rows * level.cols);
  dyed[level.start] = 1;
  let count = 1;
  for (const r of rolls) {
    if (group[r.from] !== sink) continue;
    for (const cell of r.cells) {
      if (!dyed[cell]) {
        dyed[cell] = 1;
        count++;
      }
    }
  }
  return count === level.floorCount;
}

/** 给每个停靠点标上它所在的组号：同一组里的停靠点互相都到得了（Tarjan 强连通分量） */
function strongGroups(stops: number, rollsFrom: readonly Roll[][]): Int32Array {
  const index = new Int32Array(stops).fill(-1);
  const low = new Int32Array(stops);
  const group = new Int32Array(stops).fill(-1);
  const stack: number[] = [];
  const onStack = new Uint8Array(stops);
  let counter = 0;
  let groups = 0;

  const visit = (v: number): void => {
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = 1;
    for (const r of rollsFrom[v]) {
      const w = r.to;
      if (index[w] < 0) {
        visit(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], index[w]);
      }
    }
    if (low[v] === index[v]) {
      for (;;) {
        const w = stack.pop()!;
        onStack[w] = 0;
        group[w] = groups;
        if (w === v) break;
      }
      groups++;
    }
  };
  for (let v = 0; v < stops; v++) if (index[v] < 0) visit(v);
  return group;
}
