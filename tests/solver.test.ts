import { describe, expect, it } from 'vitest';
import { parseLevel, type Dir, type Level } from '../src/game/level.ts';
import { isDone, newGame, roll, steps } from '../src/game/rules.ts';
import { analyze, shortfall, SolverLimitError, type Engine } from '../src/game/solver.ts';
import { carve } from '../tools/gen.ts';
import { bruteForce } from './helpers/brute.ts';
import { randomMaze, seeded } from './helpers/random.ts';

/** 照着走一遍：每一步都必须真的滚动了，走完必须正好通关。返回用了几步。 */
function replay(level: Level, solution: string): number {
  const game = newGame(level);
  for (const ch of solution) {
    expect('URDL').toContain(ch);
    expect(roll(game, ch as Dir)).not.toBeNull();
  }
  expect(isDone(game)).toBe(true);
  return steps(game);
}

describe('analyze: the fewest steps', () => {
  it('needs no steps when the start is the only cell', () => {
    const a = analyze(parseLevel(['S']));
    expect(a.solvable).toBe(true);
    expect(a.par).toBe(0);
    expect(a.solution).toBe('');
  });

  it('needs one step for a straight corridor', () => {
    const a = analyze(parseLevel(['S...']));
    expect(a.par).toBe(1);
    expect(a.solution).toBe('R');
  });

  it('finds the 6-step route through the small maze', () => {
    // 手算：下、右、上、左、上、左 六步染完；五步不够
    //    0  1  2  #
    //    4  #  6  7
    //    8  9 10 11
    const level = parseLevel(['S..#', '.#..', '....']);
    const a = analyze(level);
    expect(a.solvable).toBe(true);
    expect(a.par).toBe(6);
    expect(replay(level, a.solution)).toBe(6);
  });

  it('goes back the way it came when a dead-end branch has to be dyed first', () => {
    // 必须先左、上、下染完左边那一列，再往右；先往右就回不来了
    const level = parseLevel(['.#.#', '.S.#', '##.#']);
    const a = analyze(level);
    expect(a.par).toBe(6);
    expect(replay(level, a.solution)).toBe(6);
    expect(a.solution.startsWith('LUDR')).toBe(true);
  });
});

describe('analyze: mazes that cannot be finished', () => {
  it('says so when the ball can never stop where a side branch begins', () => {
    // 小球只会在第一行两头之间来回，停不到中间那一列的上方
    const a = analyze(parseLevel(['S..', '#.#', '#.#']));
    expect(a.solvable).toBe(false);
    expect(a.par).toBe(-1);
    expect(a.solution).toBe('');
  });

  it('says so when every cell can be reached, but not all in one game', () => {
    // 十字形：从中间出发，选了横向就只能横着来回，选了竖向就只能竖着来回
    const a = analyze(parseLevel(['#.#', '.S.', '#.#']));
    expect(a.solvable).toBe(false);
  });

  it('says so for the maze in the reference video', () => {
    // 参考视频里的那一关：中间 2 格、右边 3 格永远滚不到
    const a = analyze(parseLevel(['S......', '#......', '.....##', '.......', '......#', '..#....', '.......']));
    expect(a.solvable).toBe(false);
  });
});

describe('analyze: can the player get stuck', () => {
  it('is safe when the ball can always get back to everywhere', () => {
    expect(analyze(parseLevel(['S..#', '.#..', '....'])).safe).toBe(true);
  });

  it('is not safe when a wrong turn leaves cells that can no longer be reached', () => {
    const a = analyze(parseLevel(['.#.#', '.S.#', '##.#']));
    expect(a.solvable).toBe(true);
    expect(a.safe).toBe(false);
  });

  it('is safe when the only place the ball cannot return to is where it started', () => {
    // 从左边滚进竖道后再也回不到起点，但起点开局就染好了，不碍事
    const a = analyze(parseLevel(['#.#', 'S.#', '#.#']));
    expect(a.solvable).toBe(true);
    expect(a.par).toBe(3);
    expect(a.safe).toBe(true);
  });

  it('is never called safe when it cannot be finished at all', () => {
    expect(analyze(parseLevel(['#.#', '.S.', '#.#'])).safe).toBe(false);
  });
});

describe('analyze agrees with trying every possible game', () => {
  const cases: Array<{ rows: number; cols: number; wall: number; count: number; seed: number }> = [
    // 随机撒墙的迷宫大多通不了关（越大越少），所以每组都要生成几百个，才能两种都凑够
    { rows: 3, cols: 4, wall: 0.2, count: 300, seed: 11 },
    { rows: 4, cols: 4, wall: 0.25, count: 400, seed: 12 },
    { rows: 4, cols: 5, wall: 0.25, count: 500, seed: 13 },
    { rows: 5, cols: 5, wall: 0.25, count: 600, seed: 14 },
    { rows: 5, cols: 6, wall: 0.25, count: 700, seed: 15 },
    // 大一些的迷宫要搜几万到几十万个局面，求解器内部的表会扩容好几次，这一组专门核对那种情况
    { rows: 7, cols: 7, wall: 0.2, count: 1200, seed: 22 },
  ];

  for (const c of cases) {
    it(`${c.count} random ${c.rows}×${c.cols} mazes`, () => {
      const rand = seeded(c.seed);
      let solvable = 0;
      let unsolvable = 0;
      let longest = 0;
      for (let i = 0; i < c.count; i++) {
        const rows = randomMaze(rand, c.rows, c.cols, c.wall);
        const level = parseLevel(rows);
        const truth = bruteForce(level);
        const a = analyze(level);
        const label = rows.join('/');
        expect(a.par, label).toBe(truth.par);
        expect(a.solvable, label).toBe(truth.par >= 0);
        if (truth.par >= 0) {
          expect(replay(level, a.solution), label).toBe(truth.par);
          solvable++;
          longest = Math.max(longest, truth.par);
        } else {
          unsolvable++;
        }
        // "safe" 是一个保证：说了安全，就必须真的没有死局
        if (a.safe) expect(truth.canGetStuck, label).toBe(false);
        // 另外两种搜法也得是同一个答案：一层层全搜的老办法；关键格三个一组的 A*（组小、下界松，各组之间怎么配合才用得上）
        for (const other of [analyze(level, 4_000_000, 'breadth'), analyze(level, 4_000_000, 'guided', 3)]) {
          expect(other.par, label).toBe(truth.par);
          if (truth.par >= 0) expect(replay(level, other.solution), label).toBe(truth.par);
          expect(other.safe, label).toBe(a.safe);
          expect(other.stops, label).toBe(a.stops);
        }
        // 生成器用的"离不会困死还差多少"：差 0 和 safe 是一回事
        expect(shortfall(level) === 0, label).toBe(a.safe);
      }
      // 两种迷宫都得有足够多，这个核对才有意义
      expect(solvable).toBeGreaterThan(20);
      expect(unsolvable).toBeGreaterThan(20);
      expect(longest).toBeGreaterThan(5);
    });
  }
});

describe('analyze: mazes where the ball can stop in 33 or more places', () => {
  // 一层层全搜的那种搜法把"停在哪"和一半的关键格挤在同一个 32 位整数里，停靠点到第 33 个时会用到符号位。
  // 随机迷宫里这样的极少（五十万个里十几个），所以把找到的几个固定下来。
  // 每个的最少步数都是用穷举法（tests/helpers/brute.ts）算出来的。
  const cases: Array<{ rows: string[]; par: number; stops: number }> = [
    { rows: ['..#...#', '#......', 'S.##...', '#....#.', '..#...#', '....#..', '...#...'], par: 32, stops: 33 },
    { rows: ['....#......#.', '.......#.S...', '#....#..#....', '...#....#.##.'], par: 32, stops: 33 },
    { rows: ['...#......', '.....S...#', '#...#..#..', '..#..#....', '..#..#..#.'], par: 30, stops: 35 },
    { rows: ['...#....#....', '.....S...#...', '............#', '..#....##....'], par: 24, stops: 33 },
    { rows: ['.....##.', '...#....', '#....#..', '..#....#', '...##.S.', '...#...#'], par: 28, stops: 33 },
    { rows: ['....#..', '...#...', '#....#.', '..#...#', '.......', '.....S.', '.#.....'], par: 26, stops: 33 },
    { rows: ['......#.....#', '#.#........#.', '#......#.S...', '...#........#'], par: 24, stops: 33 },
    { rows: ['..#...#...', '...#.....#', '.....#....', '..S.......', '....#.....'], par: 25, stops: 33 },
  ];

  it.each(cases)('finds the $par-step route through $rows', ({ rows, par, stops }) => {
    const level = parseLevel(rows);
    for (const engine of ['guided', 'breadth'] satisfies Engine[]) {
      const a = analyze(level, 4_000_000, engine);
      expect(a.stops).toBe(stops);
      expect(a.par).toBe(par);
      expect(replay(level, a.solution)).toBe(par);
    }
  });

  it.each(cases.slice(0, 4))('agrees with trying every possible game on $rows', ({ rows, par }) => {
    const level = parseLevel(rows);
    const truth = bruteForce(level, 600_000);
    expect(truth.par).toBe(par);
    expect(analyze(level).safe && truth.canGetStuck).toBe(false);
  });
});

describe('analyze: the two ways of searching agree on mazes too big to try every game', () => {
  it('on a few hundred carved 10×10 to 12×12 mazes', () => {
    const rand = seeded(31);
    let compared = 0;
    let longest = 0;
    for (let i = 0; i < 400; i++) {
      const n = 10 + (i % 3);
      const made = carve(rand, n, 10 + Math.floor(rand() * 30), i % 4);
      if (!made) continue;
      const level = parseLevel(made.rows);
      const label = made.rows.join('/');
      let slow;
      try {
        slow = analyze(level, 1_000_000, 'breadth');
      } catch (err) {
        // 关键格太多或者局面太多，老办法算不动的就不比了
        if (!(err instanceof SolverLimitError)) throw err;
        continue;
      }
      // 凿出来的迷宫照着凿的顺序走一定能通关
      expect(slow.solvable, label).toBe(true);
      expect(slow.par, label).toBeLessThanOrEqual(made.route.length);
      for (const groupSize of [16, 5]) {
        const fast = analyze(level, 1_000_000, 'guided', groupSize);
        expect(fast.par, label).toBe(slow.par);
        expect(replay(level, fast.solution), label).toBe(slow.par);
        expect(fast.safe, label).toBe(slow.safe);
      }
      compared++;
      longest = Math.max(longest, slow.par);
    }
    expect(compared).toBeGreaterThan(200);
    expect(longest).toBeGreaterThan(20);
  });
});

describe('analyze: 15×15 mazes', () => {
  // 这么大的图只有 guided 算得动，没有别的办法可以核对答案。能核对的是：关键格分成大小不同的组，
  // 得到的下界完全不同，搜到的最少步数却必须一样。下面的步数就是这样两边对上的。
  const cases: Array<{ name: string; rows: string[]; par: number; stops: number }> = [
    {
      name: 'a carved maze',
      rows: ['#############..', '##########.....', '#......##.....#', '#.####.....####', '...###.......##', '.............##', '#...##.#...#...', '#...##.#...##..', '.......#......#', '....##.#..###.#', '....##.#.......', 'S.........###..', '.#.............', '..........#####', '....#####..####'],
      par: 42,
      stops: 45,
    },
    {
      name: 'an open board',
      rows: ['#........######', '#..########....', '.....##.....##.', '.#.......#...#.', '.#...#.#.#...#.', '.#####.#.#...#.', '.....#.#.##..##', '##...........##', '##..##.#.#.....', '.#...#.#.#####.', '.#...#.#.#...#.', '.#S..#.......#.', '.##.....##.....', '....########..#', '######........#'],
      par: 58,
      stops: 58,
    },
    {
      name: 'an open board where the ball can stop in 79 places',
      rows: ['..#.....##.....', '....#......####', '.#.##.#######.#', '.#....#######..', '.###.......#...', '..#....###.###.', '#.##.#.#.###...', '#.............#', '...###.#.#.##.#', '.###.###....#..', '...#.......###.', '..#######....#.', '#.#######.##.#.', '####......#....', '.....##...S.#..'],
      par: 80,
      stops: 79,
    },
  ];

  it.each(cases)('finds the $par-step route through $name', ({ rows, par, stops }) => {
    const level = parseLevel(rows);
    for (const groupSize of [16, 12]) {
      const a = analyze(level, 4_000_000, 'guided', groupSize);
      expect(a.stops).toBe(stops);
      expect(a.par).toBe(par);
      expect(replay(level, a.solution)).toBe(par);
      expect(a.safe).toBe(true);
    }
  });

  it.each(cases)('is more than searching layer by layer can handle: $name', ({ rows }) => {
    expect(() => analyze(parseLevel(rows), 4_000_000, 'breadth')).toThrow(SolverLimitError);
  });

  it('gives up once it has searched as many positions as it was allowed', () => {
    expect(() => analyze(parseLevel(cases[1].rows), 200)).toThrow(SolverLimitError);
  });

  it('refuses a group size it has no table for', () => {
    expect(() => analyze(parseLevel(cases[0].rows), 4_000_000, 'guided', 17)).toThrow(RangeError);
    expect(() => analyze(parseLevel(cases[0].rows), 4_000_000, 'guided', 0)).toThrow(RangeError);
  });
});
