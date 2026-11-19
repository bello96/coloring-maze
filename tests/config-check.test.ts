// 配置页对一张图做的检查：形状、每一格滚不滚得到、最少步数、会不会走进死局。
import loadHighs from 'highs';
import { describe, expect, it } from 'vitest';
import { adviceText, fullCheck, precheck, publishNote, reportOf, type Report, type Verdict } from '../src/config/check.ts';
import type { CheckState } from '../src/config/checker.ts';
import { parseLevel, type Dir } from '../src/game/level.ts';
import { BUILTIN } from '../src/game/levelset.ts';
import { isDone, newGame, roll, steps } from '../src/game/rules.ts';
import { pinchCells } from '../src/game/shape.ts';
import { shortfall } from '../src/game/solver.ts';
import type { Repair } from '../src/solve/repair.ts';
import { shortestTour, type Solver } from '../src/solve/tour.ts';
import { randomMaze, seeded } from './helpers/random.ts';

const highs: Solver = await loadHighs();

/** 一用就报错的求解器：用来确认便宜的检查没过时，根本不会去算最少步数 */
const never: Solver = {
  solve() {
    throw new Error('不该算到这一步');
  },
};

const ONLY_START = ['S####', '#####', '#####', '#####', '#####'];
const SPLIT = ['S.#..', '#####', '#####', '#####', '#####'];
const PINCH = ['S..##', '.#.##', '..#.#', '#...#', '#####'];
/** 小球只会在第一行两头之间来回，停不到中间那一列的上方 */
const UNREACHED = ['S....', '##.##', '##.##', '#####', '#####'];

describe('the cheap checks', () => {
  it('want at least two cells of floor', () => {
    expect(precheck(ONLY_START)).toEqual({ kind: 'shape', problem: 'few', cells: [] });
  });

  it('point at the floor that is cut off from the start', () => {
    expect(precheck(SPLIT)).toEqual({ kind: 'shape', problem: 'split', cells: [3, 4] });
  });

  it('point at the cells where walls touch only at a corner', () => {
    const level = parseLevel(PINCH);
    expect(precheck(PINCH)).toEqual({ kind: 'shape', problem: 'pinch', cells: [6, 7, 8, 11, 12, 13] });
    expect(pinchCells(level.floor, level.rows, level.cols)).toEqual([6, 7, 8, 11, 12, 13]);
  });

  it('report the cut-off floor first when a map has both shape problems', () => {
    const both = ['S..##', '.#.##', '..#.#', '#...#', '####.'];
    expect(precheck(both)).toMatchObject({ kind: 'shape', problem: 'split', cells: [24] });
  });

  it('point at the cells the marble can never roll over', () => {
    expect(precheck(UNREACHED)).toEqual({ kind: 'unreached', cells: [7, 12] });
  });

  it('find nothing wrong with any of the built-in levels', () => {
    for (const entry of BUILTIN.levels) expect(precheck(entry.rows), entry.id).toBeNull();
  });
});

describe('the full check', () => {
  it('stops at the cheap checks when they fail, without working out the fewest steps', () => {
    expect(fullCheck(never, ONLY_START)).toEqual(precheck(ONLY_START));
    expect(fullCheck(never, SPLIT)).toEqual(precheck(SPLIT));
    expect(fullCheck(never, PINCH)).toEqual(precheck(PINCH));
    expect(fullCheck(never, UNREACHED)).toEqual(precheck(UNREACHED));
  });

  it.each([1, 16, 35])('finds the fewest steps of built-in level %i, with a route that works, and no risk of a dead end', (number) => {
    const entry = BUILTIN.levels[number - 1];
    const verdict = fullCheck(highs, entry.rows);
    expect(verdict).toMatchObject({ kind: 'ok', par: entry.par, safe: true });
    if (verdict.kind !== 'ok') return;
    const game = newGame(parseLevel(entry.rows));
    for (const ch of verdict.solution) expect(roll(game, ch as Dir)).not.toBeNull();
    expect(isDone(game)).toBe(true);
    expect(steps(game)).toBe(entry.par);
  });

  it('tells the three outcomes apart on random maps: cannot be finished, can but may trap, can and never traps', () => {
    const rand = seeded(21);
    let unsolvable = 0;
    let risky = 0;
    let fine = 0;
    // "每一格都滚得到却通不了关"的图很少见（几百张里一张），所以多造一些；
    // 不会走进死局的图要多少有多少，凑够几张就不再算它们，省下求解的时间
    for (let i = 0; i < 6000 && (unsolvable < 6 || risky < 6 || fine < 6); i++) {
      const rows = randomMaze(rand, 5 + Math.floor(rand() * 3), 5 + Math.floor(rand() * 3), 0.12 + rand() * 0.3);
      if (precheck(rows)) continue;
      const level = parseLevel(rows);
      if (fine >= 6 && shortfall(level) === 0) continue;
      const tour = shortestTour(highs, level);
      const verdict = fullCheck(highs, rows);
      const where = rows.join('/');
      if (!tour) {
        // 每一格都滚得到，但没有一条路线能把它们全染上
        expect(verdict, where).toEqual({ kind: 'unsolvable' });
        unsolvable++;
        continue;
      }
      const safe = shortfall(level) === 0;
      expect(verdict, where).toMatchObject({ kind: 'ok', par: tour.par, safe });
      if (safe) fine++;
      else risky++;
    }
    // 三种都得真的碰到过，不然等于没比
    expect(unsolvable).toBeGreaterThan(5);
    expect(risky).toBeGreaterThan(5);
    expect(fine).toBeGreaterThan(5);
  }, 120_000);
});

describe('a suggestion put into words', () => {
  it('says how many cells to turn into wall or floor', () => {
    expect(adviceText([{ cell: 1, to: '#' }, { cell: 2, to: '#' }])).toBe('把圈出的 2 格改成墙');
    expect(adviceText([{ cell: 1, to: '.' }, { cell: 2, to: '.' }, { cell: 3, to: '.' }])).toBe('把圈出的 3 格改成地面');
    expect(adviceText([{ cell: 1, to: '#' }, { cell: 2, to: '.' }])).toBe('把圈出的 1 格改成墙、1 格改成地面');
  });

  it('says when the start is to be moved', () => {
    expect(adviceText([{ cell: 4, to: 'S' }])).toBe('把起点挪到圈出的那一格');
    expect(adviceText([{ cell: 4, to: 'S' }, { cell: 1, to: '#' }])).toBe('把起点挪到圈出的那一格，另外 1 格改成墙');
    expect(adviceText([{ cell: 1, to: '.' }, { cell: 4, to: 'S' }, { cell: 2, to: '#' }, { cell: 3, to: '.' }])).toBe('把起点挪到圈出的那一格，另外 1 格改成墙、2 格改成地面');
  });

  it('has nothing to say when there is nothing to change', () => {
    expect(adviceText([])).toBe('');
  });
});

describe('what the page says about one level', () => {
  const UNCHECKED = { mark: null, text: '' };
  const OK: Verdict = { kind: 'ok', par: 9, solution: 'RDLURDLUR', safe: true };
  const RISKY: Verdict = { kind: 'ok', par: 9, solution: 'RDLURDLUR', safe: false };
  const UNSOLVABLE: Verdict = { kind: 'unsolvable' };
  const FIX: Repair = { changes: [{ cell: 7, to: '#' }], rows: ['S....', '#####', '##.##', '#####', '#####'] };
  const marks = (report: Report): unknown[] => report.lines.map((line) => line.mark);

  it('passes all four steps when the fewest steps are known and no dead end is possible', () => {
    const report = reportOf({ early: null, par: 12, safe: true });
    expect(report.lines).toEqual([
      { mark: 'pass', text: '形状没问题' },
      { mark: 'pass', text: '每一格都滚得到' },
      { mark: 'pass', text: '能通关，最少 12 步' },
      { mark: 'pass', text: '不会走进死局' },
    ]);
    expect(report.standing).toBe('ready');
    expect(report.advice).toEqual({ kind: 'none' });
    // 后台线程刚查完这张图也是一样
    expect(reportOf({ early: null, par: 9, safe: true, state: { phase: 'done', verdict: OK } })).toMatchObject({ standing: 'ready', advice: { kind: 'none' } });
  });

  it('stops at the shape, says what is wrong with it and leaves the later steps unchecked', () => {
    const few = reportOf({ early: precheck(ONLY_START), par: null, safe: false });
    expect(few.lines).toEqual([{ mark: 'fail', text: '地面至少要有两格' }, UNCHECKED, UNCHECKED, UNCHECKED]);
    expect(few.standing).toBe('blocked');

    const split = reportOf({ early: precheck(SPLIT), par: null, safe: false });
    expect(split.lines).toEqual([{ mark: 'fail', text: '地面没有连成一片：圈出的 2 格和起点不连着' }, UNCHECKED, UNCHECKED, UNCHECKED]);
    expect(split.standing).toBe('blocked');

    const pinch = reportOf({ early: precheck(PINCH), par: null, safe: false });
    expect(pinch.lines).toEqual([{ mark: 'fail', text: '有墙只在角上相碰：见圈出的地方' }, UNCHECKED, UNCHECKED, UNCHECKED]);
    expect(pinch.standing).toBe('blocked');
  });

  it('stops at the cells the marble can never roll over', () => {
    const report = reportOf({ early: precheck(UNREACHED), par: null, safe: false });
    expect(report.lines).toEqual([{ mark: 'pass', text: '形状没问题' }, { mark: 'fail', text: '通不了关：有 2 格染不到' }, UNCHECKED, UNCHECKED]);
    expect(report.standing).toBe('blocked');
  });

  it.each<[string, CheckState | undefined]>([
    ['it has not been asked yet', undefined],
    ['the level is waiting its turn', { phase: 'queued' }],
    ['it is working on the level', { phase: 'solving' }],
  ])('is busy with the fewest steps while the thread has no answer: %s', (_when, state) => {
    const report = reportOf({ early: null, par: null, safe: false, state });
    expect(report.lines).toEqual([{ mark: 'pass', text: '形状没问题' }, { mark: 'pass', text: '每一格都滚得到' }, { mark: 'busy', text: '正在算最少步数…' }, UNCHECKED]);
    expect(report.standing).toBe('busy');
    expect(report.advice).toEqual({ kind: 'none' });
  });

  it('stops at the fewest steps when every cell can be reached but no route dyes them all', () => {
    const report = reportOf({ early: null, par: null, safe: false, state: { phase: 'repairing', verdict: UNSOLVABLE } });
    expect(marks(report)).toEqual(['pass', 'pass', 'fail', null]);
    expect(report.lines[2].text).toBe('通不了关：每一格都滚得到，但没有一条路线能把它们全染上');
    expect(report.standing).toBe('blocked');
  });

  it('stops at the fewest steps when the map is too hard to work out, or the check did not run', () => {
    const hard = reportOf({ early: null, par: null, safe: false, state: { phase: 'timeout' } });
    expect(marks(hard)).toEqual(['pass', 'pass', 'fail', null]);
    expect(hard.lines[2].text).toBe('这张图太复杂，算不出最少步数，请改小一些或多放几块墙');
    expect(hard).toMatchObject({ standing: 'blocked', advice: { kind: 'none' } });

    const broken = reportOf({ early: null, par: null, safe: false, state: { phase: 'failed' } });
    expect(marks(broken)).toEqual(['pass', 'pass', 'fail', null]);
    expect(broken.lines[2].text).toBe('检查没跑起来，请刷新页面再试');
    expect(broken).toMatchObject({ standing: 'blocked', advice: { kind: 'none' } });
  });

  it('only warns when a dead end cannot be ruled out: the level can still be published', () => {
    const report = reportOf({ early: null, par: 9, safe: false, state: { phase: 'repairing', verdict: RISKY } });
    expect(report.lines).toEqual([
      { mark: 'pass', text: '形状没问题' },
      { mark: 'pass', text: '每一格都滚得到' },
      { mark: 'pass', text: '能通关，最少 9 步' },
      { mark: 'warn', text: '不保证不会走进死局' },
    ]);
    expect(report.standing).toBe('ready');
  });

  it('keeps showing the fewest steps it already has, whatever the thread is doing', () => {
    // 没动过的关，最少步数是关卡表里带来的；为了要一条修改建议才去问的后台线程
    for (const phase of ['queued', 'solving', 'timeout', 'failed'] as const) {
      const report = reportOf({ early: null, par: 31, safe: false, state: { phase } });
      expect(report.lines[2], phase).toEqual({ mark: 'pass', text: '能通关，最少 31 步' });
      expect(report.lines[3], phase).toEqual({ mark: 'warn', text: '不保证不会走进死局' });
      expect(report.standing, phase).toBe('ready');
    }
  });

  it('says a suggestion is being looked for until the thread is done with the level', () => {
    const early = precheck(UNREACHED);
    for (const phase of ['queued', 'solving', 'repairing'] as const) {
      // 形状或者滚不到的问题、每一格都滚得到却通不了关、能通关但不保证不走进死局：三种都要建议
      expect(reportOf({ early, par: null, safe: false, state: { phase } }).advice, phase).toEqual({ kind: 'searching' });
      expect(reportOf({ early: null, par: 9, safe: false, state: { phase } }).advice, phase).toEqual({ kind: 'searching' });
    }
    expect(reportOf({ early: null, par: null, safe: false, state: { phase: 'repairing', verdict: UNSOLVABLE } }).advice).toEqual({ kind: 'searching' });
  });

  it('hands over the suggestion that was found, or says that none was', () => {
    const early = precheck(UNREACHED);
    expect(reportOf({ early, par: null, safe: false, state: { phase: 'done', verdict: early!, repair: FIX } }).advice).toEqual({ kind: 'found', repair: FIX });
    expect(reportOf({ early, par: null, safe: false, state: { phase: 'done', verdict: early!, repair: null } }).advice).toEqual({ kind: 'missing' });
    expect(reportOf({ early: null, par: null, safe: false, state: { phase: 'done', verdict: UNSOLVABLE, repair: FIX } }).advice).toEqual({ kind: 'found', repair: FIX });
    expect(reportOf({ early: null, par: null, safe: false, state: { phase: 'done', verdict: UNSOLVABLE, repair: null } }).advice).toEqual({ kind: 'missing' });
    expect(reportOf({ early: null, par: 9, safe: false, state: { phase: 'done', verdict: RISKY, repair: FIX } }).advice).toEqual({ kind: 'found', repair: FIX });
    expect(reportOf({ early: null, par: 9, safe: false, state: { phase: 'done', verdict: RISKY, repair: null } }).advice).toEqual({ kind: 'missing' });
  });

  it('has no suggestion to show when none is needed or none can come', () => {
    const early = precheck(UNREACHED);
    // 没让后台线程查过；线程坏了、放弃了
    expect(reportOf({ early, par: null, safe: false }).advice).toEqual({ kind: 'none' });
    expect(reportOf({ early, par: null, safe: false, state: { phase: 'failed' } }).advice).toEqual({ kind: 'none' });
    expect(reportOf({ early, par: null, safe: false, state: { phase: 'timeout' } }).advice).toEqual({ kind: 'none' });
    expect(reportOf({ early: null, par: 9, safe: false }).advice).toEqual({ kind: 'none' });
    expect(reportOf({ early: null, par: 9, safe: false, state: { phase: 'failed' } }).advice).toEqual({ kind: 'none' });
    // 图没毛病：线程哪怕回了一条建议也不显示
    expect(reportOf({ early: null, par: 9, safe: true, state: { phase: 'done', verdict: OK, repair: FIX } }).advice).toEqual({ kind: 'none' });
    // 一格都不用改的"建议"不算建议
    expect(reportOf({ early: null, par: 9, safe: false, state: { phase: 'done', verdict: RISKY, repair: { changes: [], rows: FIX.rows } } }).advice).toEqual({ kind: 'none' });
  });
});

describe('why the levels cannot be published yet', () => {
  it('has nothing to say when every level is ready', () => {
    expect(publishNote(['ready', 'ready', 'ready'])).toBe('');
    expect(publishNote([])).toBe('');
  });

  it('names the first level that is held back', () => {
    expect(publishNote(['ready', 'blocked', 'ready', 'blocked'])).toBe('第 2 关还不能发布');
  });

  it('names the first level still being worked out when none is held back', () => {
    expect(publishNote(['ready', 'ready', 'busy', 'busy'])).toBe('正在算第 3 关');
  });

  it('puts a level that is held back before one that is only being worked out', () => {
    expect(publishNote(['busy', 'ready', 'blocked'])).toBe('第 3 关还不能发布');
  });
});
