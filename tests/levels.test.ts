import { describe, expect, it } from 'vitest';
import { parseLevel, type Dir } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { isDone, newGame, roll, steps } from '../src/game/rules.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { analyze } from '../src/game/solver.ts';
import { traceFloor } from '../src/view/outline.ts';

const size = (i: number): [rows: number, cols: number] => [LEVELS[i].rows.length, LEVELS[i].rows[0].length];

describe('the level set', () => {
  it('has 80 levels', () => {
    expect(LEVELS).toHaveLength(80);
  });

  it('has no level twice', () => {
    const seen = new Set(LEVELS.map((def) => def.rows.join('/')));
    expect(seen.size).toBe(LEVELS.length);
  });

  it('never gets smaller or needs fewer steps from one level to the next', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      const [rows, cols] = size(i);
      const [prevRows, prevCols] = size(i - 1);
      expect(rows, `第 ${i + 1} 关的行数`).toBeGreaterThanOrEqual(prevRows);
      expect(cols, `第 ${i + 1} 关的列数`).toBeGreaterThanOrEqual(prevCols);
      expect(LEVELS[i].par, `第 ${i + 1} 关的最少步数`).toBeGreaterThanOrEqual(LEVELS[i - 1].par);
    }
  });

  it('starts with a few steps on a small board and ends with well over a hundred on a big one', () => {
    expect(size(0)).toEqual([5, 5]);
    expect(LEVELS[0].par).toBeLessThanOrEqual(4);
    expect(size(LEVELS.length - 1)).toEqual([23, 17]);
    expect(LEVELS[LEVELS.length - 1].par).toBeGreaterThanOrEqual(140);
  });

  it('goes from 5×5 up to 10×10 in the first 30 levels, is 15×15 from level 31, and rectangular from level 51', () => {
    LEVELS.forEach((_, i) => {
      const [rows, cols] = size(i);
      const where = `第 ${i + 1} 关`;
      if (i < 30) {
        expect(rows, where).toBe(cols);
        expect(rows, where).toBeLessThanOrEqual(10);
      } else if (i < 50) {
        expect([rows, cols], where).toEqual([15, 15]);
      } else if (i < 60) {
        expect([rows, cols], where).toEqual([19, 15]);
      } else if (i < 70) {
        expect([rows, cols], where).toEqual([21, 15]);
      } else {
        expect([rows, cols], where).toEqual([23, 17]);
      }
    });
  });

  it('needs more steps in every rectangular level than in any square one', () => {
    for (let i = 50; i < LEVELS.length; i++) expect(LEVELS[i].par, `第 ${i + 1} 关`).toBeGreaterThan(LEVELS[49].par);
  });

  it('still has the first 50 levels exactly as they were before levels 51 to 80 were added', () => {
    // 玩家存着的最好成绩是按这 50 关记的，所以它们一格都不能变。重新生成关卡后这里要是不过，
    // 说明前 50 关被换掉了（比如正方形的候选或者挑选的办法被动过）。
    const text = JSON.stringify(LEVELS.slice(0, 50));
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    expect((hash >>> 0).toString(16)).toBe('34d9a00c');
  });
});

describe.each(LEVELS.map((def, i) => ({ def, number: i + 1 })))('level $number', ({ def }) => {
  const level = parseLevel(def.rows);

  it('is a board the tray can be built for', () => {
    expect(level.rows).toBeGreaterThanOrEqual(5);
    expect(level.rows).toBeLessThanOrEqual(23);
    // 长方形的关卡存的时候竖着放（行比列多）；游戏里按屏幕的横竖决定要不要翻过来
    expect(level.rows).toBeGreaterThanOrEqual(level.cols);
    expect(hasPinch(level.floor, level.rows, level.cols)).toBe(false);
    expect(floorConnected(level.floor, level.rows, level.cols)).toBe(true);
    expect(traceFloor(level).outer.length).toBeGreaterThanOrEqual(4);
  });

  it('comes with a route that really finishes it in that many steps', () => {
    const game = newGame(level);
    for (const ch of def.solution) expect(roll(game, ch as Dir)).not.toBeNull();
    expect(isDone(game)).toBe(true);
    expect(steps(game)).toBe(def.par);
  });

});

// 前 50 关（正方形）的最少步数由求解器来查。51 关起的长方形大图求解器搜不动，
// 它们在 levels-51.test.ts 等几个文件里用整数规划来查。
describe.each(LEVELS.slice(0, 50).map((def, i) => ({ def, number: i + 1 })))('level $number', ({ def }) => {
  it('can be finished, cannot trap the player, and its stated fewest steps is right', () => {
    const a = analyze(parseLevel(def.rows), 20_000_000);
    expect(a.solvable).toBe(true);
    expect(a.safe).toBe(true);
    expect(def.par).toBe(a.par);
  });
});
