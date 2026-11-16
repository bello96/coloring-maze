import { describe, expect, it } from 'vitest';
import { parseLevel, type Dir } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { isDone, newGame, roll, steps } from '../src/game/rules.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { analyze } from '../src/game/solver.ts';

describe('the level set', () => {
  it('has 50 levels', () => {
    expect(LEVELS).toHaveLength(50);
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
    expect(last.rows.length).toBe(15);
    expect(last.par).toBeGreaterThanOrEqual(60);
  });

  it('goes from 5×5 up to 10×10 in the first 30 levels, and is 15×15 from level 31 on', () => {
    LEVELS.forEach((def, i) => {
      if (i < 30) expect(def.rows.length, `第 ${i + 1} 关`).toBeLessThanOrEqual(10);
      else expect(def.rows.length, `第 ${i + 1} 关`).toBe(15);
    });
  });

  it('still has the first 30 levels exactly as they were before levels 31 to 50 were added', () => {
    // 玩家存着的最好成绩是按这 30 关记的，所以它们一格都不能变。重新生成关卡后这里要是不过，
    // 说明前 30 关被换掉了（比如 5×5 到 10×10 的候选或者挑选的办法被动过）。
    const text = JSON.stringify(LEVELS.slice(0, 30));
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    expect((hash >>> 0).toString(16)).toBe('ded424e1');
  });
});

describe.each(LEVELS.map((def, i) => ({ def, name: `level ${i + 1}` })))('$name', ({ def }) => {
  const level = parseLevel(def.rows);

  it('is a square board the tray can be built for', () => {
    expect(level.rows).toBe(level.cols);
    expect(level.rows).toBeGreaterThanOrEqual(5);
    expect(level.rows).toBeLessThanOrEqual(15);
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
