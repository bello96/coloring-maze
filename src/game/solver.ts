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

/**
 * 两种搜法，算出来的最少步数一样，只是快慢不同：
 * - `guided`：有下界指路的搜索，15×15 的大图也算得动（默认）；
 * - `breadth`：一层层全搜的老办法，只适合 10×10 以内的图。留着它一是用来核对上面那种，
 *   二是 1–30 关当初是用它筛出来的，重新生成时还得用它，筛出来的才是同一批。
 */
export type Engine = 'guided' | 'breadth';

/** 从一个停靠点往一个方向滚出去的一步 */
interface Roll {
  readonly from: number;
  readonly to: number;
  readonly dir: Dir;
  /** 这一步滚过的格子 */
  readonly cells: readonly number[];
  /** 这一步能染到哪几个"关键格"，拆成高低两半存（只有 breadth 用，见 breadth 里的说明） */
  lo: number;
  hi: number;
}

/** breadth：关键格的染色情况用两个 26 位的整数表示，合起来最多 52 个，正好能无损地放进一个 JS 数字里当键 */
const HALF_BITS = 26;
const HALF_SIZE = 2 ** HALF_BITS;
const MAX_KEY_CELLS = HALF_BITS * 2;

/** guided：关键格每组最多几个。每组要算一张 2^16 行的表，再多表就太大了。 */
const GROUP_SIZE = 16;

/**
 * 分析一关：能不能通关、最少几步、会不会走进死局。
 *
 * 做法：
 * 1. 小球只会停在少数几个格子上（"停靠点"）。先从起点出发，找出所有到得了的停靠点，
 *    以及从每个停靠点往四个方向各能滚到哪、一路染哪些格子。
 * 2. 很多格子总是"顺带"被染上：只要染了甲，乙一定也染了。这样的乙不用单独记。
 *    剩下必须单独记的叫"关键格"，小图十几二十个，15×15 的大图一百来个。
 * 3. 把"停在哪 + 哪些关键格染了"当成一个局面，从开局往外搜，搜到"关键格全染了"为止。
 *    怎么搜见 Engine。
 *
 * @param maxStates 最多搜多少个局面，超过就抛 SolverLimitError
 * @param groupSize guided 把关键格分组时每组几个（1–16）。一般不用给；换一个数，搜索时用的下界就完全不同，
 *   结果却必须一样，测试和关卡生成工具靠这个来核对大图的答案。
 */
export function analyze(level: Level, maxStates = 4_000_000, engine: Engine = 'guided', groupSize = GROUP_SIZE): Analysis {
  const total = level.rows * level.cols;

  // 1. 停靠点和每一步
  const { stopCells, rolls, rollsFrom } = stopGraph(level);
  const stops = stopCells.length;
  const unsolvable: Analysis = { solvable: false, par: -1, solution: '', safe: false, stops };

  // 每个地面格都得在某一步的路上，否则肯定染不到
  if (unreached(level, rolls) > 0) return unsolvable;

  // 2. 关键格
  const { keySets, keyCells } = keysOf(level, rolls);

  // 3. 搜
  const path = engine === 'breadth' ? breadth(stops, rolls, rollsFrom, keySets, maxStates) : guided(total, stops, rolls, keyCells, maxStates, groupSize);
  if (!path) return unsolvable;

  return {
    solvable: true,
    par: path.length,
    solution: path.map((r) => r.dir).join(''),
    safe: stuckBy(level, stops, rolls, rollsFrom) === 0,
    stops,
  };
}

/**
 * 这一关离"保证不会困死"还差多少：0 就是有保证（这时也一定能通关），数字越大差得越远。
 * 只看停靠点之间怎么连，不用搜索，所以很快。关卡生成器靠它一格一格地把图改好（见 tools/gen.ts 的"修补"）。
 */
export function shortfall(level: Level): number {
  const { stopCells, rolls, rollsFrom } = stopGraph(level);
  return unreached(level, rolls) + stuckBy(level, stopCells.length, rolls, rollsFrom);
}

/**
 * 怎么滚都染不到的地面格（不在任何一步的路上），从小到大。配置页拿它把这些格子圈出来。
 * 一格都没有只说明"每一格都滚得到"，不等于能通关——也可能滚得到却没法在一局里全染上。
 */
export function unreachedCells(level: Level): number[] {
  const { rolls } = stopGraph(level);
  const reach = new Uint8Array(level.rows * level.cols);
  reach[level.start] = 1;
  for (const r of rolls) for (const cell of r.cells) reach[cell] = 1;
  const cells: number[] = [];
  for (let cell = 0; cell < reach.length; cell++) if (level.floor[cell] && !reach[cell]) cells.push(cell);
  return cells;
}

/**
 * 一关整理成一张图：停靠点、每一步，以及每个关键格由哪几步染到。
 * "最少几步"就是在这张图上从起点出发、把每个关键格都至少染到一次的最短走法。
 * 更大的图上的另一种解法（src/solve/tour.ts，整数规划）从这里出发。
 */
export interface StepGraph {
  /** 停靠点的个数；起点是第 0 个 */
  readonly stops: number;
  /** 每一步：从哪个停靠点、往哪个方向滚、停在哪个停靠点 */
  readonly rolls: ReadonlyArray<{ readonly from: number; readonly to: number; readonly dir: Dir }>;
  /** 每个关键格由哪几步染到（步的编号） */
  readonly keys: ReadonlyArray<readonly number[]>;
}

/** 有格子怎么滚都染不到的话返回 null */
export function stepGraph(level: Level): StepGraph | null {
  const { stopCells, rolls } = stopGraph(level);
  if (unreached(level, rolls) > 0) return null;
  const keys = keysOf(level, rolls).keySets.map((set) => {
    const list: number[] = [];
    for (let i = 0; i < rolls.length; i++) if ((set >> BigInt(i)) & 1n) list.push(i);
    return list;
  });
  return { stops: stopCells.length, rolls, keys };
}

/**
 * 关键格：很多格子总是"顺带"被染上，不用单独记，剩下必须单独记的才是关键格。
 * 返回每个关键格由哪几步染到（用一个大整数当集合，第 i 位代表第 i 步），和它是哪一格。
 */
function keysOf(level: Level, rolls: readonly Roll[]): { keySets: bigint[]; keyCells: number[] } {
  const total = level.rows * level.cols;
  // 先给每个格子记下"哪几步会染到它"
  const coveredBy: bigint[] = new Array(total).fill(0n);
  rolls.forEach((r, i) => {
    const bit = 1n << BigInt(i);
    for (const cell of r.cells) coveredBy[cell] |= bit;
  });
  // 染到它的那几步完全相同的格子只留一个当代表
  const distinct = new Map<bigint, number>();
  for (let cell = 0; cell < total; cell++) {
    if (level.floor[cell] && cell !== level.start && !distinct.has(coveredBy[cell])) distinct.set(coveredBy[cell], cell);
  }
  const sets = [...distinct.keys()];
  // 如果能染到乙的每一步也都能染到甲，那么乙染上时甲必然已经染上，甲不用记
  const keySets = sets.filter((a) => !sets.some((b) => b !== a && (a & b) === b));
  return { keySets, keyCells: keySets.map((set) => distinct.get(set)!) };
}

/** 从起点出发到得了的停靠点（起点是第 0 个），以及从每个停靠点往四个方向各滚出去的一步 */
function stopGraph(level: Level): { stopCells: number[]; rolls: Roll[]; rollsFrom: Roll[][] } {
  const stopOf = new Int32Array(level.rows * level.cols).fill(-1);
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
  return { stopCells, rolls, rollsFrom };
}

/** 有多少地面格不在任何一步的路上（怎么滚都染不到） */
function unreached(level: Level, rolls: readonly Roll[]): number {
  const reach = new Uint8Array(level.rows * level.cols);
  reach[level.start] = 1;
  let count = 1;
  for (const r of rolls) {
    for (const cell of r.cells) {
      if (!reach[cell]) {
        reach[cell] = 1;
        count++;
      }
    }
  }
  return level.floorCount - count;
}

// ───────────────────────── breadth：一层层全搜 ─────────────────────────

/** 停靠点编号要和低一半关键格挤在同一个 32 位整数里，只剩 6 位 */
const MAX_STOPS = 64;

/**
 * 广度优先搜索：从开局一层层往外搜，最先搜到"关键格全染了"的那一层就是最少步数。
 * 返回一条最短的走法，走不通返回 null。
 */
function breadth(stops: number, rolls: readonly Roll[], rollsFrom: readonly Roll[][], keySets: readonly bigint[], maxStates: number): Roll[] | null {
  if (keySets.length > MAX_KEY_CELLS) {
    throw new SolverLimitError(`这一关有 ${keySets.length} 个关键格，超过了一层层全搜能处理的 ${MAX_KEY_CELLS} 个`);
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
  if (fullLo === 0 && fullHi === 0) return [];
  if (stops > MAX_STOPS) throw new SolverLimitError(`这一关有 ${stops} 个停靠点，超过了一层层全搜能处理的 ${MAX_STOPS} 个`);

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

type Ints = Int32Array | Uint16Array | Uint8Array;

function grow<T extends Ints>(old: T, size: number): T {
  const next = new (old.constructor as new (n: number) => T)(size);
  next.set(old);
  return next;
}

// ───────────────────────── guided：有下界指路的搜索 ─────────────────────────

/** 代价表里的两个记号：这个局面根本到不了；到得了，但从这里再也染不完这一组 */
const UNSEEN = 255;
const HOPELESS = 254;
/** 所有代价表加起来最多占这么多字节 */
const MAX_TABLE_BYTES = 768 * 1024 * 1024;

/**
 * 一层层全搜的毛病是不知道往哪走才对：最少步数每多几步，要搜的局面就翻好几倍，15×15 的图根本搜不完。
 * 这里换成 A* 搜索：给每个局面估一个"至少还要几步"（下界），先搜"已走步数 + 下界"最小的局面。
 * 下界越准，白搜的局面越少；只要下界从不高估，搜到的就一定是最少步数。
 *
 * 下界怎么来：把关键格分成几组，每组最多 16 个。只管其中一组、别的格子染没染都无所谓，这个小问题
 * 最多只有 2^16 种染色情况，可以把所有情况的答案事先算成一张表（见 costTable）。真正的局面要把每一组
 * 都染完，所以至少要走各组答案里最大的那个那么多步。
 *
 * 分组有讲究：一组里的关键格互相离得越远，把它们全染到就越要满棋盘跑，这一组的答案就越接近整关的
 * 最少步数（见 arrange）。
 */
function guided(total: number, stops: number, rolls: readonly Roll[], keyCells: readonly number[], maxStates: number, groupSize: number): Roll[] | null {
  const keys = keyCells.length;
  if (keys === 0) return [];
  if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > GROUP_SIZE) throw new RangeError(`每组的关键格个数要在 1–${GROUP_SIZE} 之间`);
  if (stops > 0xffff) throw new SolverLimitError(`这一关有 ${stops} 个停靠点，太多了`);

  // 每一步从哪到哪。同一个停靠点出发的几步是挨着的：第 s 个停靠点的是 outStart[s] … outStart[s+1]-1
  const count = rolls.length;
  const rollFrom = new Int32Array(count);
  const rollTo = new Int32Array(count);
  const outStart = new Int32Array(stops + 1);
  rolls.forEach((r, i) => {
    rollFrom[i] = r.from;
    rollTo[i] = r.to;
    outStart[r.from + 1] = i + 1;
  });
  for (let s = 1; s <= stops; s++) if (outStart[s] === 0) outStart[s] = outStart[s - 1];

  // 每个关键格由哪几步染到
  const keyOf = new Int32Array(total).fill(-1);
  keyCells.forEach((cell, k) => (keyOf[cell] = k));
  const rollsOver: number[][] = Array.from({ length: keys }, () => []);
  const keysOf: number[][] = rolls.map((r, i) => {
    const list: number[] = [];
    for (const cell of r.cells) {
      const k = keyOf[cell];
      if (k >= 0) {
        list.push(k);
        rollsOver[k].push(i);
      }
    }
    return list;
  });

  // 分组，并把每组安排到局面里的一段连续的位上：排在第 j 个的关键格在第 ⌊j / groupSize⌋ 组
  const order = arrange(stops, rollFrom, rollTo, outStart, keysOf, rollsOver, groupSize);
  const perWord = Math.floor(32 / groupSize);
  const groupCount = Math.ceil(keys / groupSize);
  const words = Math.ceil(groupCount / perWord);
  const bitOf = new Int32Array(keys);
  order.forEach((k, j) => {
    const g = Math.floor(j / groupSize);
    bitOf[k] = Math.floor(g / perWord) * 32 + (g % perWord) * groupSize + (j % groupSize);
  });
  const covers = new Int32Array(count * words);
  const full = new Int32Array(words);
  keysOf.forEach((list, i) => {
    for (const k of list) covers[i * words + (bitOf[k] >>> 5)] |= 1 << (bitOf[k] & 31);
  });
  for (let k = 0; k < keys; k++) full[bitOf[k] >>> 5] |= 1 << (bitOf[k] & 31);

  // 每一组在局面的第几个整数里、从第几位开始、占哪几位，以及这一组的代价表
  let bytes = 0;
  const wordOf = new Int32Array(groupCount);
  const shiftOf = new Int32Array(groupCount);
  const maskOf = new Int32Array(groupCount);
  const tables: Uint8Array[] = [];
  const cover = new Int32Array(count);
  for (let g = 0; g < groupCount; g++) {
    const size = Math.min(groupSize, keys - g * groupSize);
    wordOf[g] = Math.floor(g / perWord);
    shiftOf[g] = (g % perWord) * groupSize;
    maskOf[g] = 2 ** size - 1;
    bytes += 2 ** size * stops;
    if (bytes > MAX_TABLE_BYTES) throw new SolverLimitError('这一关太大了，下界用的表放不下');
    for (let i = 0; i < count; i++) cover[i] = (covers[i * words + wordOf[g]] >>> shiftOf[g]) & maskOf[g];
    tables.push(costTable(stops, rollFrom, rollTo, outStart, cover, size));
  }
  /** 小球停在 stop、染色情况是 state[off…] 时，至少还要几步：各组的答案里最大的那个 */
  const lowerBound = (stop: number, state: Int32Array, off: number): number => {
    let best = 0;
    for (let g = 0; g < groupCount; g++) {
      const v = tables[g][((state[off + wordOf[g]] >>> shiftOf[g]) & maskOf[g]) * stops + stop];
      if (v > best) best = v;
    }
    return best;
  };

  // 局面按搜到的先后排成一列：染色情况（words 个整数）、停在哪、从哪个局面走哪一步来的、走了几步、展开过没有。
  // 另有一张散列表用来查"这个局面见过没有"。
  let cap = Math.max(1, Math.min(1 << 12, maxStates));
  let dyed = new Int32Array(cap * words);
  let at = new Uint16Array(cap);
  let parent = new Int32Array(cap);
  let via = new Int32Array(cap);
  let walked = new Uint16Array(cap);
  let closed = new Uint8Array(cap);
  let seen = 1;
  let tableSize = 1 << 13;
  let table = new Int32Array(tableSize); // 存"局面编号 + 1"，0 表示空位
  const slotOf = (stop: number, state: Int32Array, off: number): number => {
    let h = Math.imul(stop + 1, 0x9e3779b1);
    for (let w = 0; w < words; w++) {
      h = Math.imul(h ^ state[off + w], 0x85ebca77);
      h ^= h >>> 13;
    }
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return h & (tableSize - 1);
  };
  table[slotOf(0, dyed, 0)] = 1;

  // 待展开的局面按"已走步数 + 下界"分桶，从小到大一桶桶地取。同一桶里后放的先取：
  // 先往深处走，最后一桶（正好等于最少步数的那些）就不用全搜完。
  const open: number[][] = [];
  const push = (f: number, id: number): void => {
    while (open.length <= f) open.push([]);
    open[f].push(id);
  };
  const first = lowerBound(0, dyed, 0);
  if (first >= HOPELESS) return null;
  push(first, 0);
  const next = new Int32Array(words);

  for (let f = first; f < open.length; f++) {
    const bucket = open[f];
    while (bucket.length > 0) {
      const head = bucket.pop()!;
      // 同一个局面后来找到了更短的走法时会再放进桶里一次，轮到旧的那次时它已经展开过了
      if (closed[head]) continue;
      closed[head] = 1;
      const base = head * words;
      let done = true;
      for (let w = 0; w < words; w++) {
        if (dyed[base + w] !== full[w]) {
          done = false;
          break;
        }
      }
      if (done) {
        const out: Roll[] = [];
        for (let s = head; s > 0; s = parent[s]) out.push(rolls[via[s]]);
        return out.reverse();
      }
      const steps = walked[head] + 1;
      const stop = at[head];
      for (let i = outStart[stop]; i < outStart[stop + 1]; i++) {
        const to = rollTo[i];
        for (let w = 0; w < words; w++) next[w] = dyed[base + w] | covers[i * words + w];
        let slot = slotOf(to, next, 0);
        let known = -1;
        for (let id = table[slot]; id !== 0; id = table[slot]) {
          const off = (id - 1) * words;
          if (at[id - 1] === to) {
            let same = true;
            for (let w = 0; w < words; w++) {
              if (dyed[off + w] !== next[w]) {
                same = false;
                break;
              }
            }
            if (same) {
              known = id - 1;
              break;
            }
          }
          slot = (slot + 1) & (tableSize - 1);
        }
        if (known >= 0) {
          if (steps < walked[known]) {
            // 走一步，下界最多少 1（表里的数就是这么来的），所以展开过的局面不可能再找到更短的走法
            if (closed[known]) throw new Error('求解器内部出错：下界前后不一致');
            walked[known] = steps;
            parent[known] = head;
            via[known] = i;
            push(steps + lowerBound(to, next, 0), known);
          }
          continue;
        }
        const bound = lowerBound(to, next, 0);
        if (bound >= HOPELESS) continue;
        if (steps + bound > 0xffff) throw new SolverLimitError('这一关要走的步数太多了');

        if (seen === cap) {
          if (cap >= maxStates) throw new SolverLimitError(`搜了 ${maxStates} 个局面还没有结果`);
          cap = Math.min(cap * 2, maxStates);
          dyed = grow(dyed, cap * words);
          at = grow(at, cap);
          parent = grow(parent, cap);
          via = grow(via, cap);
          walked = grow(walked, cap);
          closed = grow(closed, cap);
        }
        dyed.set(next, seen * words);
        at[seen] = to;
        parent[seen] = head;
        via[seen] = i;
        walked[seen] = steps;
        table[slot] = seen + 1;
        push(steps + bound, seen);
        seen++;

        // 散列表超过六成满就翻倍重排，保证查找一直很快
        if (seen * 5 > tableSize * 3) {
          tableSize *= 2;
          table = new Int32Array(tableSize);
          for (let s = 0; s < seen; s++) {
            let spot = slotOf(at[s], dyed, s * words);
            while (table[spot] !== 0) spot = (spot + 1) & (tableSize - 1);
            table[spot] = s + 1;
          }
        }
      }
    }
  }
  return null;
}

/**
 * 一组关键格的代价表：table[c × stops + s] = 小球停在 s、这一组里已经染上的是 c（一位代表一个关键格）时，
 * 把这一组剩下的全染上最少还要几步。只算从开局到得了的 (c, s)；到不了的是 UNSEEN，再也染不完的是 HOPELESS。
 *
 * 算法：先从开局往前走一遍，记下到得了哪些 (c, s)。再从"全染上了"往回推：染得多的 c 先算。
 * 对一个 c，从 s 滚一步要么新染上这一组的某个关键格（变成更大的 c′，那边已经算好了），
 * 要么什么也没新染上（c 不变，只是换了个停靠点）——后一种在同一个 c 的停靠点之间找最短路。
 *
 * @param cover 每一步能染到这一组里的哪几个关键格
 * @param size 这一组有几个关键格
 */
function costTable(stops: number, rollFrom: Int32Array, rollTo: Int32Array, outStart: Int32Array, cover: Int32Array, size: number): Uint8Array {
  const count = rollFrom.length;
  const all = 2 ** size - 1;
  const table = new Uint8Array(2 ** size * stops).fill(UNSEEN);

  // 往前走一遍：到得了哪些 (c, s)
  const maskSeen = new Uint8Array(all + 1);
  let queue = new Int32Array(1024);
  let tail = 0;
  table[0] = HOPELESS;
  maskSeen[0] = 1;
  queue[tail++] = 0;
  for (let head = 0; head < tail; head++) {
    const x = queue[head];
    const s = x % stops;
    const c = (x - s) / stops;
    for (let i = outStart[s]; i < outStart[s + 1]; i++) {
      const c2 = c | cover[i];
      const y = c2 * stops + rollTo[i];
      if (table[y] !== UNSEEN) continue;
      table[y] = HOPELESS;
      maskSeen[c2] = 1;
      if (tail === queue.length) queue = grow(queue, queue.length * 2);
      queue[tail++] = y;
    }
  }

  // 能染到这一组的那几步，和每个停靠点有哪几步滚进来
  const hits: number[] = [];
  const inStart = new Int32Array(stops + 1);
  for (let i = 0; i < count; i++) {
    if (cover[i] !== 0) hits.push(i);
    inStart[rollTo[i] + 1]++;
  }
  for (let s = 0; s < stops; s++) inStart[s + 1] += inStart[s];
  const inRoll = new Int32Array(count);
  const fill = inStart.slice(0, stops);
  for (let i = 0; i < count; i++) inRoll[fill[rollTo[i]]++] = i;

  // 往回推
  const sorted = new Int32Array(stops);
  const fifo = new Int32Array(stops);
  const settled = new Int32Array(stops).fill(-1);
  for (let c = all; c >= 0; c--) {
    if (!maskSeen[c]) continue;
    const base = c * stops;
    if (c === all) {
      for (let s = 0; s < stops; s++) if (table[base + s] !== UNSEEN) table[base + s] = 0;
      continue;
    }
    // 滚一步就新染上这一组某个关键格的
    for (let j = 0; j < hits.length; j++) {
      const i = hits[j];
      const add = cover[i] & ~c;
      if (add === 0) continue;
      const here = base + rollFrom[i];
      if (table[here] === UNSEEN) continue;
      const after = table[(c | add) * stops + rollTo[i]];
      if (after >= HOPELESS) continue;
      if (after + 1 >= HOPELESS) throw new SolverLimitError('这一关要走的步数太多了');
      if (after + 1 < table[here]) table[here] = after + 1;
    }
    // 已经有答案的停靠点按答案从小到大排好
    let n = 0;
    for (let s = 0; s < stops; s++) {
      const v = table[base + s];
      if (v >= HOPELESS) continue;
      let j = n++;
      while (j > 0 && table[base + sorted[j - 1]] > v) {
        sorted[j] = sorted[j - 1];
        j--;
      }
      sorted[j] = s;
    }
    // 从答案小的往外推：能不新染任何格子就滚到 s 的停靠点，答案至多是 s 的加 1
    let i = 0;
    let head = 0;
    let end = 0;
    while (i < n || head < end) {
      let s: number;
      if (head < end && (i >= n || table[base + fifo[head]] <= table[base + sorted[i]])) s = fifo[head++];
      else s = sorted[i++];
      if (settled[s] === c) continue;
      settled[s] = c;
      const d = table[base + s] + 1;
      if (d >= HOPELESS) throw new SolverLimitError('这一关要走的步数太多了');
      for (let j = inStart[s]; j < inStart[s + 1]; j++) {
        const r = inRoll[j];
        if ((cover[r] & ~c) !== 0) continue;
        const there = base + rollFrom[r];
        if (table[there] === UNSEEN || table[there] <= d) continue;
        table[there] = d;
        fifo[end++] = rollFrom[r];
      }
    }
  }
  return table;
}

/**
 * 给关键格排个队，前 groupSize 个是第一组，以此类推。
 *
 * 每一组都尽量挑互相"隔得远"的：先挑离起点最远的，再反复挑"离已经挑中的那些最近的一个也尽量远"的。
 * 这样的一组要全染到就得满棋盘跑，它的代价表给出的下界最接近真正的最少步数。
 * 两个关键格隔多远：染到甲的那一步之后，最少再走几步能染到乙（一步能同时染到就是 0），两个方向取小的。
 */
function arrange(
  stops: number,
  rollFrom: Int32Array,
  rollTo: Int32Array,
  outStart: Int32Array,
  keysOf: readonly number[][],
  rollsOver: readonly number[][],
  groupSize: number,
): number[] {
  const keys = rollsOver.length;
  const FAR = 0x7fff;

  // 停靠点两两之间最少几步
  const hop = new Int16Array(stops * stops).fill(FAR);
  const queue = new Int32Array(stops);
  for (let a = 0; a < stops; a++) {
    hop[a * stops + a] = 0;
    let tail = 0;
    queue[tail++] = a;
    for (let head = 0; head < tail; head++) {
      const u = queue[head];
      for (let i = outStart[u]; i < outStart[u + 1]; i++) {
        const v = rollTo[i];
        if (hop[a * stops + v] === FAR) {
          hop[a * stops + v] = hop[a * stops + u] + 1;
          queue[tail++] = v;
        }
      }
    }
  }
  // 从每个停靠点出发，最少几步染到每个关键格（算上染到它的那一步）
  const reach = new Int16Array(stops * keys).fill(FAR);
  for (let k = 0; k < keys; k++) {
    for (const i of rollsOver[k]) {
      const from = rollFrom[i];
      for (let s = 0; s < stops; s++) {
        const d = hop[s * stops + from] + 1;
        if (d < reach[s * keys + k]) reach[s * keys + k] = d;
      }
    }
  }
  // 关键格两两隔多远
  const apart = new Int16Array(keys * keys).fill(FAR);
  for (let a = 0; a < keys; a++) {
    for (const i of rollsOver[a]) {
      const to = rollTo[i];
      for (let b = 0; b < keys; b++) {
        const d = reach[to * keys + b];
        if (d < apart[a * keys + b]) apart[a * keys + b] = d;
      }
      for (const b of keysOf[i]) apart[a * keys + b] = 0;
    }
  }
  for (let a = 0; a < keys; a++) {
    for (let b = 0; b < a; b++) {
      const d = Math.min(apart[a * keys + b], apart[b * keys + a]);
      apart[a * keys + b] = apart[b * keys + a] = d;
    }
  }

  const order: number[] = [];
  const taken = new Uint8Array(keys);
  /** 每个还没挑的关键格，离这一组里已经挑中的那些最近的一个有多远 */
  const nearest = new Int32Array(keys);
  while (order.length < keys) {
    let picked = -1;
    for (let k = 0; k < keys; k++) {
      if (!taken[k] && (picked < 0 || reach[k] > reach[picked])) picked = k;
    }
    nearest.fill(FAR);
    for (let n = 0; n < groupSize && picked >= 0; n++) {
      taken[picked] = 1;
      order.push(picked);
      let best = -1;
      let bestScore = -1;
      for (let k = 0; k < keys; k++) {
        if (taken[k]) continue;
        if (apart[k * keys + picked] < nearest[k]) nearest[k] = apart[k * keys + picked];
        // 一样远的时候挑离起点远的
        const score = nearest[k] * 0x8000 + reach[k];
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      picked = best;
    }
  }
  return order;
}

// ───────────────────────── 会不会困死 ─────────────────────────

/**
 * 离"保证不会困死"还差多少，0 就是有保证。
 *
 * 把停靠点按"能互相到达"分成几组。小球不管怎么走，最后总会落进一个"进得去出不来"的组。
 * 如果这样的组只有一个，而且光在这个组里滚就能把所有格子染到（起点开局已染，不算），
 * 那么任何时候都还能通关。这是一个保守的判断：说安全就一定安全，说不安全则不一定真有死局。
 *
 * 差多少 = 多出来的"进得去出不来"的组，每个算 6；加上这样的组里最多的那个还有几格染不到。
 */
function stuckBy(level: Level, stops: number, rolls: readonly Roll[], rollsFrom: readonly Roll[][]): number {
  const group = strongGroups(stops, rollsFrom);
  const leaves = new Set<number>();
  for (const r of rolls) if (group[r.from] !== group[r.to]) leaves.add(group[r.from]);
  const sinks = new Set<number>();
  for (let s = 0; s < stops; s++) if (!leaves.has(group[s])) sinks.add(group[s]);

  let missing = 0;
  const dyed = new Uint8Array(level.rows * level.cols);
  for (const sink of sinks) {
    dyed.fill(0);
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
    missing = Math.max(missing, level.floorCount - count);
  }
  return (sinks.size - 1) * 6 + missing;
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
