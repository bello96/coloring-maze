import { describe, expect, it } from 'vitest';
import { parseLevel, type Dir } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { isDone, newGame, roll, steps } from '../src/game/rules.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { analyze } from '../src/game/solver.ts';

describe('the level set', () => {
  it('has 30 levels', () => {
    expect(LEVELS).toHaveLength(30);
  });

  it('has no level twice', () => {
    const seen = new Set(LEVELS.map((def) => def.rows.join('/')));
    expect(seen.size).toBe(LEVELS.length);
  });

  it('never gets smaller or needs fewer steps from one level to the next', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].rows.length, `第 ${i + 1} 关的尺寸`).toBeGreaterThanOrEqual(LEVELS[i - 1].rows.length);
      expect(LEVELS[i].par, `第 ${i + 1} 关的最少步数`).toBeGreaterThanOrEqual(LEVELS[i - 1].par);
    }
  });

  it('starts with a few steps on a small board and ends with dozens on a big one', () => {
    const first = LEVELS[0];
    const last = LEVELS[LEVELS.length - 1];
    expect(first.rows.length).toBe(5);
    expect(first.par).toBeLessThanOrEqual(4);
    expect(last.rows.length).toBe(10);
    expect(last.par).toBeGreaterThanOrEqual(30);
  });
});

describe.each(LEVELS.map((def, i) => ({ def, name: `level ${i + 1}` })))('$name', ({ def }) => {
  const level = parseLevel(def.rows);

  it('is a square board the tray can be built for', () => {
    expect(level.rows).toBe(level.cols);
    expect(level.rows).toBeGreaterThanOrEqual(5);
    expect(level.rows).toBeLessThanOrEqual(10);
    expect(hasPinch(level.floor, level.rows, level.cols)).toBe(false);
    expect(floorConnected(level.floor, level.rows, level.cols)).toBe(true);
  });

  it('can be finished, cannot trap the player, and its stated fewest steps is right', () => {
    const a = analyze(level, 20_000_000);
    expect(a.solvable).toBe(true);
    expect(a.safe).toBe(true);
    expect(def.par).toBe(a.par);
  });

  it('comes with a route that really finishes it in that many steps', () => {
    const game = newGame(level);
    for (const ch of def.solution) expect(roll(game, ch as Dir)).not.toBeNull();
    expect(isDone(game)).toBe(true);
    expect(steps(game)).toBe(def.par);
  });
});
