// 大图上"最少几步"用的是另一种算法（tools/mip.ts，整数规划）。它和求解器走的是完全不同的两条路，
// 这里把两边的答案逐一对一遍：对得上，才敢把只有它算得动的那些大图的最少步数标出去。
import { describe, expect, it } from 'vitest';
import { parseLevel, transposeDef, type Dir, type Level } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { isDone, newGame, roll, steps } from '../src/game/rules.ts';
import { analyze } from '../src/game/solver.ts';
import { carve, mend } from '../tools/gen.ts';
import { shortestTour } from '../tools/mip.ts';
import { bruteForce } from './helpers/brute.ts';
import { randomMaze, seeded } from './helpers/random.ts';

/** 照着走一遍：每一步都必须真的滚动了，走完必须正好通关。返回用了几步。 */
function replay(level: Level, solution: string): number {
  const game = newGame(level);
  for (const ch of solution) expect(roll(game, ch as Dir)).not.toBeNull();
  expect(isDone(game)).toBe(true);
  return steps(game);
}

describe('shortestTour: the fewest steps, worked out as an integer programme', () => {
  it('needs no steps when the start is the only cell, and one for a straight corridor', () => {
    expect(shortestTour(parseLevel(['S']))).toMatchObject({ par: 0, solution: '' });
    expect(shortestTour(parseLevel(['S...']))).toMatchObject({ par: 1, solution: 'R' });
  });

  it('goes back the way it came when a dead-end branch has to be dyed first', () => {
    const level = parseLevel(['.#.#', '.S.#', '##.#']);
    const tour = shortestTour(level)!;
    expect(tour.par).toBe(6);
    expect(replay(level, tour.solution)).toBe(6);
  });

  it('says so when a maze cannot be finished', () => {
    // 小球只会在第一行两头之间来回，停不到中间那一列的上方
    expect(shortestTour(parseLevel(['S..', '#.#', '#.#']))).toBeNull();
  });

  it('agrees with trying every possible game on a few hundred small random mazes', () => {
    const rand = seeded(8);
    let solvable = 0;
    let unsolvable = 0;
    for (let i = 0; i < 300; i++) {
      const rows = 3 + Math.floor(rand() * 4);
      const cols = 3 + Math.floor(rand() * 5);
      const maze = randomMaze(rand, rows, cols, 0.12 + rand() * 0.3);
      const level = parseLevel(maze);
      const brute = bruteForce(level);
      const tour = shortestTour(level);
      expect(tour?.par ?? -1, maze.join('/')).toBe(brute.par);
      if (tour) {
        expect(replay(level, tour.solution), maze.join('/')).toBe(brute.par);
        solvable++;
      } else {
        unsolvable++;
      }
    }
    // 两种情况都得真的碰到过，不然上面等于没比
    expect(solvable).toBeGreaterThan(60);
    expect(unsolvable).toBeGreaterThan(60);
  });

  it('agrees with the solver on carved mazes from 8×8 to 12×16, square or not', () => {
    const rand = seeded(53);
    let compared = 0;
    let longest = 0;
    for (let i = 0; i < 90; i++) {
      const rows = 8 + (i % 5);
      const cols = 8 + (i % 9);
      const made = carve(rand, rows, cols, 12 + Math.floor(rand() * 60), i % 4);
      if (!made) continue;
      const level = parseLevel(made.rows);
      const a = analyze(level, 6_000_000);
      const tour = shortestTour(level);
      expect(tour?.par ?? -1, made.rows.join('/')).toBe(a.par);
      if (tour) expect(replay(level, tour.solution)).toBe(a.par);
      compared++;
      longest = Math.max(longest, a.par);
    }
    expect(compared).toBeGreaterThan(70);
    expect(longest).toBeGreaterThan(25);
  }, 300_000);

  it('agrees with the solver on open boards made by placing blocks (12×12 and 10×14)', () => {
    const rand = seeded(54);
    let compared = 0;
    let longest = 0;
    for (let i = 0; i < 4000 && compared < 16; i++) {
      const [rows, cols] = i % 2 ? [12, 12] : [10, 14];
      const made = mend(rand, rows, cols, Math.round(12 * (0.7 + rand() * 2)), i % 3 === 0);
      if (!made) continue;
      const level = parseLevel(made);
      const a = analyze(level, 20_000_000);
      const tour = shortestTour(level)!;
      expect(tour.par, made.join('/')).toBe(a.par);
      expect(replay(level, tour.solution)).toBe(a.par);
      compared++;
      longest = Math.max(longest, a.par);
    }
    expect(compared).toBe(16);
    expect(longest).toBeGreaterThan(40);
  }, 300_000);

  it('agrees with the solver on the 15×15 levels of the game', () => {
    for (let i = 30; i < 50; i++) {
      const tour = shortestTour(parseLevel(LEVELS[i].rows))!;
      expect(tour.par, `第 ${i + 1} 关`).toBe(LEVELS[i].par);
    }
  }, 300_000);

  it('finds nothing shorter when asked for a route one step below the fewest', () => {
    for (const i of [12, 27, 33, 44]) {
      const level = parseLevel(LEVELS[i].rows);
      expect(shortestTour(level, { atMost: LEVELS[i].par - 1 }), `第 ${i + 1} 关`).toBeNull();
      expect(shortestTour(level, { atMost: LEVELS[i].par })?.par, `第 ${i + 1} 关`).toBe(LEVELS[i].par);
    }
  });

  it('still agrees when it may only use the rarer of its two ways of forcing the route to be in one piece', () => {
    // 平时几乎总是第一种条件就够了，第二种只在很大的图上偶尔用到；这里逼它只用第二种，和别的办法对答案
    const rand = seeded(77);
    let viaForced = 0;
    for (let i = 0; i < 120; i++) {
      const maze = randomMaze(rand, 3 + Math.floor(rand() * 4), 3 + Math.floor(rand() * 5), 0.12 + rand() * 0.3);
      const level = parseLevel(maze);
      const tour = shortestTour(level, { forcedOnly: true });
      expect(tour?.par ?? -1, maze.join('/')).toBe(bruteForce(level).par);
      if (tour && tour.forced > 0) viaForced++;
    }
    for (let i = 0; i < 40; i++) {
      const made = carve(rand, 8 + (i % 4), 8 + (i % 6), 12 + Math.floor(rand() * 50), i % 4);
      if (!made) continue;
      const level = parseLevel(made.rows);
      const tour = shortestTour(level, { forcedOnly: true });
      expect(tour?.par ?? -1, made.rows.join('/')).toBe(analyze(level, 6_000_000).par);
      if (tour && tour.forced > 0) viaForced++;
    }
    // 得真的用上过才算数
    expect(viaForced).toBeGreaterThan(30);
  }, 300_000);

  it('gives the same answer whatever random seed the search inside is given', () => {
    const level = parseLevel(LEVELS[41].rows);
    for (const seed of [1, 2, 3]) expect(shortestTour(level, { seed })!.par).toBe(LEVELS[41].par);
  });
});

describe('a level turned over its diagonal', () => {
  it('turns back into itself when turned twice', () => {
    for (const def of [LEVELS[0], LEVELS[17], LEVELS[LEVELS.length - 1]]) {
      expect(transposeDef(transposeDef(def))).toEqual({ rows: [...def.rows], par: def.par, solution: def.solution });
    }
  });

  it('swaps rows and columns', () => {
    const turned = transposeDef({ rows: ['S.#', '...'], par: 2, solution: 'RD' });
    expect(turned.rows).toEqual(['S.', '..', '#.']);
    expect(turned.solution).toBe('DR');
  });

  it('is finished by the turned route in the same number of steps (every level of the game)', () => {
    LEVELS.forEach((def, i) => {
      const turned = transposeDef(def);
      expect(replay(parseLevel(turned.rows), turned.solution), `第 ${i + 1} 关`).toBe(def.par);
    });
  });

  it('needs exactly as many steps as before', () => {
    for (const i of [8, 22, 36]) {
      expect(analyze(parseLevel(transposeDef(LEVELS[i]).rows), 20_000_000).par, `第 ${i + 1} 关`).toBe(LEVELS[i].par);
    }
  });
});
