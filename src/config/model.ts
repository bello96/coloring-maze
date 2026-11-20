// 配置页的编辑模型：一关一份草稿，以及画格子、挪起点、改大小、增删关这些改动。
// 全是纯逻辑：给一份旧的，返回一份新的，不改原来的，也不碰页面。
import { DYES, LIMITS, type LevelEntry, type LevelSet } from '../game/levelset.ts';

/** 正在编辑的一关 */
export interface Draft {
  readonly id: string;
  readonly rows: readonly string[];
  readonly dye: string;
  /** 最少步数。图改过、还没重新算出来的时候是 null */
  readonly par: number | null;
  /** 一种最少步数的走法，和 par 同有同无 */
  readonly solution: string | null;
}

/** 关卡表里的每一关各起一份草稿 */
export function draftsOf(set: LevelSet): Draft[] {
  return set.levels.map(({ id, rows, dye, par, solution }) => ({ id, rows, dye, par, solution }));
}

/**
 * 把草稿拼回关卡表。只要有一关还没算出最少步数就拼不成，返回 null。
 * @param openAll "开放全部关卡"那个开关是不是开着。关着的时候关卡表里不带这一项（见 LevelSet）
 */
export function setOf(drafts: readonly Draft[], openAll = false): LevelSet | null {
  const levels: LevelEntry[] = [];
  for (const { id, rows, dye, par, solution } of drafts) {
    if (par === null || solution === null) return null;
    levels.push({ id, rows, dye, par, solution });
  }
  return openAll ? { version: 1, levels, openAll: true } : { version: 1, levels };
}

/**
 * 这一关的图换成 rows。图变了，原来的最少步数就不作数了，等重新算；
 * 但要是改回了和上次发布时一模一样（published），直接用回那时的，不必重算。
 */
export function withRows(draft: Draft, rows: readonly string[], published?: LevelEntry): Draft {
  if (published && rows.join('/') === published.rows.join('/')) {
    return { ...draft, rows, par: published.par, solution: published.solution };
  }
  return { ...draft, rows, par: null, solution: null };
}

/** 新增的一关默认是什么样：7×7 的空地，起点在左上角 */
export function blankRows(): string[] {
  return Array.from({ length: 7 }, (_, r) => (r === 0 ? 'S' : '.') + '.'.repeat(6));
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 一个 6 位的随机编号，和 taken 里的都不重复 */
export function newId(taken: ReadonlySet<string>, rand: () => number = Math.random): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < 6; i++) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length) % ID_CHARS.length];
    if (!taken.has(id)) return id;
  }
}

/** 新增一关用的草稿：一片空地，染料接着最后一关往下轮，编号随机 */
export function newDraft(drafts: readonly Draft[], rand: () => number = Math.random): Draft {
  // 最后一关用的是自选的颜色（不在那八种里）时，indexOf 是 -1，正好从第一种开始
  const last = drafts.length > 0 ? DYES.indexOf(drafts[drafts.length - 1].dye) : -1;
  return {
    id: newId(new Set(drafts.map((draft) => draft.id)), rand),
    rows: blankRows(),
    dye: DYES[(last + 1) % DYES.length],
    par: null,
    solution: null,
  };
}

const setChar = (row: string, col: number, ch: string): string => row.slice(0, col) + ch + row.slice(col + 1);

/** 第 cell 格在哪一行哪一列；不在图里返回 null */
function locate(rows: readonly string[], cell: number): { r: number; c: number } | null {
  const cols = rows[0]?.length ?? 0;
  if (!Number.isInteger(cell) || cell < 0 || cell >= rows.length * cols) return null;
  return { r: Math.floor(cell / cols), c: cell % cols };
}

/**
 * 把一格涂成墙（'#'）或者地面（'.'）。起点那一格涂不动：图里必须始终恰好有一个起点，要换起点用 moveStart。
 * 没有变化时返回的就是传进来的那个数组，调用的地方靠这个知道"没变"。
 */
export function paint(rows: readonly string[], cell: number, to: '#' | '.'): readonly string[] {
  const at = locate(rows, cell);
  if (!at) return rows;
  const was = rows[at.r][at.c];
  if (was === 'S' || was === to) return rows;
  return rows.map((row, r) => (r === at.r ? setChar(row, at.c, to) : row));
}

/** 把起点挪到一格地面上，原来的起点变回普通的地面。点的是墙、是起点自己、或者点在图外面，都不动 */
export function moveStart(rows: readonly string[], cell: number): readonly string[] {
  const at = locate(rows, cell);
  if (!at || rows[at.r][at.c] !== '.') return rows;
  return rows.map((row, r) => {
    const cleared = row.replace('S', '.');
    return r === at.r ? setChar(cleared, at.c, 'S') : cleared;
  });
}

/**
 * 改大小。改大：多出来的格子是地面。改小：裁掉右边和下边；
 * 起点被裁掉了，就放到剩下的第一个地面格上；一格地面都不剩，就把左上角变成起点。
 */
export function resize(rows: readonly string[], toRows: number, toCols: number): string[] {
  const out = Array.from({ length: toRows }, (_, r) => {
    const row = (rows[r] ?? '').slice(0, toCols);
    return row + '.'.repeat(toCols - row.length);
  });
  if (out.some((row) => row.includes('S'))) return out;
  const r = out.findIndex((row) => row.includes('.'));
  if (r < 0) out[0] = setChar(out[0], 0, 'S');
  else out[r] = out[r].replace('.', 'S');
  return out;
}

/** 另一边是 other 格的时候，这一边最多能有几格：长边最多 25，短边最多 20 */
export function maxSide(other: number): number {
  return other > LIMITS.maxShort ? LIMITS.maxShort : LIMITS.maxLong;
}

/** 把第 from 个挪到第 to 个的位置上。返回新的列表；哪个位置不存在就原样返回 */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  out.splice(to, 0, ...out.splice(from, 1));
  return out;
}
