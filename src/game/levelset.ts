// 关卡表：游戏里的全部关卡，按顺序排好。内置的 80 关是一份关卡表，配置页发布到线上的也是一份关卡表。
// 这里的校验是游戏、配置页、服务端三处共用的同一个函数，所以只有纯逻辑，不碰页面，也不抛异常。
import { STEP, type Dir, type Level, type LevelDef } from './level.ts';
import { LEVELS } from './levels.ts';
import { floorConnected, hasPinch } from './shape.ts';

/** 关卡表里的一关：字符画、最少步数、一种走法，再加上固定的编号和染料颜色 */
export interface LevelEntry extends LevelDef {
  /** 这一关的固定编号：改图、换顺序都不变，存档按它记。2–12 位的小写字母或数字 */
  readonly id: string;
  /** 染料颜色，写成 #rrggbb */
  readonly dye: string;
}

export interface LevelSet {
  readonly version: 1;
  readonly levels: readonly LevelEntry[];
  /**
   * 开放全部关卡：开着的时候每一关都能直接进，不用先通过前一关。配置页上的那个开关存的就是它。
   * 关着的时候没有这一项（不写成 false）：这样没开过这个开关的关卡表，存下来的和加这个开关之前一模一样。
   */
  readonly openAll?: true;
}

/**
 * 尺寸上的规定。最大 25×20：比内置关卡里最大的一张（23×17）再大一圈。这个上限不是哪里写死了做不到，
 * 而是图越大有三样东西一起变差，2026-11-20 都实测过——
 *   手机上的格子变小：竖屏 390×844 的手机上，23×17 一格约 15.5 像素，25×20 约 13.5 像素（360×740 上是 14.2 和 12.4）；
 *   配置页算最少步数变慢：数字在 config/checker.ts 的 SOLVE_LIMIT_MS 那里；
 *   发布时服务端校验变慢：数字在 worker/api.ts 开头。
 * 最小 5 是因为长边不到 5 格时墙会高出取景范围（见 view/stage.ts 的 TALLEST）。
 */
export const LIMITS = { maxLevels: 200, minSide: 5, maxLong: 25, maxShort: 20 } as const;

/** 尺寸不合规定时说的那句话 */
const SIZE_RULE = `行、列都要在 ${LIMITS.minSide}–${LIMITS.maxLong} 之间，长边最多 ${LIMITS.maxLong}，短边最多 ${LIMITS.maxShort}`;

/** 八种现成的染料：靛蓝、茜红、松绿、藤黄、紫、叶绿、玫红、湖蓝。内置的关卡按顺序轮着用 */
export const DYES: readonly string[] = ['#2646b8', '#c0302b', '#0e8a78', '#dd8e10', '#6f3bb5', '#3f8f2e', '#cf3f77', '#1787c2'];

/** 把 "#2646b8" 这样的颜色变成数字 0x2646b8（画面那边要的是数字） */
export function dyeNumber(css: string): number {
  return parseInt(css.slice(1), 16);
}

/** rows 行、cols 列的图合不合尺寸上的规定：行、列各 5–25，长边最多 25，短边最多 20 */
export function sizeOk(rows: number, cols: number): boolean {
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return false;
  const long = Math.max(rows, cols);
  const short = Math.min(rows, cols);
  return short >= LIMITS.minSide && long <= LIMITS.maxLong && short <= LIMITS.maxShort;
}

/**
 * 一张图的指纹，八位十六进制。存档里记着通关时那张图的指纹：
 * 以后图被改了，指纹对不上，就知道当时的最好步数不能再算数。
 */
export function sigOf(rows: readonly string[]): string {
  let hash = 2166136261;
  const text = rows.join('/');
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type Checked =
  | { readonly ok: true; readonly set: LevelSet }
  /** level：出问题的是第几关（从 0 数起）；不是某一关的问题时是 -1 */
  | { readonly ok: false; readonly level: number; readonly detail: string };

const ROWS_SHAPE = '地图要是一行行等长的字符画';

/** 检查一关。合格就返回整理好的这一关（只留认识的字段），不合格返回一句原因 */
function entryOf(value: unknown, taken: ReadonlySet<string>): LevelEntry | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '这一关的格式不对';
  const { id, rows, dye, par, solution } = value as Record<string, unknown>;

  if (typeof id !== 'string' || !/^[a-z0-9]{2,12}$/.test(id)) return '编号要是 2–12 位的小写字母或数字';
  if (taken.has(id)) return '编号和前面的关重复了';

  if (!Array.isArray(rows) || rows.length === 0) return ROWS_SHAPE;
  const first: unknown = rows[0];
  if (typeof first !== 'string' || first.length === 0) return ROWS_SHAPE;
  for (const row of rows) if (typeof row !== 'string' || row.length !== first.length) return ROWS_SHAPE;
  const map = rows as readonly string[];
  if (!sizeOk(map.length, first.length)) return SIZE_RULE;
  // 边查字符边把图读出来（和 level.ts 的 parseLevel 读出来的一样，只是不用再扫第二遍：这里的每一毫秒都要省，见 follow 的说明）
  const cols = first.length;
  const floor = new Uint8Array(map.length * cols);
  let start = -1;
  let starts = 0;
  let floorCount = 0;
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    for (let c = 0; c < cols; c++) {
      const ch = row.charCodeAt(c);
      if (ch === 35) continue; // #
      if (ch === 83) {
        // S
        starts++;
        start = r * cols + c;
      } else if (ch !== 46) {
        return '地图里只能有 # . S 三种字符'; // 不是 .
      }
      floor[r * cols + c] = 1;
      floorCount++;
    }
  }
  if (starts !== 1) return '起点要恰好一个';
  const level: Level = { rows: map.length, cols, floor, start, floorCount };
  if (!floorConnected(level.floor, level.rows, level.cols)) return '地面要连成一片';
  if (hasPinch(level.floor, level.rows, level.cols)) return '墙不能只在角上相碰';

  if (typeof dye !== 'string' || !/^#[0-9a-f]{6}$/i.test(dye)) return '染料颜色要写成 #rrggbb';

  // 只有起点一格地面的图不用走就"染完"了，可游戏是走完一步才判通关的，这样的图永远过不了关，所以至少要走一步
  if (typeof par !== 'number' || !Number.isInteger(par) || par < 1) return '最少步数要是不小于 1 的整数';
  if (typeof solution !== 'string' || solution.length !== par || !/^[URDL]*$/.test(solution)) {
    return '走法只能由 U、R、D、L 组成，步数要和最少步数一样';
  }
  // 照着走一遍：每一步都滚得动、走完正好染完。这同时就证明了这一关能通关
  const wrong = follow(level, solution);
  if (wrong) return wrong;

  return { id, rows: [...map], dye: dye.toLowerCase(), par, solution };
}

/**
 * 照着走法走一遍。每一步都滚得动、走完正好染完返回 null，否则返回一句原因。
 *
 * 滚动的规矩和 rules.ts 里的一样（滚到下一格是墙或者棋盘外面为止），但这里单独写了一份、不用那边的 newGame 和 roll：
 * 那边每走一步都要记下滚过哪些格子（画面要照着演），这里只要结果。服务端发布时要把最多 200 关各走一遍，
 * 而它每次请求只有 10 毫秒的 CPU 时间，省下的这一两毫秒是实打实的。两份有没有走样，测试里拿几千条走法逐一对过。
 */
function follow(level: Level, solution: string): string | null {
  const { rows, cols, floor } = level;
  const dyed = new Uint8Array(rows * cols);
  dyed[level.start] = 1;
  let left = level.floorCount - 1;
  let r = Math.floor(level.start / cols);
  let c = level.start % cols;
  for (let i = 0; i < solution.length; i++) {
    const [dr, dc] = STEP[solution[i] as Dir];
    let moved = false;
    for (;;) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) break;
      const next = nr * cols + nc;
      if (!floor[next]) break;
      r = nr;
      c = nc;
      moved = true;
      if (!dyed[next]) {
        dyed[next] = 1;
        left--;
      }
    }
    if (!moved) return `照着走法走，第 ${i + 1} 步滚不动`;
  }
  return left === 0 ? null : '照着走法走完，还有格子没染上';
}

/**
 * 关卡表的基本校验：格式、尺寸、形状，以及"照着给出的走法确实能通关"。
 * "给出的步数是不是最少"这里不查（太贵，要整数规划来算，配置页在发布前算好）。
 * 通过时返回整理过的关卡表：只留认识的字段，染料统一成小写；"开放全部关卡"关着的时候不带那一项。
 */
export function checkLevelSet(data: unknown): Checked {
  const whole = (detail: string): Checked => ({ ok: false, level: -1, detail });
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return whole('关卡表的格式不对');
  const { version, levels, openAll } = data as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(levels)) return whole('关卡表的格式不对');
  // 没有这一项就是关着；有的话只能是 true 或 false
  if (openAll !== undefined && typeof openAll !== 'boolean') return whole('「开放全部关卡」只能是开或者关');
  if (levels.length < 1 || levels.length > LIMITS.maxLevels) return whole(`关卡数要在 1–${LIMITS.maxLevels} 之间`);

  const taken = new Set<string>();
  const out: LevelEntry[] = [];
  for (let i = 0; i < levels.length; i++) {
    const entry = entryOf(levels[i], taken);
    if (typeof entry === 'string') return { ok: false, level: i, detail: entry };
    taken.add(entry.id);
    out.push(entry);
  }
  return { ok: true, set: openAll === true ? { version: 1, levels: out, openAll: true } : { version: 1, levels: out } };
}

function builtIn(): LevelSet {
  return {
    version: 1,
    levels: LEVELS.map((def, i) => ({
      id: `b${String(i + 1).padStart(2, '0')}`,
      rows: def.rows,
      dye: DYES[i % DYES.length],
      par: def.par,
      solution: def.solution,
    })),
  };
}

/**
 * 内置的 80 关包成的关卡表：编号 b01–b80，染料按老规矩轮着取。
 * 线上还没发布过关卡、或者拿不到线上那份时，游戏和配置页用的就是它。
 */
export const BUILTIN: LevelSet = /* @__PURE__ */ builtIn();
