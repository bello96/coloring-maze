// 存在浏览器里的进度。一共两样：按关记的成绩（这个文件的前一半），和"玩到第几关"那一个数（后一半）。
//
// 成绩是第二版的存法。第一版按关卡的序号记成绩；关卡能在配置页里改、能换顺序之后，序号就对不上了，所以改成按关卡的固定编号记，
// 并记下通关时那张图的指纹——图后来被改了，就知道当时的最好步数不能再算数。
import { BUILTIN, sigOf, type LevelSet } from './levelset.ts';

export const SAVE_KEY = 'coloring-maze.v2';
/** 第一版存档放在这里。升级时只读不删：万一新版有问题，退回旧代码还能接着用 */
export const OLD_SAVE_KEY = 'coloring-maze.v1';

/** 一关在存档里靠什么认：固定编号，加上它现在这张图的指纹 */
export interface LevelKey {
  readonly id: string;
  readonly sig: string;
}

/** 关卡表里每一关的编号和指纹，顺序和关卡表一样 */
export function keysOf(set: LevelSet): LevelKey[] {
  return set.levels.map((entry) => ({ id: entry.id, sig: sigOf(entry.rows) }));
}

/** 一关通过的记录 */
export interface Done {
  /** 最好成绩（步数） */
  readonly best: number;
  /** 取得这个成绩时那张图的指纹 */
  readonly sig: string;
}

export interface Progress {
  /** 通过了的关，按关卡编号记。只增不减：线上已经删掉的关，它的记录也留着 */
  readonly done: Readonly<Record<string, Done>>;
  /** 是否静音 */
  readonly muted: boolean;
}

export function emptyProgress(): Progress {
  return { done: {}, muted: false };
}

const isBest = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 读第二版的存档。整份读不懂返回 null；个别不合理的记录单独丢掉 */
function readV2(raw: string | null): Progress | null {
  const data = parse(raw);
  if (!data) return null;
  const done = data.done;
  if (typeof done !== 'object' || done === null || Array.isArray(done)) return null;
  const kept: Array<[string, Done]> = [];
  for (const [id, value] of Object.entries(done as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const { best, sig } = value as { best?: unknown; sig?: unknown };
    if (isBest(best) && typeof sig === 'string') kept.push([id, { best, sig }]);
  }
  return { done: Object.fromEntries(kept), muted: data.muted === true };
}

/**
 * 把第一版的存档转过来：那时只有内置的 80 关，第 i 个成绩就是内置第 i 关的，指纹按内置的图算。
 * 那里面的"上次玩到哪一关"不搬：玩到第几关由 reachedFrom 按通过的关算出来。
 */
function readV1(raw: string | null): Progress | null {
  const data = parse(raw);
  if (!data || !Array.isArray(data.best)) return null;
  const builtIn = keysOf(BUILTIN);
  const kept: Array<[string, Done]> = [];
  builtIn.forEach((key, i) => {
    const best: unknown = (data.best as unknown[])[i];
    if (isBest(best)) kept.push([key.id, { best, sig: key.sig }]);
  });
  return { done: Object.fromEntries(kept), muted: data.muted === true };
}

/**
 * 读回存下的进度。
 * @param v2 第二版存档的内容（没有就是 null）。读得懂就用它
 * @param v1 第一版存档的内容。只在没有第二版、或者第二版读不懂时才看
 */
export function loadProgress(v2: string | null, v1: string | null): Progress {
  return readV2(v2) ?? readV1(v1) ?? emptyProgress();
}

export function writeProgress(p: Progress): string {
  return JSON.stringify({ done: p.done, muted: p.muted });
}

/** 这一关通过了没有。图后来被改过也算通过，这样后面的关不会突然锁上 */
export function passed(p: Progress, id: string): boolean {
  return Object.hasOwn(p.done, id);
}

/** 这一关的最好成绩；没通过，或者通过之后图被改过（指纹对不上），返回 0 */
export function bestOf(p: Progress, key: LevelKey): number {
  if (!passed(p, key.id)) return 0;
  const done = p.done[key.id];
  return done.sig === key.sig ? done.best : 0;
}

/** 记下一次通关。同一张图上步数比以前少才更新；图变了就以这一次为准。返回新的进度，不改原来的。 */
export function record(p: Progress, key: LevelKey, steps: number): Progress {
  const before = bestOf(p, key);
  const best = before > 0 ? Math.min(before, steps) : steps;
  return { ...p, done: { ...p.done, [key.id]: { best, sig: key.sig } } };
}

/**
 * 把别处（同一个游戏开着的另一个标签页）存下的进度合进来。
 * 同一关两边都有：是同一张图就取更好的成绩；不是同一张图，取和这一关现在的图对得上的那份，都对不上取自己的。
 * "是否静音"以自己这边为准。返回新的进度，两边都不改。
 * @param keys 现在的关卡表里每一关的编号和指纹
 */
export function mergeProgress(mine: Progress, theirs: Progress, keys: readonly LevelKey[]): Progress {
  const now = new Map(keys.map((key) => [key.id, key.sig]));
  const merged: Array<[string, Done]> = Object.entries(mine.done);
  const own = new Map(merged);
  for (const [id, other] of Object.entries(theirs.done)) {
    const self = own.get(id);
    if (!self) {
      merged.push([id, other]);
      continue;
    }
    let pick = self;
    if (self.sig === other.sig) pick = other.best < self.best ? other : self;
    else if (now.get(id) === other.sig) pick = other;
    if (pick !== self) merged[merged.findIndex(([key]) => key === id)] = [id, pick];
  }
  return { done: Object.fromEntries(merged), muted: mine.muted };
}

// ───── 玩到第几关 ─────
// 哪些关能玩、打开网站进哪一关，只看一个数："玩到第几关"（从 1 数起）。它前面的关都算通过了，它自己是轮到的那一关，
// 后面的还没轮到；通过了最后一关，它就比关数多一。这个数单独存一项，就是光秃秃的一个数字，
// 在浏览器的开发者工具里把它改成 40，再打开就是第 40 关。上面那些按关记的成绩只管选关树上的星星和最好步数，不管解锁。

/** "玩到第几关"存在这里 */
export const LEVEL_KEY = 'coloring-maze.level';

/** 读"玩到第几关"。没存过、读不懂（不是正整数）都是 0，当作没玩过。手改时多打的空格、引号不计较 */
export function readReached(raw: string | null): number {
  const found = /^\s*"?(\d{1,7})"?\s*$/.exec(raw ?? '');
  return found ? Number(found[1]) : 0;
}

/**
 * 还没有这个数的老玩家，按通过的关算一个出来：通过的关里位置最靠后的那一关的下一关
 * （图后来被改过也算通过）。玩过、但这份关卡表里的关一关都没通过，是第 1 关；一关都没通过过是 0，当作没玩过。
 * @param keys 现在的关卡表里每一关的编号和指纹
 */
export function reachedFrom(p: Progress, keys: readonly LevelKey[]): number {
  for (let i = keys.length - 1; i >= 0; i--) if (passed(p, keys[i].id)) return i + 2;
  return Object.keys(p.done).length > 0 ? 1 : 0;
}

/** 玩到第 reached 关的人通过了第 i 关（从 0 数起）之后玩到第几关：通过的是轮到的那一关就往前走一关，重玩前面的不变 */
export function advanced(reached: number, i: number): number {
  return Math.max(reached, i + 2);
}

/** 树上一关的样子：通过了；轮到了（能玩但还没通过）；没轮到 */
export type NodeState = 'done' | 'open' | 'locked';

/**
 * 一共 count 关、玩到第 reached 关（0 是没玩过，和 1 一样）的时候，第 i 关（从 0 数起）是哪一种：
 * 排在它前面的都是通过了的，它自己是轮到的，后面的没轮到。
 */
export function stateOf(reached: number, count: number, i: number): NodeState {
  if (i < 0 || i >= count) return 'locked';
  const turn = Math.max(reached, 1) - 1;
  return i < turn ? 'done' : i === turn ? 'open' : 'locked';
}

/**
 * 打开网站、或者想去的关还没轮到的时候，进哪一关（从 0 数起）：轮到的那一关；全通了就是最后一关。一关都没有时是 -1。
 * 能玩的就是从第 1 关到这一关。
 */
export function landing(reached: number, count: number): number {
  return Math.min(Math.max(reached, 1), count) - 1;
}
