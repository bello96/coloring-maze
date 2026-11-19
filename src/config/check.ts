// 配置页对一张图做的检查。按顺序四步，前面的没过就不查后面的：
//   1. 形状：地面至少两格、连成一片、墙不能只在角上相碰；
//   2. 每一格是不是都滚得到；
//   3. 整数规划算最少步数——它回答"无解"，就是每一格都滚得到、却没有一条路线能把它们全染上；
//   4. 是不是保证不会走进死局（shortfall 为 0）。这一条只是提醒，不拦发布。
// 前两步很便宜（一两毫秒），每改一格就在页面上现算；后两步可能要几秒到几分钟，放在后台线程里算。
import { parseLevel } from '../game/level.ts';
import { pinchCells, strayCells } from '../game/shape.ts';
import { shortfall, unreachedCells } from '../game/solver.ts';
import type { Change, Repair } from '../solve/repair.ts';
import { shortestTour, type Solver } from '../solve/tour.ts';
import type { CheckState } from './checker.ts';

/** 检查的结论 */
export type Verdict =
  /** 形状不合格：few 是地面不到两格，split 是地面断开了，pinch 是有墙只在角上相碰。cells 是有问题的格子 */
  | { readonly kind: 'shape'; readonly problem: 'few' | 'split' | 'pinch'; readonly cells: readonly number[] }
  /** 通不了关：cells 这些格子怎么滚都染不到 */
  | { readonly kind: 'unreached'; readonly cells: readonly number[] }
  /** 通不了关：每一格都滚得到，但没有一条路线能把它们全染上 */
  | { readonly kind: 'unsolvable' }
  /** 能通关。safe 是"保证不会走进死局" */
  | { readonly kind: 'ok'; readonly par: number; readonly solution: string; readonly safe: boolean };

/**
 * 便宜的那两步。没问题返回 null。
 * @param rows 字符画。配置页里的图总是每行一样长、恰好一个起点，所以这里不再查格式
 */
export function precheck(rows: readonly string[]): Extract<Verdict, { kind: 'shape' | 'unreached' }> | null {
  const level = parseLevel(rows);
  // 只有起点一格的图不用走就"染完"了，游戏里永远触发不了通关
  if (level.floorCount < 2) return { kind: 'shape', problem: 'few', cells: [] };
  const stray = strayCells(level.floor, level.rows, level.cols, level.start);
  if (stray.length > 0) return { kind: 'shape', problem: 'split', cells: stray };
  const pinch = pinchCells(level.floor, level.rows, level.cols);
  if (pinch.length > 0) return { kind: 'shape', problem: 'pinch', cells: pinch };
  const unreached = unreachedCells(level);
  if (unreached.length > 0) return { kind: 'unreached', cells: unreached };
  return null;
}

/**
 * 全部四步。
 * @param highs 加载好的 HiGHS。图太复杂、在限定的工作量内算不出来时，抛 TourLimitError
 */
export function fullCheck(highs: Solver, rows: readonly string[]): Verdict {
  const early = precheck(rows);
  if (early) return early;
  const level = parseLevel(rows);
  const tour = shortestTour(highs, level);
  if (!tour) return { kind: 'unsolvable' };
  return { kind: 'ok', par: tour.par, solution: tour.solution, safe: shortfall(level) === 0 };
}

/** 这个结论要不要配一条修改建议：通不了关的要，能通关但不保证不走进死局的也要 */
export function wantsAdvice(verdict: Verdict): boolean {
  return verdict.kind !== 'ok' || !verdict.safe;
}

/** 把一条修改建议写成一句话。要改的格子在画布上圈着，这里只说改成什么 */
export function adviceText(changes: readonly Change[]): string {
  const walls = changes.filter((change) => change.to === '#').length;
  const floors = changes.filter((change) => change.to === '.').length;
  const start = changes.some((change) => change.to === 'S');
  const cells = [walls > 0 ? `${walls} 格改成墙` : '', floors > 0 ? `${floors} 格改成地面` : ''].filter(Boolean).join('、');
  if (!start) return cells ? `把圈出的 ${cells}` : '';
  return cells ? `把起点挪到圈出的那一格，另外 ${cells}` : '把起点挪到圈出的那一格';
}

/** 配置页右栏"检查"里的一行：这一步查出来怎么样，配一句话 */
export interface CheckLine {
  /** pass 过了；fail 没过，这一关发布不了；warn 只是提醒；busy 正在算；null 是前面的没过、这一步没查（这时没有话可说） */
  readonly mark: 'pass' | 'fail' | 'warn' | 'busy' | null;
  readonly text: string;
}

/** 修改建议那一行：none 用不着，或者给不出；searching 正在找；found 找到了；missing 六格以内没找到 */
export type Advice = { readonly kind: 'none' | 'searching' | 'missing' } | { readonly kind: 'found'; readonly repair: Repair };

/** 一关能不能发布：ready 可以；busy 最少步数还没算出来；blocked 被拦下了 */
export type Standing = 'ready' | 'busy' | 'blocked';

/** 一关查到哪一步了。右栏的四行、修改建议、左栏的红标、发布按钮，都照它显示 */
export interface Report {
  /** 四步各一行，顺序不变：形状、每一格滚不滚得到、最少步数、会不会走进死局 */
  readonly lines: readonly CheckLine[];
  readonly advice: Advice;
  readonly standing: Standing;
}

/** 一关眼下知道的全部情况 */
export interface Checked {
  /** 便宜的那两步的结论（precheck 的返回值） */
  readonly early: ReturnType<typeof precheck>;
  /** 这张图的最少步数；还没算出来是 null */
  readonly par: number | null;
  /** 是不是保证不会走进死局（shortfall 为 0）。最少步数还没有的时候不看它 */
  readonly safe: boolean;
  /** 后台线程查这张图查到哪了；没让它查过就不给 */
  readonly state?: CheckState;
}

const UNCHECKED: CheckLine = { mark: null, text: '' };
const SHAPE_FAULT = { few: '地面至少要有两格', pinch: '有墙只在角上相碰：见圈出的地方' } as const;

/**
 * 把一关查到的情况整理成页面上要显示的样子。
 * 最少步数已经有了（没动过的关是关卡表里带来的）就照它显示，不管后台线程这时在忙什么——
 * 那种时候去问线程，只是为了要一条修改建议。
 */
export function reportOf({ early, par, safe, state }: Checked): Report {
  const lines: CheckLine[] = [UNCHECKED, UNCHECKED, UNCHECKED, UNCHECKED];
  const unsolvable = !early && par === null && state?.verdict?.kind === 'unsolvable';

  if (early?.kind === 'shape') {
    const text = early.problem === 'split' ? `地面没有连成一片：圈出的 ${early.cells.length} 格和起点不连着` : SHAPE_FAULT[early.problem];
    lines[0] = { mark: 'fail', text };
  } else {
    lines[0] = { mark: 'pass', text: '形状没问题' };
    if (early) {
      lines[1] = { mark: 'fail', text: `通不了关：有 ${early.cells.length} 格染不到` };
    } else {
      lines[1] = { mark: 'pass', text: '每一格都滚得到' };
      if (par !== null) {
        lines[2] = { mark: 'pass', text: `能通关，最少 ${par} 步` };
        lines[3] = safe ? { mark: 'pass', text: '不会走进死局' } : { mark: 'warn', text: '不保证不会走进死局' };
      } else if (unsolvable) {
        lines[2] = { mark: 'fail', text: '通不了关：每一格都滚得到，但没有一条路线能把它们全染上' };
      } else if (state?.phase === 'timeout') {
        lines[2] = { mark: 'fail', text: '这张图太复杂，算不出最少步数，请改小一些或多放几块墙' };
      } else if (state?.phase === 'failed') {
        lines[2] = { mark: 'fail', text: '检查没跑起来，请刷新页面再试' };
      } else {
        lines[2] = { mark: 'busy', text: '正在算最少步数…' };
      }
    }
  }

  let standing: Standing = 'busy';
  if (lines.some((line) => line.mark === 'fail')) standing = 'blocked';
  else if (par !== null) standing = 'ready';

  // 通不了关的要一条建议，能通关但不保证不走进死局的也要。线程坏了、放弃了，建议就不会来了
  let advice: Advice = { kind: 'none' };
  if (state && (early || unsolvable || (par !== null && !safe))) {
    if (state.phase === 'queued' || state.phase === 'solving' || state.phase === 'repairing') advice = { kind: 'searching' };
    else if (state.phase === 'done' && state.repair === null) advice = { kind: 'missing' };
    else if (state.phase === 'done' && state.repair && state.repair.changes.length > 0) advice = { kind: 'found', repair: state.repair };
  }
  return { lines, advice, standing };
}

/**
 * 还不能发布的时候，发布按钮旁边写的那句话；都能发布了返回空串。
 * 先说被拦下的（要人动手改），没有被拦下的再说还在算的。
 * @param standings 每一关的情况，按关卡的顺序
 */
export function publishNote(standings: readonly Standing[]): string {
  const blocked = standings.indexOf('blocked');
  if (blocked >= 0) return `第 ${blocked + 1} 关还不能发布`;
  const busy = standings.indexOf('busy');
  return busy >= 0 ? `正在算第 ${busy + 1} 关` : '';
}
