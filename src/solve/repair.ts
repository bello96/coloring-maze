// 修改建议：手画的图不合格时，给出一条"改尽量少的格子就合格"的改法。给配置页用（在后台线程里算），游戏页不引用它。
//
// "合格"是配置页敢说"保证没问题"的标准：地面至少两格、没有只在角上相碰的墙、shortfall 为 0。
// shortfall 为 0 时每一格都滚得到，所以地面一定连成一片；而且一定能通关、怎么走都不会困死（见 src/game/solver.ts）。
//
// 不管图离合格有多远，suggestRepair 都拿得出一条改法。它分三步，前一步成了就不走后一步：
//
// 一、细找（closestRepair）。和关卡生成器的"修补"（tools/gen.ts 的 mend）是同一个思路：拿"离合格还差多少"当尺子，
//    一格一格地改。不同的是这里要改得尽量少，所以不是随机碰，而是一层一层地试：
//
//      一次改动   把某一格的墙和地面互换（起点那格不能改成墙），或者把起点挪到另一格地面上。
//                同一格不改两次，起点最多挪一次。起点挪走以后，原来那格就是一格普通地面，可以再把它改成墙
//                （起点孤零零待在一边的图，最省的改法就是"起点挪到别处，原地改成墙"）。
//      第 1 层    把所有"只改一格"的图都看一遍，有合格的就用它。
//      第 d 层    从上一层看过的图里留下离合格最近的若干张，每张再试所有"只改一格"的；
//                同一张图可能从好几张图改过来，一层里只看一次。
//
//    上一层的图全留得下的时候，这一层就是穷举，找到的一定是改得最少的——格子不超过 81 个（9×9）的图，"改两格"总是这样。
//    图大了、层数深了穷举不起，只留最有希望的那些接着试：找到的不一定是改得最少的。最多试到六层。
//
// 二、快找（descend）。六格以内没有、或者细找来不及：每一步把所有"只改一格"的都试一遍，改成离合格最近的那一种，
//    一直改到合格。一层只留一张图，所以改几十格的大图也只要零点几秒；改的格数和照细找的办法一路搜下去差不多。
//    走到"随便再改哪一格都不会更近"的地方就卡住了（几十张里有一张，多半是只剩一处墙角碰角），这时从卡住的地方再细找一次。
//
// 三、保底（salvage）。前两步都不成、或者时间用完了：小球最后总会落进一个"进得去出不来"的圈子，
//    把起点挪进去、把它滚不到的地面全改成墙，剩下的图小球只在这个圈子里转、每一格都染得到——这样造出来的一定合格。
//    改的格子多，但不用搜，立刻就有。
//
// 最后都要精简一遍（tidy）：把改过的格子一格一格改回去试，还合格就真的改回去，直到哪一格都少不了。
import { parseLevel, type Level } from '../game/level.ts';
import { shortfall, widestTrap } from '../game/solver.ts';

/** 建议里的一处改动 */
export interface Change {
  readonly cell: number;
  /** '#' 改成墙，'.' 改成地面，'S' 把起点挪到这格（原来的起点变成普通地面） */
  readonly to: '#' | '.' | 'S';
}

export interface Repair {
  /** 要改哪几格：挪起点的那一条排在最前，其余按格子编号从小到大；图本来就合格的话是空的 */
  readonly changes: readonly Change[];
  /** 照着改完之后的图 */
  readonly rows: readonly string[];
}

export interface RepairOptions {
  /** 细找最多改几格，默认 6 */
  readonly maxChanges?: number;
  /** 搜索最多花多少毫秒，默认 30000。suggestRepair 到点了就改用不用搜的保底造法，所以它实际用的时间只比这多一点 */
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
/** suggestRepair 的时间里，细找最多占这么大一份；剩下的留给快找 */
const CLOSE_SHARE = 2 / 3;

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
 * 给出一条让图合格的改法，改的格子尽量少。已经合格返回 changes 为空；否则一定给得出一条。
 * 六格以内有改法、又来得及找的话，给的就是细找（closestRepair）的结果；不然是快找或者保底造出来的，改的格子会多一些。
 * rows 读不成一张图（见 parseLevel）时抛错。
 */
export function suggestRepair(rows: readonly string[], options: RepairOptions = {}): Repair {
  const { maxMs = 30_000, now = Date.now } = options;
  const base = parseLevel(rows);
  if (lack(base) === 0) return { changes: [], rows: [...rows] };
  const began = now();
  const late = (): boolean => now() - began > maxMs;

  // 一、细找
  const close = layers(base, { ...options, maxMs: maxMs * CLOSE_SHARE, now });
  if (close) return tidy(base, close);

  // 二、快找。卡住了就从卡住的地方再细找一次
  const board = boardOf(base);
  let left = descend(board, late);
  if (left > 0 && !late()) {
    const more = layers(board, { maxMs: maxMs - (now() - began), now });
    if (more) {
      board.floor.set(more.floor);
      board.start = more.start;
      board.floorCount = more.floorCount;
      left = 0;
    }
  }

  // 三、保底
  if (left > 0) salvage(board, base);
  return tidy(base, board);
}

/**
 * 细找：改最少的格子让图合格。已经合格返回 changes 为空；maxChanges（默认 6）格以内没找到、或者超过了 maxMs，返回 null。
 * rows 读不成一张图（见 parseLevel）时抛错。
 */
export function closestRepair(rows: readonly string[], options: RepairOptions = {}): Repair | null {
  const base = parseLevel(rows);
  if (lack(base) === 0) return { changes: [], rows: [...rows] };
  const found = layers(base, options);
  return found ? tidy(base, found) : null;
}

/** 手头正在改的一张图。和 Level 是同一个样子，只是可以改 */
interface Board {
  readonly rows: number;
  readonly cols: number;
  readonly floor: Uint8Array;
  start: number;
  floorCount: number;
}

function boardOf(level: Level): Board {
  return { rows: level.rows, cols: level.cols, floor: Uint8Array.from(level.floor), start: level.start, floorCount: level.floorCount };
}

/** 把一格的墙和地面互换 */
function flip(board: Board, cell: number): void {
  const was = board.floor[cell];
  board.floor[cell] = was ? 0 : 1;
  board.floorCount += was ? -1 : 1;
}

/** 细找的那一层层搜索（见文件开头）。找到了返回改好的图，没找到、来不及返回 null。base 得是一张不合格的图 */
function layers(base: Level, options: RepairOptions): Board | null {
  const { maxChanges = 6, maxMs = 30_000, now = Date.now } = options;
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
        if (left === 0) return boardOf(changed);
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
 * 快找：每一步把所有"只改一格"的都试一遍（先按格子编号试互换，再按编号试挪起点），改成离合格最近的那一种；
 * 没有哪一种比现在更近、或者到点了，就停。直接改 board，返回停下时还差多少（0 就是合格了）。
 */
function descend(board: Board, late: () => boolean): number {
  const total = board.rows * board.cols;
  let now = lack(board);
  while (now > 0 && !late()) {
    let best = now;
    let bestCell = -1;
    let bestMove = false;
    for (let i = 0; i < total * 2; i++) {
      const cell = i % total;
      const move = i >= total;
      if (cell === board.start || (move && !board.floor[cell])) continue;
      const start = board.start;
      if (move) board.start = cell;
      else flip(board, cell);
      const left = lack(board);
      if (move) board.start = start;
      else flip(board, cell);
      if (left < best) {
        best = left;
        bestCell = cell;
        bestMove = move;
      }
    }
    if (bestCell < 0) break;
    if (bestMove) board.start = bestCell;
    else flip(board, bestCell);
    now = best;
  }
  return now;
}

/**
 * 保底：不用搜，一定造得出一张合格的图。直接改 board。
 *
 * 小球最后总会落进一个"进得去出不来"的圈子。挑染得到最多格子的那一个（widestTrap），把起点挪到它里面的一个停靠点上，
 * 它滚不到的地面全改成墙。这些格子本来就没有哪一步会滚过，改成墙不影响圈子里的任何一步，
 * 所以剩下的图小球还是只在这个圈子里转，而且每一格都染得到——shortfall 是 0。
 * 剩下的要是还有墙角碰角的地方，就把那里的一格地面也改成墙，再照上面的来一遍；每来一遍地面至少少一格，总有做完的时候。
 * 做到只剩起点一格的话，给它开一格相邻的地面：两格并排，滚一步就染完。
 *
 * @param base 原图。只用来在几种一样行的改法里挑离它近的
 */
function salvage(board: Board, base: Level): void {
  const { rows, cols, floor } = board;
  for (;;) {
    const trap = widestTrap(board);
    board.start = trap.stop;
    floor.set(trap.cells);
    board.floorCount = 0;
    for (const on of floor) board.floorCount += on;

    if (board.floorCount < 2) {
      const r = Math.floor(board.start / cols);
      const c = board.start % cols;
      const beside: number[] = [];
      if (c + 1 < cols) beside.push(board.start + 1);
      if (r + 1 < rows) beside.push(board.start + cols);
      if (c > 0) beside.push(board.start - 1);
      if (r > 0) beside.push(board.start - cols);
      // 原来就是地面的那一格优先：少改一格
      flip(board, beside.find((cell) => base.floor[cell]) ?? beside[0]);
      return;
    }

    const corner = pinchedFloor(board, base);
    if (corner < 0) return;
    flip(board, corner);
  }
}

/**
 * 找一处墙角碰角的地方，返回那里该改成墙的一格地面；一处都没有返回 -1。
 * 对角的两格地面里不动起点；都不是起点的话，先挑原图里本来是墙的那一格（改回去等于少改一格）。
 */
function pinchedFloor(board: Board, base: Level): number {
  const { rows, cols, floor } = board;
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const at = r * cols + c;
      const a = floor[at];
      const b = floor[at + 1];
      const d = floor[at + cols];
      const e = floor[at + cols + 1];
      if (a !== e || b !== d || a === b) continue;
      const pair = a ? [at, at + cols + 1] : [at + 1, at + cols];
      const free = pair.filter((cell) => cell !== board.start);
      return free.find((cell) => !base.floor[cell]) ?? free[0];
    }
  }
  return -1;
}

/**
 * 精简，再把改法写出来。board 是一张合格的图，base 是原图。
 * 把和原图不一样的格子一格一格改回去试（起点也试着挪回去，原来那格被改成了墙的话一并改回来），
 * 还合格就真的改回去；一轮下来一格都改不回去才算完。这样留下的每一处改动都少不了。
 */
function tidy(base: Level, board: Board): Repair {
  if (lack(board) !== 0) throw new Error('修改建议改出来的图不合格');
  const total = base.rows * base.cols;
  for (let again = true; again; ) {
    again = false;
    for (let cell = 0; cell < total; cell++) {
      if (board.floor[cell] === base.floor[cell] || cell === board.start) continue;
      flip(board, cell);
      if (lack(board) === 0) again = true;
      else flip(board, cell);
    }
    if (board.start !== base.start) {
      const moved = board.start;
      const walled = !board.floor[base.start];
      if (walled) flip(board, base.start);
      board.start = base.start;
      if (lack(board) === 0) {
        again = true;
      } else {
        board.start = moved;
        if (walled) flip(board, base.start);
      }
    }
  }

  const changes: Change[] = [];
  if (board.start !== base.start) changes.push({ cell: board.start, to: 'S' });
  for (let cell = 0; cell < total; cell++) {
    // 起点现在待的那一格由上面那一条管：挪过去的时候它就成了地面
    if (cell === board.start || board.floor[cell] === base.floor[cell]) continue;
    changes.push({ cell, to: board.floor[cell] ? '.' : '#' });
  }
  return { changes, rows: toRows(board) };
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
