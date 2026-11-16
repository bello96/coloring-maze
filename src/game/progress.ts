/** 存在浏览器里的进度 */
export interface Progress {
  /** 每一关的最好成绩（步数），0 表示还没通过 */
  readonly best: readonly number[];
  /** 上次玩到第几关（从 0 数起），下次打开接着玩 */
  readonly last: number;
  /** 是否静音 */
  readonly muted: boolean;
}

export function emptyProgress(levels: number): Progress {
  return { best: new Array<number>(levels).fill(0), last: 0, muted: false };
}

/** 某一关的最好成绩；没通过或没有这一关返回 0 */
export function bestOf(p: Progress, level: number): number {
  return p.best[level] ?? 0;
}

/** 这一关能不能玩：第一关总能玩，后面的要先通过前一关 */
export function isUnlocked(p: Progress, level: number): boolean {
  if (level < 0 || level >= p.best.length) return false;
  return level === 0 || p.best[level - 1] > 0;
}

/** 记下一次通关。步数比以前少才更新最好成绩。返回新的进度，不改原来的。 */
export function record(p: Progress, level: number, steps: number): Progress {
  if (level < 0 || level >= p.best.length) return p;
  const best = [...p.best];
  best[level] = best[level] > 0 ? Math.min(best[level], steps) : steps;
  return { ...p, best };
}

export function writeProgress(p: Progress): string {
  return JSON.stringify({ best: p.best, last: p.last, muted: p.muted });
}

/** 读回存下的进度。读不懂的内容一律当成没有，个别不合理的数字单独丢掉。 */
export function readProgress(raw: string | null, levels: number): Progress {
  const fresh = emptyProgress(levels);
  if (!raw) return fresh;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fresh;
  const saved = data as { best?: unknown; last?: unknown; muted?: unknown };
  if (!Array.isArray(saved.best)) return fresh;
  const best = fresh.best.map((_, i) => {
    const v: unknown = (saved.best as unknown[])[i];
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
  });
  const p: Progress = { best, last: 0, muted: saved.muted === true };
  const last = saved.last;
  if (typeof last === 'number' && Number.isInteger(last) && isUnlocked(p, last)) return { ...p, last };
  return p;
}

/**
 * 把别处（同一个游戏开着的另一个标签页）存下的进度合进来：每一关取两边里更好的成绩。
 * "上次玩到哪"和"是否静音"以自己这边为准。返回新的进度，两边都不改。
 */
export function mergeProgress(mine: Progress, theirs: Progress): Progress {
  const best = mine.best.map((own, i) => {
    const other = theirs.best[i] ?? 0;
    if (own > 0 && other > 0) return Math.min(own, other);
    return own > 0 ? own : other;
  });
  return { ...mine, best };
}
