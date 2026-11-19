// 修改建议（src/solve/repair.ts）：手画的图不合格时，给出一条"改尽量少的格子就合格"的改法。
// 这里核对四件事：照建议改完，图真的合格了；改一格、两格就够的时候没有多改（和把所有改法试一遍的笨办法比）；
// 细找（closestRepair，六格以内）找不到、来不及的时候如实说没有；而给配置页用的 suggestRepair 不管图离合格多远都拿得出一条改法。
import { beforeAll, describe, expect, it } from 'vitest';
import { parseLevel } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { shortfall } from '../src/game/solver.ts';
import { applyChanges, closestRepair, sound, suggestRepair, type Repair } from '../src/solve/repair.ts';
import { randomMaze, seeded } from './helpers/random.ts';

/** 照定义把"合不合格"再查一遍，不用 repair.ts 自己的判断：地面至少两格、连成一片、没有只在角上相碰的墙、保证不会困死 */
function fine(rows: readonly string[]): boolean {
  const level = parseLevel(rows);
  return (
    level.floorCount >= 2 &&
    floorConnected(level.floor, level.rows, level.cols) &&
    !hasPinch(level.floor, level.rows, level.cols) &&
    shortfall(level) === 0
  );
}

/** 把一张图的一格换成另一个字符 */
function withCell(rows: readonly string[], cell: number, ch: string): string[] {
  const cols = rows[0].length;
  const flat = [...rows.join('')];
  flat[cell] = ch;
  return rows.map((_, r) => flat.slice(r * cols, (r + 1) * cols).join(''));
}

/** 只改一格能变成的所有图：不是起点的格子墙和地面互换，或者把起点挪到另一格地面上。先按格子编号列互换的，再按编号列挪起点的 */
function oneChangeAway(rows: readonly string[]): Array<{ rows: string[]; cell: number; moved: boolean }> {
  const flat = rows.join('');
  const start = flat.indexOf('S');
  const out: Array<{ rows: string[]; cell: number; moved: boolean }> = [];
  for (let cell = 0; cell < flat.length; cell++) {
    if (cell !== start) out.push({ rows: withCell(rows, cell, flat[cell] === '#' ? '.' : '#'), cell, moved: false });
  }
  for (let cell = 0; cell < flat.length; cell++) {
    if (flat[cell] === '.') out.push({ rows: withCell(withCell(rows, start, '.'), cell, 'S'), cell, moved: true });
  }
  return out;
}

/** 穷举：只改一格就能修好的改法里排在最前面的那一种改完的样子；一格修不好返回 undefined */
function firstFixInOne(rows: readonly string[]): string[] | undefined {
  return oneChangeAway(rows).find((made) => fine(made.rows))?.rows;
}

/** 穷举：只改一格能不能修好 */
function fixableInOne(rows: readonly string[]): boolean {
  return firstFixInOne(rows) !== undefined;
}

/** 穷举：改两格能不能修好（只用于 6×6 以内）。同一格不改两次，起点最多挪一次 */
function fixableInTwo(rows: readonly string[]): boolean {
  for (const first of oneChangeAway(rows)) {
    for (const second of oneChangeAway(first.rows)) {
      if (second.cell === first.cell || (first.moved && second.moved)) continue;
      if (fine(second.rows)) return true;
    }
  }
  return false;
}

/** 一条 9×9 的 U 形走廊，被两块多出来的墙（第 1 行正中、左边一列正中）截成了三段：非得把这两格都改回地面不可 */
const TWO_GATES = [
  '....#....',
  '.#######.',
  '.#######.',
  '.#######.',
  '########.',
  '.#######.',
  '.#######.',
  '.#######.',
  '.#######S',
];

describe('sound: is a map fit to be played', () => {
  it('accepts every level of the game', () => {
    LEVELS.forEach((def, i) => expect(sound(def.rows), `第 ${i + 1} 关`).toBe(true));
  });

  it('refuses a map where some floor can never be dyed', () => {
    expect(sound(['S..', '#.#', '#.#'])).toBe(false);
    expect(sound(TWO_GATES)).toBe(false);
  });

  it('refuses a map the player can get stuck in', () => {
    // 先往右就回不来了（见 solver.test.ts）
    expect(sound(['.#.#', '.S.#', '##.#'])).toBe(false);
  });

  it('refuses walls that touch only at a corner, even where the ball could never get stuck', () => {
    const rows = ['S..', '.#.', '..#'];
    expect(shortfall(parseLevel(rows))).toBe(0);
    expect(sound(rows)).toBe(false);
  });

  it('refuses a map whose only floor is the start', () => {
    // 这种图一步都不用走，游戏里永远等不到"通关"
    expect(shortfall(parseLevel(['S####', '#####', '#####', '#####', '#####']))).toBe(0);
    expect(sound(['S####', '#####', '#####', '#####', '#####'])).toBe(false);
    expect(sound(['S'])).toBe(false);
  });

  it('agrees with checking each requirement separately (400 random mazes)', () => {
    const rand = seeded(9);
    let good = 0;
    for (let i = 0; i < 400; i++) {
      const rows = randomMaze(rand, 3 + Math.floor(rand() * 5), 3 + Math.floor(rand() * 5), rand() * 0.3);
      expect(sound(rows), rows.join('/')).toBe(fine(rows));
      if (fine(rows)) good++;
    }
    // 合格的、不合格的都得真的碰到过
    expect(good).toBeGreaterThan(10);
    expect(good).toBeLessThan(390);
  });
});

describe('applyChanges', () => {
  it('turns a cell into wall or into floor', () => {
    expect(
      applyChanges(['S..', '.#.'], [
        { cell: 2, to: '#' },
        { cell: 4, to: '.' },
      ]),
    ).toEqual(['S.#', '...']);
  });

  it('moves the start and leaves plain floor where it was', () => {
    expect(applyChanges(['S..', '.#.'], [{ cell: 5, to: 'S' }])).toEqual(['...', '.#S']);
  });

  it('can wall up the old start once the start has moved away', () => {
    expect(
      applyChanges(['S..', '.#.'], [
        { cell: 5, to: 'S' },
        { cell: 0, to: '#' },
      ]),
    ).toEqual(['#..', '.#S']);
  });

  it('gives back a copy and leaves the rows it was given alone', () => {
    const rows = ['S..', '.#.'];
    const same = applyChanges(rows, []);
    expect(same).toEqual(rows);
    expect(same).not.toBe(rows);
    applyChanges(rows, [{ cell: 1, to: '#' }]);
    expect(rows).toEqual(['S..', '.#.']);
  });
});

/** 照着改，改不成一张图（比如起点被墙盖掉了）就算不合格 */
function fineAfter(rows: readonly string[], changes: Repair['changes']): boolean {
  try {
    return fine(applyChanges(rows, changes));
  } catch {
    return false;
  }
}

/** 建议里的每一格都少不了：随便去掉哪一条，剩下的照着改完都不合格 */
function expectNothingSpare(rows: readonly string[], repair: Repair, label: string): void {
  repair.changes.forEach((_, skip) => {
    const rest = repair.changes.filter((_, i) => i !== skip);
    expect(fineAfter(rows, rest), `${label}，去掉第 ${skip + 1} 条`).toBe(false);
  });
}

/** 一条建议该有的样子：照着改完就是它给的那张图，那张图合格；同一格不改两次，起点最多挪一次，每一条都真的改了点什么 */
function expectProperRepair(rows: readonly string[], repair: Repair, label: string): void {
  const flat = rows.join('');
  const { changes } = repair;
  expect(fine(repair.rows), label).toBe(true);
  expect(sound(repair.rows), label).toBe(true);
  expect(applyChanges(rows, changes), label).toEqual(repair.rows);
  expect(changes.length, label).toBeGreaterThanOrEqual(1);
  expect(new Set(changes.map((change) => change.cell)).size, label).toBe(changes.length);
  const moves = changes.filter((change) => change.to === 'S');
  expect(moves.length, label).toBeLessThanOrEqual(1);
  for (const change of changes) {
    // 墙改成地面、地面改成墙、起点挪到另一格上
    if (change.to === '.') expect(flat[change.cell], label).toBe('#');
    else if (change.to === 'S') expect(flat[change.cell], label).not.toBe('S');
    else if (flat[change.cell] === 'S') expect(moves.length, label).toBe(1); // 原来的起点要改成墙，得先把起点挪走
    else expect(flat[change.cell], label).toBe('.');
  }
}

function blank(height: number, width: number): string[] {
  return Array.from({ length: height }, (_, r) => (r === 0 ? 'S' : '.') + '.'.repeat(width - 1));
}

describe('closestRepair: the careful search, six changes at most', () => {
  it('leaves a map that is already fine alone', () => {
    for (const i of [0, 7, 22, 40]) expect(closestRepair(LEVELS[i].rows)).toEqual({ changes: [], rows: [...LEVELS[i].rows] });
  });

  describe('on 300 random bad maps, 5×5 to 9×9', () => {
    /** 随机撒墙（一到四成）的图里不合格的那些，和各自得到的建议。下面几条都看它，只算一遍 */
    const cases: Array<{ rows: string[]; repair: Repair | null }> = [];

    beforeAll(() => {
      const rand = seeded(11);
      while (cases.length < 300) {
        const rows = randomMaze(rand, 5 + Math.floor(rand() * 5), 5 + Math.floor(rand() * 5), 0.1 + rand() * 0.3);
        // 本来就合格的跳过
        if (fine(rows)) continue;
        cases.push({ rows, repair: closestRepair(rows) });
      }
    }, 900_000);

    it('gives back a map that is sound, within six changes, never touching a cell twice', () => {
      let found = 0;
      for (const { rows, repair } of cases) {
        if (!repair) continue;
        found++;
        const label = rows.join('/');
        expectProperRepair(rows, repair, label);
        expect(repair.changes.length, label).toBeLessThanOrEqual(6);
        // 细找只把起点往原来就是地面的格子上挪
        for (const change of repair.changes) if (change.to === 'S') expect(rows.join('')[change.cell], label).toBe('.');
        expectNothingSpare(rows, repair, label);
      }
      // 至少一半找到了建议，否则上面等于没查
      expect(found).toBeGreaterThanOrEqual(150);
    });

    it('never changes more than one cell when one is enough (checked against trying every single change)', () => {
      let enough = 0;
      for (const { rows, repair } of cases) {
        const label = rows.join('/');
        const first = firstFixInOne(rows);
        if (first) {
          // 不光只改了一格，还得是试的顺序里最先合格的那一种：同一张图每次给的建议都一样
          expect(repair?.changes.length, label).toBe(1);
          expect(repair!.rows, label).toEqual(first);
          enough++;
        } else if (repair) {
          // 反过来也得对得上：穷举说一格不够，建议就不可能只改一格
          expect(repair.changes.length, label).toBeGreaterThanOrEqual(2);
        }
      }
      // 随机撒墙的坏图里"改一格就够"的不到一成，上面那 300 张里只有十几张。
      // 同样的造法再造 1000 张专门查这一条：只看第一层，用不了多少时间
      const rand = seeded(13);
      for (let made = 0; made < 1000; ) {
        const rows = randomMaze(rand, 5 + Math.floor(rand() * 5), 5 + Math.floor(rand() * 5), 0.1 + rand() * 0.3);
        if (fine(rows)) continue;
        made++;
        const label = rows.join('/');
        const first = firstFixInOne(rows);
        if (first) {
          const repair = closestRepair(rows);
          expect(repair?.changes.length, label).toBe(1);
          expect(repair!.rows, label).toEqual(first);
          expect(applyChanges(rows, repair!.changes), label).toEqual(first);
          enough++;
        } else {
          expect(closestRepair(rows, { maxChanges: 1 }), label).toBeNull();
        }
      }
      expect(enough).toBeGreaterThanOrEqual(60);
    });

    it('says so when nothing within the allowed number of changes helps', () => {
      const stubborn = cases.filter(({ rows }) => !fixableInOne(rows)).slice(0, 12);
      expect(stubborn).toHaveLength(12);
      for (const { rows } of stubborn) {
        expect(closestRepair(rows, { maxChanges: 1 }), rows.join('/')).toBeNull();
        expect(closestRepair(rows, { maxChanges: 0 }), rows.join('/')).toBeNull();
      }
    });
  });

  it('never changes more than two cells on a small map when two are enough', () => {
    const rand = seeded(12);
    let twoEnough = 0;
    for (const [height, width] of [
      [5, 5],
      [5, 6],
      [6, 6],
    ]) {
      for (let made = 0; made < 60; ) {
        const rows = randomMaze(rand, height, width, 0.1 + rand() * 0.3);
        if (fine(rows)) continue;
        made++;
        if (fixableInOne(rows)) continue;
        const label = rows.join('/');
        if (fixableInTwo(rows)) {
          expect(closestRepair(rows)?.changes.length, label).toBe(2);
          twoEnough++;
        } else {
          // 反过来：穷举说两格不够，那么只许改两格的时候就该说没有
          expect(closestRepair(rows, { maxChanges: 2 }), label).toBeNull();
        }
      }
    }
    expect(twoEnough).toBeGreaterThanOrEqual(20);
  }, 300_000);

  it('finds the only two cells that mend a corridor blocked in two places', () => {
    expect(closestRepair(TWO_GATES, { maxChanges: 1 })).toBeNull();
    const repair = closestRepair(TWO_GATES)!;
    expect([...repair.changes].sort((a, b) => a.cell - b.cell)).toEqual([
      { cell: 4, to: '.' },
      { cell: 36, to: '.' },
    ]);
    expect(repair.rows).toEqual(withCell(withCell(TWO_GATES, 4, '.'), 36, '.'));
  });

  it('repairs a built-in level after one of its cells has been spoilt', () => {
    for (const i of [4, 11, 19]) {
      const rows = LEVELS[i].rows;
      const flat = rows.join('');
      let spoilt = 0;
      for (let cell = 0; cell < flat.length; cell++) {
        if (flat[cell] !== '.') continue;
        // 把这格地面改成墙；图还合格的话这一格不算，换下一格
        const bad = withCell(rows, cell, '#');
        if (fine(bad)) continue;
        spoilt++;
        const repair = closestRepair(bad);
        const label = `第 ${i + 1} 关，第 ${cell} 格改成了墙`;
        // 改回去就行，所以建议不会超过一格
        expect(repair?.changes.length, label).toBe(1);
        expect(fine(repair!.rows), label).toBe(true);
      }
      expect(spoilt, `第 ${i + 1} 关`).toBeGreaterThan(0);
    }
  });

  it('never suggests walling up everything but the start', () => {
    // 只有起点和远处一格地面：把那一格改成墙会只剩一格地面，不算修好
    const repair = closestRepair(['S####', '#####', '####.', '#####', '#####']);
    expect(repair).not.toBeNull();
    expect(fine(repair!.rows)).toBe(true);
    expect(repair!.rows.join('').replaceAll('#', '').length).toBeGreaterThanOrEqual(2);
  });

  it('moves a start that is stranded on its own onto the rest of the floor and walls up where it was', () => {
    // 左上角一条拐弯的小走廊（0、1、2、5 四格），起点孤零零在右下角。把起点接到走廊上要打通四格墙；
    // 把起点挪到走廊上只算一格，但原来那格成了滚不到的地面，还得把它改成墙——两格，没有更省的改法
    const rows = ['...##', '.####', '#####', '#####', '####S'];
    expect(fixableInOne(rows)).toBe(false);
    const repair = closestRepair(rows)!;
    expect(repair.changes).toHaveLength(2);
    expect(repair.changes[0].to).toBe('S');
    expect([0, 1, 2, 5]).toContain(repair.changes[0].cell);
    expect(repair.changes[1]).toEqual({ cell: 24, to: '#' });
    expect(fine(repair.rows)).toBe(true);
    expect(applyChanges(rows, repair.changes)).toEqual(repair.rows);
  });

  it('opens a second cell for a map whose only floor is the start', () => {
    const repair = closestRepair(['S####', '#####', '#####', '#####', '#####']);
    expect(repair?.changes).toHaveLength(1);
    expect(repair!.changes[0].to).toBe('.');
    expect(fine(repair!.rows)).toBe(true);
  });

  it('gives up when it runs out of time', () => {
    // 钟每看一次就过去一秒：只给 1 毫秒的话，第一次看钟就该停手
    let clock = 0;
    let looks = 0;
    const racing = (): number => {
      looks++;
      return (clock += 1000);
    };
    expect(closestRepair(TWO_GATES, { maxMs: 1, now: racing })).toBeNull();
    expect(looks).toBeGreaterThanOrEqual(2);
    // 同一张图、同样只给 1 毫秒，钟不走的话照样找得到——停手确实是因为钟
    expect(closestRepair(TWO_GATES, { maxMs: 1, now: () => 0 })?.changes).toHaveLength(2);
  });

  it('answers within its time limit for a hand-drawn 15×15 with a few blocks, whether or not it finds anything', () => {
    // 手画的开阔大图：五块墙，起点在左上角。这样的图离合格很远（一百多格滚不到），六格以内多半修不好——
    // 这里要看的是：六层全部试完也用不了多久，而且万一给了建议，建议得是对的
    const rows = [
      'S..............',
      '...............',
      '..##...........',
      '..##.......#...',
      '...........#...',
      '...........#...',
      '...............',
      '.....###.......',
      '...............',
      '...............',
      '.#.............',
      '.#........##...',
      '..........##...',
      '...............',
      '...............',
    ];
    expect(fine(rows)).toBe(false);
    const began = Date.now();
    const repair = closestRepair(rows);
    const took = Date.now() - began;
    if (repair) {
      expect(fine(repair.rows)).toBe(true);
      expect(applyChanges(rows, repair.changes)).toEqual(repair.rows);
      expect(repair.changes.length).toBeLessThanOrEqual(6);
    }
    expect(took).toBeLessThan(30_000);
  }, 120_000);

  it('finds something for a 15×15 level of the game that has been spoilt in three places', () => {
    // 第 34 关：中间那条横道上多放一块墙（还和下面的墙只在角上相碰）、左下的空地上多放一块墙、竖着的那条墙顶上挖掉一格。
    // 图这么大，第二层起就不是穷举了，靠的是"只留离合格最近的那些"——这里核对它在大图上确实走得通
    let rows = [...LEVELS[33].rows];
    for (const [row, col, ch] of [
      [6, 7, '#'],
      [13, 3, '#'],
      [3, 4, '.'],
    ] as const) {
      expect(rows[row][col]).not.toBe(ch);
      rows = withCell(rows, row * 15 + col, ch);
    }
    expect(fine(rows)).toBe(false);
    expect(fixableInOne(rows)).toBe(false);
    const began = Date.now();
    const repair = closestRepair(rows);
    const took = Date.now() - began;
    expect(repair).not.toBeNull();
    expect(fine(repair!.rows)).toBe(true);
    expect(applyChanges(rows, repair!.changes)).toEqual(repair!.rows);
    expect(repair!.changes.length).toBeGreaterThanOrEqual(2);
    expect(repair!.changes.length).toBeLessThanOrEqual(6);
    expect(took).toBeLessThan(30_000);
  }, 120_000);
});

/** 每个 2×2 里墙都只在角上相碰，起点四面是墙 */
const CHECKERS = ['S#.#.', '#.#.#', '.#.#.', '#.#.#', '.#.#.'];

describe('suggestRepair: always an answer, however far the map is from sound', () => {
  it('leaves a map that is already fine alone', () => {
    for (const i of [0, 7, 22, 40]) expect(suggestRepair(LEVELS[i].rows)).toEqual({ changes: [], rows: [...LEVELS[i].rows] });
  });

  it('gives the careful answer whenever there is one', () => {
    const repair = suggestRepair(TWO_GATES);
    expect(repair.changes).toEqual([
      { cell: 4, to: '.' },
      { cell: 36, to: '.' },
    ]);
    expect(repair.rows).toEqual(withCell(withCell(TWO_GATES, 4, '.'), 36, '.'));

    const rand = seeded(17);
    let compared = 0;
    for (let made = 0; made < 40; ) {
      const rows = randomMaze(rand, 5 + Math.floor(rand() * 3), 5 + Math.floor(rand() * 3), 0.1 + rand() * 0.3);
      if (fine(rows)) continue;
      made++;
      const careful = closestRepair(rows);
      if (!careful) continue;
      expect(suggestRepair(rows), rows.join('/')).toEqual(careful);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(20);
  });

  describe('on maps far beyond six changes: big blank boards, dense scribbles, walls touching at every corner', () => {
    const cases: Array<{ name: string; rows: string[]; repair: Repair; took: number }> = [];

    beforeAll(() => {
      const maps: Array<[string, string[]]> = [
        ['blank 15×15', blank(15, 15)],
        ['blank 17×23', blank(17, 23)],
        ['blank 23×17', blank(23, 17)],
        ['checkers', CHECKERS],
      ];
      const rand = seeded(31);
      while (maps.length < 12) {
        const height = 5 + Math.floor(rand() * 13);
        const width = 5 + Math.floor(rand() * 19);
        const rows = randomMaze(rand, height, width, rand() * 0.6);
        if (!fine(rows)) maps.push([`random ${height}×${width} #${maps.length}`, rows]);
      }
      for (const [name, rows] of maps) {
        const began = Date.now();
        const repair = suggestRepair(rows);
        cases.push({ name, rows, repair, took: Date.now() - began });
      }
    }, 900_000);

    it('answers every one of them with a map that is sound', () => {
      expect(cases).toHaveLength(12);
      for (const { name, rows, repair } of cases) {
        expect(repair, name).not.toBeNull();
        expectProperRepair(rows, repair, name);
      }
    });

    it('had to change more than six cells for most of them', () => {
      // 不然上面那一条查的还是细找的本事，不是"六格以外也拿得出改法"
      expect(cases.filter(({ repair }) => repair !== null && repair.changes.length > 6).length).toBeGreaterThanOrEqual(8);
    });

    it('leaves out every change it could do without', () => {
      for (const { name, rows, repair } of cases) expectNothingSpare(rows, repair, name);
    });

    it('takes seconds, not minutes, even on the biggest board', () => {
      for (const { name, took } of cases) expect(took, name).toBeLessThan(30_000);
    });
  });

  it('still answers when its time was up before it began', () => {
    // 钟每看一次就过去一千秒：细找、快找都来不及，只剩不用搜的保底造法
    let looks = 0;
    for (const rows of [TWO_GATES, blank(9, 9), CHECKERS, ['S####', '#####', '#####', '#####', '#####'], ['...##', '.####', '#####', '#####', '####S']]) {
      let clock = 0;
      const racing = (): number => {
        looks++;
        return (clock += 1_000_000);
      };
      const repair = suggestRepair(rows, { maxMs: 1, now: racing });
      expectProperRepair(rows, repair, rows.join('/'));
    }
    expect(looks).toBeGreaterThanOrEqual(10);
    // 时限是当真的：钟不走的时候 TWO_GATES 只改两格（见上），来不及的时候顾不上找这么省的
    let clock = 0;
    expect(suggestRepair(TWO_GATES, { maxMs: 1, now: () => (clock += 1_000_000) }).changes.length).toBeGreaterThan(2);
  });
});
