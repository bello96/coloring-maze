import { describe, expect, it } from 'vitest';
import { parseLevel } from '../src/game/level.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';

const grid = (rows: string[]) => {
  const level = parseLevel(rows);
  return [level.floor, level.rows, level.cols] as const;
};

describe('hasPinch', () => {
  it('finds two walls that touch only at a corner', () => {
    //  . #
    //  # .
    expect(hasPinch(...grid(['S#', '#.']))).toBe(true);
    expect(hasPinch(...grid(['#S', '.#']))).toBe(true);
  });

  it('finds a pinch in the middle of a bigger maze', () => {
    expect(hasPinch(...grid(['S...', '..#.', '.#..', '....']))).toBe(true);
  });

  it('accepts walls that share a whole edge', () => {
    expect(hasPinch(...grid(['S...', '.##.', '.#..', '....']))).toBe(false);
  });

  it('accepts a maze with no walls and one that is a single row', () => {
    expect(hasPinch(...grid(['S..', '...']))).toBe(false);
    expect(hasPinch(...grid(['S.#.']))).toBe(false);
  });

  it('does not treat the last column and the next row as neighbours', () => {
    // 第 1 行末尾是墙、第 2 行开头是墙，但它们并不相邻
    expect(hasPinch(...grid(['S.#', '#..', '...']))).toBe(false);
  });
});

describe('floorConnected', () => {
  it('is true when every floor cell can be walked to', () => {
    expect(floorConnected(...grid(['S.#', '#..', '...']))).toBe(true);
  });

  it('is false when a wall cuts the floor in two', () => {
    expect(floorConnected(...grid(['S#.', '.#.', '.#.']))).toBe(false);
  });

  it('does not count cells that only touch at a corner as connected', () => {
    expect(floorConnected(...grid(['S#', '#.']))).toBe(false);
  });
});
