import { describe, expect, it } from 'vitest';
import { parseLevel } from '../src/game/level.ts';
import { isDone, newGame, roll, slide, steps, undo } from '../src/game/rules.ts';

/**
 * 测试用的小迷宫（3 行 4 列），格子编号 = 行 × 4 + 列：
 *
 *    0  1  2  #
 *    4  #  6  7
 *    8  9 10 11
 */
const SMALL = ['S..#', '.#..', '....'];

describe('parseLevel', () => {
  it('reads the size, the floor cells and where the ball starts', () => {
    const level = parseLevel(SMALL);
    expect(level.rows).toBe(3);
    expect(level.cols).toBe(4);
    expect(level.start).toBe(0);
    expect(level.floorCount).toBe(10);
    expect(Array.from(level.floor)).toEqual([1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1]);
  });

  it('finds a start that is not in the first cell', () => {
    expect(parseLevel(['..#', '.S.']).start).toBe(4);
  });

  it('rejects rows of different lengths', () => {
    expect(() => parseLevel(['S..', '....'])).toThrow();
  });

  it('rejects a maze with no start', () => {
    expect(() => parseLevel(['...', '.#.'])).toThrow();
  });

  it('rejects a maze with two starts', () => {
    expect(() => parseLevel(['S..', '..S'])).toThrow();
  });

  it('rejects characters it does not know', () => {
    expect(() => parseLevel(['S.x'])).toThrow();
  });
});

describe('slide', () => {
  const level = parseLevel(SMALL);

  it('keeps going until the next cell is a wall', () => {
    expect(slide(level, 0, 'R')).toEqual({ to: 2, path: [1, 2] });
  });

  it('keeps going until the edge of the board', () => {
    expect(slide(level, 0, 'D')).toEqual({ to: 8, path: [4, 8] });
    expect(slide(level, 8, 'R')).toEqual({ to: 11, path: [9, 10, 11] });
  });

  it('does not wrap around from the end of one row into the next', () => {
    // 7 号格在最右一列；往右是棋盘外面，不是下一行的 8 号格
    expect(slide(level, 7, 'R')).toEqual({ to: 7, path: [] });
    expect(slide(level, 4, 'L')).toEqual({ to: 4, path: [] });
  });

  it('stays put when a wall is right next to the ball', () => {
    expect(slide(level, 0, 'L')).toEqual({ to: 0, path: [] });
    expect(slide(level, 0, 'U')).toEqual({ to: 0, path: [] });
    expect(slide(level, 4, 'R')).toEqual({ to: 4, path: [] });
  });

  it('stops under a wall when rolling up', () => {
    expect(slide(level, 11, 'U')).toEqual({ to: 7, path: [7] });
    expect(slide(level, 10, 'U')).toEqual({ to: 2, path: [6, 2] });
  });
});

describe('a game', () => {
  it('starts with only the starting cell dyed and no steps taken', () => {
    const game = newGame(parseLevel(SMALL));
    expect(game.pos).toBe(0);
    expect(Array.from(game.dyed)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(game.dyedCount).toBe(1);
    expect(steps(game)).toBe(0);
    expect(isDone(game)).toBe(false);
  });

  it('dyes every cell the ball rolls over and counts one step per roll', () => {
    const game = newGame(parseLevel(SMALL));
    const move = roll(game, 'R');
    expect(move).toEqual({ dir: 'R', from: 0, to: 2, path: [1, 2], fresh: [1, 2] });
    expect(game.pos).toBe(2);
    expect(Array.from(game.dyed)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(game.dyedCount).toBe(3);
    expect(steps(game)).toBe(1);
  });

  it('counts a roll over cells that are already dyed, but dyes nothing new', () => {
    const game = newGame(parseLevel(SMALL));
    roll(game, 'R');
    const back = roll(game, 'L');
    expect(back).toEqual({ dir: 'L', from: 2, to: 0, path: [1, 0], fresh: [] });
    expect(game.dyedCount).toBe(3);
    expect(steps(game)).toBe(2);
  });

  it('does not count a push straight into a wall', () => {
    const game = newGame(parseLevel(SMALL));
    expect(roll(game, 'U')).toBeNull();
    expect(game.pos).toBe(0);
    expect(steps(game)).toBe(0);
  });

  it('is done exactly when the last floor cell is dyed', () => {
    const game = newGame(parseLevel(SMALL));
    for (const dir of ['R', 'D', 'R', 'U', 'L', 'D', 'L'] as const) roll(game, dir);
    // 走了 7 步，只剩 4 号格没染
    expect(game.dyedCount).toBe(9);
    expect(isDone(game)).toBe(false);
    roll(game, 'U');
    expect(Array.from(game.dyed)).toEqual([1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1]);
    expect(isDone(game)).toBe(true);
    expect(steps(game)).toBe(8);
  });
});

describe('undo', () => {
  it('puts the ball back, takes the step back and cleans the cells that move dyed', () => {
    const game = newGame(parseLevel(SMALL));
    roll(game, 'R');
    roll(game, 'D'); // 2 → 10，染上 6、10
    const undone = undo(game);
    expect(undone).toEqual({ dir: 'D', from: 2, to: 10, path: [6, 10], fresh: [6, 10] });
    expect(game.pos).toBe(2);
    expect(steps(game)).toBe(1);
    expect(Array.from(game.dyed)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(game.dyedCount).toBe(3);
  });

  it('leaves cells dyed that an earlier move had already dyed', () => {
    const game = newGame(parseLevel(SMALL));
    roll(game, 'R'); // 染上 1、2
    roll(game, 'L'); // 滚回 0，没有新染的格子
    undo(game);
    expect(game.pos).toBe(2);
    expect(Array.from(game.dyed)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(game.dyedCount).toBe(3);
  });

  it('has nothing to undo before the first move', () => {
    const game = newGame(parseLevel(SMALL));
    expect(undo(game)).toBeNull();
    expect(game.pos).toBe(0);
    expect(game.dyedCount).toBe(1);
  });

  it('can be repeated all the way back to the start', () => {
    const game = newGame(parseLevel(SMALL));
    roll(game, 'R');
    roll(game, 'D');
    roll(game, 'R');
    undo(game);
    undo(game);
    undo(game);
    expect(game.pos).toBe(0);
    expect(steps(game)).toBe(0);
    expect(Array.from(game.dyed)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(undo(game)).toBeNull();
  });
});
