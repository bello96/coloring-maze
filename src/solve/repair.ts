// 修改建议：手画的图不合格时，找出"改最少的格子就合格"的改法。给配置页用（在后台线程里算），游戏页不引用它。
//
// "合格"是配置页敢说"保证没问题"的标准：地面至少两格、没有只在角上相碰的墙、shortfall 为 0。
// shortfall 为 0 时每一格都滚得到，所以地面一定连成一片；而且一定能通关、怎么走都不会困死（见 src/game/solver.ts）。
//
// 做法和关卡生成器的"修补"（tools/gen.ts 的 mend）是同一个思路：拿"离合格还差多少"当尺子，一格一格地改。
// 不同的是这里要改得尽量少，所以不是随机碰，而是一层一层地试：
//
//   一次改动   把某一格的墙和地面互换（起点那格不能改成墙），或者把起点挪到另一格地面上。
//             同一格不改两次，起点最多挪一次。起点挪走以后，原来那格就是一格普通地面，可以再把它改成墙
//             （起点孤零零待在一边的图，最省的改法就是"起点挪到别处，原地改成墙"）。
//   第 1 层    把所有"只改一格"的图都看一遍，有合格的就用它。
//   第 d 层    从上一层看过的图里留下离合格最近的若干张，每张再试所有"只改一格"的；
//             同一张图可能从好几张图改过来，一层里只看一次。
//
// 上一层的图全留得下的时候，这一层就是穷举，找到的一定是改得最少的——格子不超过 81 个（9×9）的图，"改两格"总是这样。
// 图大了、层数深了穷举不起，只留最有希望的那些接着试：找到的不一定是改得最少的，也可能明明有办法却没找到。
// 没找到、来不及都返回 null，由配置页如实告诉用户。
import { parseLevel, type Level } from '../game/level.ts';
import { shortfall } from '../game/solver.ts';

/** 建议里的一处改动 */
export interface Change {
  readonly cell: number;
  /** '#' 改成墙，'.' 改成地面，'S' 把起点挪到这格（原来的起点变成普通地面） */
  readonly to: '#' | '.' | 'S';
}

export interface Repair {
  /** 要改哪几格，按搜索时改的先后；图本来就合格的话是空的 */
  readonly changes: readonly Change[];
  /** 照着改完之后的图 */
  readonly rows: readonly string[];
}

export interface RepairOptions {
  /** 最多改几格，默认 6 */
  readonly maxChanges?: number;
  /** 整个搜索最多花多少毫秒，默认 30000 */
  readonly maxMs?: number;
  /** 现在是什么时刻（毫秒）。默认看系统的钟，测试里换成假的 */
  readonly now?: () => number;
}

/** 每一层评估的图数 × 格子数大约是这么多：图越大每张算得越慢，就少看几张，一层花的时间差不多 */
const LAYER_WORK = 2_400_000;
/** 每一层评估的图数，不管图多大多小都在这两个数之间 */
const LAYER_LEAST = 4000;
const LAYER_MOST = 40_000;
/** 上一层的图至少留这么多张接着试 */
const KEEP_LEAST = 6;
/** 每评估这么多张图看一次钟 */
const CLOCK_EVERY = 64;

/** 搜索时评估过的一张图：在 from 那张图上再改一格得来的（from 是 null 就是在原图上改） */
interface Tried {
  readonly from: Tried | null;
  readonly cell: number;
  readonly to: Change['to'];
  /** 这张图离合格还差多少 */
  readonly lack: number;
}

/** 这张图合不合格：地面至少两格、没有只在角上相碰的墙、shortfall 为 0。rows 读不成一张图（见 parseLevel）时抛错 */
export function sound(rows: readonly string[]): boolean {
  return lack(parseLevel(rows)) === 0;
}

/**
 * 改最少的格子让图合格。已经合格返回 changes 为空；maxChanges（默认 6）格以内没找到、或者超过了 maxMs，返回 null。
 * rows 读不成一张图（见 parseLevel）时抛错。
 */
export function suggestRepair(rows: readonly string[], options: RepairOptions = {}): Repair | null {
  const { maxChanges = 6, maxMs = 30_000, now = Date.now } = options;
  const base = parseLevel(rows);
  if (lack(base) === 0) return { changes: [], rows: [...rows] };

  const total = base.rows * base.cols;
  // 一张图最多有这么多种"只改一格"：每格互换一次，每格地面当一次起点
  const choices = total + base.floorCount;
  const perLayer = Math.min(LAYER_MOST, Math.max(LAYER_LEAST, Math.round(LAYER_WORK / total)));
  const keep = Math.max(KEEP_LEAST, Math.floor(perLayer / choices));
  const began = now();
  let tried = 0;

  // 手头正在试的这张图：先摆成上一层留下的某一张，再一格一格地改了看、看完改回去
  const floor = new Uint8Array(total);
  /** 摆出这张图时已经改过的格子，不再改第二次 */
  const touched = new Uint8Array(total);

  /** 上一层留下来、这一层接着改的图。第 1 层只有原图 */
  let kept: ReadonlyArray<Tried | null> = [null];
  for (let depth = 1; depth <= maxChanges; depth++) {
    const made: Tried[] = [];
    const seen = new Set<string>();
    for (const from of kept) {
      const before = changesOf(from);
      floor.set(base.floor);
      touched.fill(0);
      let start = base.start;
      let moved = false;
      let floorCount = base.floorCount;
      /** 互换过的格子，从小到大 */
      const flipped: number[] = [];
      for (const { cell, to } of before) {
        touched[cell] = 1;
        if (to === 'S') {
          start = cell;
          moved = true;
        } else {
          floor[cell] = to === '.' ? 1 : 0;
          floorCount += to === '.' ? 1 : -1;
          flipped.push(cell);
        }
      }
      flipped.sort((a, b) => a - b);

      // 先按格子编号从小到大试互换，再按编号试挪起点
      for (let i = 0; i < total * 2; i++) {
        const cell = i % total;
        const move = i >= total;
        if (cell === start || touched[cell]) continue;
        if (move && (moved || !floor[cell])) continue;
        if (depth > 1) {
          // 第 1 层的图两两不同；往后同一张图会从不同的图改过来
          const mark = markOf(flipped, move ? -1 : cell, move ? cell : start);
          if (seen.has(mark)) continue;
          seen.add(mark);
        }

        const was = floor[cell];
        const to: Change['to'] = move ? 'S' : was ? '#' : '.';
        if (!move) floor[cell] = was ? 0 : 1;
        const changed: Level = {
          rows: base.rows,
          cols: base.cols,
          floor,
          start: move ? cell : start,
          floorCount: move ? floorCount : floorCount + (was ? -1 : 1),
        };
        const left = lack(changed);
        if (left === 0) return { changes: [...before, { cell, to }], rows: toRows(changed) };
        floor[cell] = was;
        // 最后一层的图不会再往下改，不用记
        if (depth < maxChanges) made.push({ from, cell, to, lack: left });
        if (++tried % CLOCK_EVERY === 0 && now() - began > maxMs) return null;
      }
    }
    // 留下离合格最近的那些。排序是稳定的，差得一样多的保持评估时的先后
    made.sort((a, b) => a.lack - b.lack);
    kept = made.slice(0, keep);
  }
  return null;
}

/**
 * 照着建议改图，返回改完的字符画（传进来的那份不动）。
 * 一条一条按顺序改：'#'、'.' 把那一格改成墙、地面；'S' 把起点挪到那一格，原来的起点变成普通地面。
 */
export function applyChanges(rows: readonly string[], changes: readonly Change[]): string[] {
  const cols = rows[0]?.length ?? 0;
  const cells = rows.join('').split('');
  for (const { cell, to } of changes) {
    if (to === 'S') {
      const old = cells.indexOf('S');
      if (old >= 0) cells[old] = '.';
    }
    cells[cell] = to;
  }
  return rows.map((_, r) => cells.slice(r * cols, (r + 1) * cols).join(''));
}

/**
 * 离合格还差多少，0 就是合格。
 * shortfall 管"有格子滚不到、会困死"；只在角上相碰的地方每处算 3；
 * 只剩起点一格地面的图 shortfall 是 0（没有哪一格染不到），可它一步都不用走、游戏里永远等不到通关，
 * 所以加 1000：永远不算合格，搜索时也永远排在最后。
 */
function lack(level: Level): number {
  return shortfall(level) + 3 * pinches(level.floor, level.rows, level.cols) + (level.floorCount === 1 ? 1000 : 0);
}

/** 只在角上相碰的 2×2 有几处（判断的办法和 src/game/shape.ts 的 hasPinch 一样，这里要的是个数） */
function pinches(floor: Uint8Array, rows: number, cols: number): number {
  let count = 0;
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = floor[r * cols + c];
      const b = floor[r * cols + c + 1];
      const d = floor[(r + 1) * cols + c];
      const e = floor[(r + 1) * cols + c + 1];
      if (a === e && b === d && a !== b) count++;
    }
  }
  return count;
}

/** 从原图到这张图，依次改了哪几格 */
function changesOf(last: Tried | null): Change[] {
  const list: Change[] = [];
  for (let at = last; at; at = at.from) list.push({ cell: at.cell, to: at.to });
  return list.reverse();
}

/**
 * 一张图的记号：互换过的格子从小到大排好，最后是起点在哪。同一张图不管是先改哪格后改哪格得来的，记号都一样。
 * @param flipped 已经互换过的格子，从小到大
 * @param extra 这次要再互换的那一格；这次是挪起点的话传 -1
 */
function markOf(flipped: readonly number[], extra: number, start: number): string {
  let mark = '';
  let waiting = extra;
  for (const cell of flipped) {
    if (waiting >= 0 && waiting < cell) {
      mark += waiting + ',';
      waiting = -1;
    }
    mark += cell + ',';
  }
  if (waiting >= 0) mark += waiting + ',';
  return mark + start;
}

/** 把 0/1 网格和起点写回字符画 */
function toRows(level: Level): string[] {
  const out: string[] = [];
  for (let r = 0; r < level.rows; r++) {
    let row = '';
    for (let c = 0; c < level.cols; c++) {
      const cell = r * level.cols + c;
      row += cell === level.start ? 'S' : level.floor[cell] ? '.' : '#';
    }
    out.push(row);
  }
  return out;
}
