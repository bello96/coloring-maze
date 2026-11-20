import { describe, expect, it } from 'vitest';
import { parseLevel, type Dir } from '../src/game/level.ts';
import { BUILTIN, checkLevelSet, DYES, dyeNumber, LIMITS, sigOf, sizeOk } from '../src/game/levelset.ts';
import { LEVELS } from '../src/game/levels.ts';
import { isDone, newGame, roll } from '../src/game/rules.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { carve } from '../tools/gen.ts';
import { randomMaze, seeded } from './helpers/random.ts';

/** 最简单的一张合格的图：第一行五格地面，起点在最左边，往右滚一步染完 */
const ROWS = ['S....', '#####', '#####', '#####', '#####'];
const good = (over: object = {}): Record<string, unknown> => ({ id: 'aa', rows: ROWS, dye: '#2646b8', par: 1, solution: 'R', ...over });
const set = (...levels: unknown[]): unknown => ({ version: 1, levels });
/** rows 行、cols 列的一片空地，起点在左上角 */
const open = (rows: number, cols: number): string[] => Array.from({ length: rows }, (_, r) => (r === 0 ? 'S' : '.') + '.'.repeat(cols - 1));

/**
 * rows 行、cols 列的一条来回折的走廊，连同它的走法：单数行（从 0 数起的双数）整行是地面，
 * 夹在中间的那几行是墙、只在一头留一格，一行在右头、下一行在左头。往右、往下、往左、往下……一路走完，正好每格染到。
 */
function snake(rows: number, cols: number): { rows: string[]; par: number; solution: string } {
  const map: string[] = [];
  let solution = '';
  for (let r = 0; r < rows; r++) {
    if (r % 2 === 0) {
      map.push((r === 0 ? 'S' : '.') + '.'.repeat(cols - 1));
      solution += (r > 0 ? 'D' : '') + (r % 4 === 0 ? 'R' : 'L');
    } else if (r === rows - 1) {
      // 最底下多出来的一行全是墙
      map.push('#'.repeat(cols));
    } else {
      map.push(r % 4 === 1 ? '#'.repeat(cols - 1) + '.' : '.' + '#'.repeat(cols - 1));
    }
  }
  return { rows: map, par: solution.length, solution };
}

describe('the built-in level set', () => {
  it('is the 80 levels of the game, numbered b01 to b80, with the eight dyes taking turns', () => {
    expect(BUILTIN.version).toBe(1);
    expect(BUILTIN.levels).toHaveLength(80);
    BUILTIN.levels.forEach((entry, i) => {
      expect(entry).toEqual({
        id: `b${String(i + 1).padStart(2, '0')}`,
        rows: LEVELS[i].rows,
        dye: DYES[i % 8],
        par: LEVELS[i].par,
        solution: LEVELS[i].solution,
      });
    });
    expect(BUILTIN.levels[0]).toMatchObject({ id: 'b01', dye: '#2646b8', par: 3, solution: 'ULD' });
    expect(BUILTIN.levels[8].dye).toBe('#2646b8');
    expect(BUILTIN.levels[79].id).toBe('b80');
  });

  it('passes its own check, also after a trip through JSON', () => {
    const result = checkLevelSet(JSON.parse(JSON.stringify(BUILTIN)));
    expect(result).toEqual({ ok: true, set: BUILTIN });
  });

  it('uses the same eight dyes, in the same order, as before levels could be configured', () => {
    expect(DYES).toEqual(['#2646b8', '#c0302b', '#0e8a78', '#dd8e10', '#6f3bb5', '#3f8f2e', '#cf3f77', '#1787c2']);
    expect(dyeNumber('#2646b8')).toBe(0x2646b8);
    expect(dyeNumber('#0e8a78')).toBe(0x0e8a78);
  });
});

describe('checking a level set', () => {
  it('accepts the smallest sensible set', () => {
    expect(checkLevelSet(set(good()))).toEqual({ ok: true, set: { version: 1, levels: [good()] } });
  });

  it('keeps only the fields it knows and writes the dye in lower case', () => {
    const result = checkLevelSet({ version: 1, extra: true, levels: [good({ dye: '#AABBCC', note: 'x' })] });
    expect(result).toEqual({ ok: true, set: { version: 1, levels: [{ id: 'aa', rows: ROWS, dye: '#aabbcc', par: 1, solution: 'R' }] } });
  });

  it('accepts 200 levels and the largest board either way up', () => {
    const many = Array.from({ length: 200 }, (_, i) => good({ id: `a${i}` }));
    expect(checkLevelSet(set(...many)).ok).toBe(true);
    // 内置的最后一关是 23×17
    const big = BUILTIN.levels[79];
    expect([big.rows.length, big.rows[0].length]).toEqual([23, 17]);
    expect(checkLevelSet(set(big)).ok).toBe(true);
    // 最大的 25×20，竖着、横着各一张：一条来回折的走廊
    for (const [rows, cols] of [[25, 20], [20, 25]] as const) {
      const made = snake(rows, cols);
      expect([made.rows.length, made.rows[0].length]).toEqual([rows, cols]);
      expect(checkLevelSet(set(good(made))), `${rows}×${cols}`).toMatchObject({ ok: true });
      // 走法掐掉最后一步就染不完了：上面那一句不是随便什么都放行
      expect(checkLevelSet(set(good({ ...made, par: made.par - 1, solution: made.solution.slice(0, -1) }))).ok, `${rows}×${cols}`).toBe(false);
    }
  });

  it('keeps the open-all switch only when it is on', () => {
    expect(checkLevelSet({ version: 1, openAll: true, levels: [good()] })).toEqual({ ok: true, set: { version: 1, levels: [good()], openAll: true } });
    // 关着的和没写的一样：整理出来的关卡表里没有这一项
    const off = checkLevelSet({ version: 1, openAll: false, levels: [good()] });
    expect(off).toEqual({ ok: true, set: { version: 1, levels: [good()] } });
    expect(off.ok && 'openAll' in off.set).toBe(false);
    expect(BUILTIN.openAll).toBeUndefined();
    // 来回过一遍 JSON 还是开着的
    const on = checkLevelSet(JSON.parse(JSON.stringify({ version: 1, levels: [good()], openAll: true })));
    expect(on.ok && on.set.openAll).toBe(true);
  });

  const cases: ReadonlyArray<readonly [name: string, data: unknown, level: number, detail: RegExp]> = [
    ['a number instead of a set', 7, -1, /格式/],
    ['null', null, -1, /格式/],
    ['a string', 'x', -1, /格式/],
    ['a bare list of levels', [good()], -1, /格式/],
    ['a version it does not know', { version: 2, levels: [good()] }, -1, /格式/],
    ['no list of levels', { version: 1 }, -1, /格式/],
    ['levels that are not a list', { version: 1, levels: 'x' }, -1, /格式/],
    ['no levels at all', set(), -1, /1–200/],
    ['201 levels', set(...Array.from({ length: 201 }, (_, i) => good({ id: `a${i}` }))), -1, /1–200/],
    ['an open-all switch that is text', { version: 1, openAll: 'true', levels: [good()] }, -1, /开放全部关卡/],
    ['an open-all switch that is a number', { version: 1, openAll: 1, levels: [good()] }, -1, /开放全部关卡/],
    ['an open-all switch that is null', { version: 1, openAll: null, levels: [good()] }, -1, /开放全部关卡/],

    ['a level that is null', set(good(), null), 1, /格式/],
    ['a level that is a string', set(good(), 'x'), 1, /格式/],
    ['a level that is a list', set([]), 0, /格式/],

    ['an id with a capital letter', set(good({ id: 'B1' })), 0, /编号/],
    ['an id of one character', set(good({ id: 'a' })), 0, /编号/],
    ['an id of thirteen characters', set(good({ id: 'abcdefghijklm' })), 0, /编号/],
    ['an id with a dash', set(good({ id: 'a-b' })), 0, /编号/],
    ['an id that is a number', set(good({ id: 7 })), 0, /编号/],
    ['no id', set({ rows: ROWS, dye: '#2646b8', par: 1, solution: 'R' }), 0, /编号/],
    ['the same id twice', set(good(), good()), 1, /重复/],

    ['rows that are a string', set(good({ rows: 'x' })), 0, /字符画/],
    ['rows that are numbers', set(good({ rows: [1, 2, 3, 4, 5] })), 0, /字符画/],
    ['no rows', set(good({ rows: [] })), 0, /字符画/],
    ['empty rows', set(good({ rows: ['', '', '', '', ''] })), 0, /字符画/],
    ['rows of different lengths', set(good({ rows: ['S....', '####', '#####', '#####', '#####'] })), 0, /字符画/],
    ['a character it does not know', set(good({ rows: ['S...x', '#####', '#####', '#####', '#####'] })), 0, /三种字符/],
    ['a start written in lower case', set(good({ rows: ['s....', '#####', '#####', '#####', '#####'] })), 0, /三种字符/],
    ['a blank where a cell should be', set(good({ rows: ['S.. .', '#####', '#####', '#####', '#####'] })), 0, /三种字符/],
    ['a full-width full stop for floor', set(good({ rows: ['S..。.', '#####', '#####', '#####', '#####'] })), 0, /三种字符/],
    ['only four rows', set(good({ rows: ROWS.slice(0, 4) })), 0, /5–25 之间，长边最多 25，短边最多 20/],
    ['only four columns', set(good({ rows: ROWS.map((row) => row.slice(0, 4)) })), 0, /5–25/],
    ['26 rows', set(good({ rows: open(26, 5) })), 0, /5–25/],
    ['26 columns', set(good({ rows: open(5, 26) })), 0, /5–25/],
    ['a short side of 21', set(good({ rows: open(25, 21) })), 0, /5–25/],
    ['21 by 21', set(good({ rows: open(21, 21) })), 0, /5–25/],

    ['two starts', set(good({ rows: ['S...S', '#####', '#####', '#####', '#####'] })), 0, /起点/],
    ['no start', set(good({ rows: ['.....', '#####', '#####', '#####', '#####'] })), 0, /起点/],
    ['floor in two pieces', set(good({ rows: ['S.#..', '#####', '#####', '#####', '#####'] })), 0, /连成一片/],
    ['walls touching only at a corner', set(good({ rows: ['S..##', '.#.##', '..#.#', '#...#', '#####'] })), 0, /角上/],

    ['a dye that is a colour name', set(good({ dye: 'red' })), 0, /染料/],
    ['a dye one digit short', set(good({ dye: '#12345' })), 0, /染料/],
    ['a dye with letters past f', set(good({ dye: '#gggggg' })), 0, /染料/],
    ['a dye that is a number', set(good({ dye: 123 })), 0, /染料/],

    ['a board that is nothing but the start', set(good({ rows: ['S####', '#####', '#####', '#####', '#####'], par: 0, solution: '' })), 0, /最少步数/],
    ['fewest steps with a fraction', set(good({ par: 1.5 })), 0, /最少步数/],
    ['fewest steps as text', set(good({ par: '1' })), 0, /最少步数/],
    ['a route longer than the fewest steps', set(good({ solution: 'RL' })), 0, /走法/],
    ['a route with a letter that is no direction', set(good({ solution: 'X' })), 0, /走法/],
    ['a route in lower case', set(good({ solution: 'r' })), 0, /走法/],
    ['a route that is a list', set(good({ solution: ['R'] })), 0, /走法/],
    ['a route whose first step runs straight into a wall', set(good({ solution: 'L' })), 0, /第 1 步滚不动/],
    ['a route that leaves a cell undyed', set(good({ rows: ['.S...', '#####', '#####', '#####', '#####'] })), 0, /没染上/],
  ];

  it.each(cases)('turns down %s', (_name, data, level, detail) => {
    const result = checkLevelSet(data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.level).toBe(level);
    expect(result.detail).toMatch(detail);
  });

  it('never throws, whatever it is given', () => {
    const odd: unknown[] = [undefined, true, 0, '', [], {}, { version: 1, levels: [undefined] }, { version: 1, levels: [{ id: 'aa', rows: [null] }] }, { version: 1, levels: [{ id: 'aa', rows: ROWS, dye: '#000000', par: 1, solution: null }] }];
    for (const data of odd) expect(checkLevelSet(data).ok).toBe(false);
  });
});

describe('following the route that comes with a level', () => {
  // 校验里"照着走法走一遍"是单独写的一份（为了省时间，见 levelset.ts），这里拿它和游戏真正用的规则逐一对答案
  const byTheRules = (rows: string[], route: string): boolean => {
    const game = newGame(parseLevel(rows));
    for (const ch of route) if (!roll(game, ch as Dir)) return false;
    return isDone(game);
  };
  const accepts = (rows: string[], route: string): boolean => checkLevelSet(set(good({ rows, par: route.length, solution: route }))).ok;

  it('agrees with the rules of the game on random routes through random maps, right or wrong', () => {
    const rand = seeded(17);
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
    let right = 0;
    let wrong = 0;
    for (let i = 0; i < 2500; i++) {
      let rows: string[];
      let route = '';
      if (rand() < 0.6) {
        // 凿出来的图自带一条走得通的走法；有时原样用，有时掐掉最后一步、改掉一步、多走一步
        const made = carve(rand, int(5, 9), int(5, 9), int(3, 24), int(0, 3));
        if (!made) continue;
        rows = made.rows;
        route = made.route;
        const twist = rand();
        if (twist < 0.15) route = route.slice(0, -1);
        else if (twist < 0.3) route = route.slice(0, 1) + 'URDL'[int(0, 3)] + route.slice(2);
        else if (twist < 0.4) route += 'URDL'[int(0, 3)];
      } else {
        rows = randomMaze(rand, int(5, 9), int(5, 9), 0.15 + rand() * 0.45);
        for (let k = int(1, 12); k > 0; k--) route += 'URDL'[int(0, 3)];
      }
      const level = parseLevel(rows);
      if (route.length === 0 || hasPinch(level.floor, level.rows, level.cols) || !floorConnected(level.floor, level.rows, level.cols)) continue;
      const expected = byTheRules(rows, route);
      expect(accepts(rows, route), `${rows.join('/')} 走 ${route}`).toBe(expected);
      if (expected) right++;
      else wrong++;
    }
    // 两种都得真的碰到过不少
    expect(right).toBeGreaterThan(150);
    expect(wrong).toBeGreaterThan(150);
  });

  it('agrees with the rules on the routes of all 80 built-in levels, and on each of them cut one step short', () => {
    for (const entry of BUILTIN.levels) {
      const rows = [...entry.rows];
      expect(accepts(rows, entry.solution), entry.id).toBe(true);
      expect(accepts(rows, entry.solution.slice(0, -1)), entry.id).toBe(byTheRules(rows, entry.solution.slice(0, -1)));
    }
  });
});

describe('the fingerprint of a map', () => {
  it('is eight hex digits, the same for the same map and different for a different one', () => {
    expect(sigOf(['S.', '..'])).toMatch(/^[0-9a-f]{8}$/);
    expect(sigOf(['S.', '..'])).toBe(sigOf(['S.', '..']));
    expect(sigOf(['S.', '..'])).not.toBe(sigOf(['S.', '.#']));
    // 行怎么分也算在内：同样的字符、不同的行宽不是同一张图
    expect(sigOf(['S...', '....'])).not.toBe(sigOf(['S.', '..', '..', '..']));
  });

  it('is different for each of the built-in levels', () => {
    expect(new Set(BUILTIN.levels.map((entry) => sigOf(entry.rows))).size).toBe(80);
  });
});

describe('the sizes a board may have', () => {
  it('are 5 to 25 either way, with the longer side at most 25 and the shorter at most 20', () => {
    expect(LIMITS).toEqual({ maxLevels: 200, minSide: 5, maxLong: 25, maxShort: 20 });
    const allowed: Array<[number, number]> = [[5, 5], [25, 20], [20, 25], [20, 20], [5, 25], [25, 5], [23, 17], [17, 23]];
    const refused: Array<[number, number]> = [[4, 9], [9, 4], [4, 4], [26, 5], [5, 26], [21, 21], [25, 21], [21, 25], [5.5, 5], [0, 0]];
    for (const [rows, cols] of allowed) expect(sizeOk(rows, cols), `${rows}×${cols}`).toBe(true);
    for (const [rows, cols] of refused) expect(sizeOk(rows, cols), `${rows}×${cols}`).toBe(false);
  });
});
