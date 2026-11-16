import { DIRS, type Level } from '../../src/game/level.ts';
import { slide } from '../../src/game/rules.ts';

export interface BruteResult {
  /** 最少步数；通不了关是 -1 */
  readonly par: number;
  /** 有没有"走到这一步就再也通不了关"的局面 */
  readonly canGetStuck: boolean;
  /** 一共搜到多少个局面 */
  readonly states: number;
}

/** 超过了给定的局面数上限 */
export class BruteLimitError extends Error {}

const HALF = 26;
const HALF_SIZE = 2 ** HALF;

/**
 * 最笨也最不会错的办法：把"小球在哪 + 每一格染没染"当成一个局面，从开局起一层层全部走一遍。
 * 只给测试用，拿它的结果去核对正式的求解器。迷宫最多 52 格（染色情况拆成两个 26 位的整数）。
 */
export function bruteForce(level: Level, maxStates = 400_000): BruteResult {
  const total = level.rows * level.cols;
  if (total > HALF * 2) throw new Error('bruteForce 只用于 52 格以内的迷宫');
  let allLo = 0;
  let allHi = 0;
  for (let i = 0; i < total; i++) {
    if (!level.floor[i]) continue;
    if (i < HALF) allLo |= 1 << i;
    else allHi |= 1 << (i - HALF);
  }

  const index: Array<Map<number, number>> = Array.from({ length: total }, () => new Map<number, number>());
  const posOf: number[] = [];
  const loOf: number[] = [];
  const hiOf: number[] = [];
  const depth: number[] = [];
  const next: number[][] = [];

  const add = (pos: number, lo: number, hi: number, d: number): number => {
    const k = hi * HALF_SIZE + lo;
    const seen = index[pos].get(k);
    if (seen !== undefined) return seen;
    const id = posOf.length;
    if (id >= maxStates) throw new BruteLimitError('bruteForce 搜到的局面太多了，换个更小的迷宫');
    index[pos].set(k, id);
    posOf.push(pos);
    loOf.push(lo);
    hiOf.push(hi);
    depth.push(d);
    next.push([]);
    return id;
  };

  const s = level.start;
  add(s, s < HALF ? 1 << s : 0, s < HALF ? 0 : 1 << (s - HALF), 0);
  let par = -1;
  for (let head = 0; head < posOf.length; head++) {
    const pos = posOf[head];
    if (loOf[head] === allLo && hiOf[head] === allHi && par < 0) par = depth[head];
    for (const dir of DIRS) {
      const move = slide(level, pos, dir);
      if (move.to === pos) continue;
      let lo = loOf[head];
      let hi = hiOf[head];
      for (const cell of move.path) {
        if (cell < HALF) lo |= 1 << cell;
        else hi |= 1 << (cell - HALF);
      }
      next[head].push(add(move.to, lo, hi, depth[head] + 1));
    }
  }

  // 从"已经通关"的局面倒着往回找：凡是找不到的，都是通不了关的死局
  const canFinish = new Uint8Array(posOf.length);
  const prev: number[][] = posOf.map(() => []);
  next.forEach((list, from) => list.forEach((to) => prev[to].push(from)));
  const queue: number[] = [];
  for (let i = 0; i < posOf.length; i++) {
    if (loOf[i] === allLo && hiOf[i] === allHi) {
      canFinish[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const p of prev[queue[head]]) {
      if (!canFinish[p]) {
        canFinish[p] = 1;
        queue.push(p);
      }
    }
  }
  const canGetStuck = canFinish.includes(0);
  return { par, canGetStuck, states: posOf.length };
}
