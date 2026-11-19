import { describe, expect, it } from 'vitest';
import { parseLevel } from '../src/game/level.ts';
import { floorConnected, hasPinch, pinchCells, strayCells } from '../src/game/shape.ts';
import { randomMaze, seeded } from './helpers/random.ts';

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

  it('does not treat the last column and the next row as neighbours', () => {
    // 按格子编号看，第一行最后一格和第二行第一格是挨着的；在图上它们隔着整整一行
    expect(floorConnected(Uint8Array.from([0, 0, 1, 1, 0, 0]), 2, 3)).toBe(false);
    expect(floorConnected(Uint8Array.from([1, 0, 0, 0, 0, 1]), 2, 3)).toBe(false);
  });

  it('is false when there is no floor at all, and true for a single cell of floor', () => {
    expect(floorConnected(new Uint8Array(12), 3, 4)).toBe(false);
    expect(floorConnected(Uint8Array.from([1]), 1, 1)).toBe(true);
    expect(floorConnected(Uint8Array.from([0, 0, 0, 0, 0, 1]), 2, 3)).toBe(true);
  });

  it('agrees with the plainest way of working it out on 20,000 random boards of every size up to 23×23', () => {
    // 最直白的办法：从第一格地面出发，一遍遍地把"挨着已经到过的格子"的地面标上，直到再也标不出新的
    const plainly = (floor: Uint8Array, rows: number, cols: number): boolean => {
      const first = floor.indexOf(1);
      if (first < 0) return false;
      const reached = new Set([first]);
      for (let grew = true; grew; ) {
        grew = false;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const cell = r * cols + c;
            if (!floor[cell] || reached.has(cell)) continue;
            const beside =
              (r > 0 && reached.has(cell - cols)) || (r + 1 < rows && reached.has(cell + cols)) || (c > 0 && reached.has(cell - 1)) || (c + 1 < cols && reached.has(cell + 1));
            if (beside) {
              reached.add(cell);
              grew = true;
            }
          }
        }
      }
      return reached.size === floor.reduce((sum, v) => sum + v, 0);
    };
    const rand = seeded(41);
    let joined = 0;
    let apart = 0;
    for (let i = 0; i < 20_000; i++) {
      const rows = 1 + Math.floor(rand() * 23);
      const cols = 1 + Math.floor(rand() * 23);
      // 地面多的图多半连着，少的多半不连：两头都要有
      const share = 0.3 + rand() * 0.7;
      const floor = Uint8Array.from({ length: rows * cols }, () => (rand() < share ? 1 : 0));
      const expected = plainly(floor, rows, cols);
      expect(floorConnected(floor, rows, cols), `${rows}×${cols}: ${floor.join('')}`).toBe(expected);
      if (expected) joined++;
      else apart++;
    }
    expect(joined).toBeGreaterThan(2000);
    expect(apart).toBeGreaterThan(2000);
  });
});

describe('pinchCells', () => {
  it('gives all four cells of a 2×2 where two walls touch only at a corner', () => {
    expect(pinchCells(...grid(['S#', '#.']))).toEqual([0, 1, 2, 3]);
    expect(pinchCells(...grid(['#S', '.#']))).toEqual([0, 1, 2, 3]);
  });

  it('gives the 2×2 in the middle of a bigger maze and nothing around it', () => {
    //  S . . .
    //  . . # .      第 1、2 行，第 1、2 列的那四格：5 6 / 9 10
    //  . # . .
    //  . . . .
    expect(pinchCells(...grid(['S...', '..#.', '.#..', '....']))).toEqual([5, 6, 9, 10]);
  });

  it('gives nothing when no walls touch only at a corner', () => {
    expect(pinchCells(...grid(['S...', '.##.', '.#..', '....']))).toEqual([]);
    expect(pinchCells(...grid(['S..', '...']))).toEqual([]);
    expect(pinchCells(...grid(['S.#.']))).toEqual([]);
    // 第 1 行末尾是墙、第 2 行开头是墙，但它们并不相邻
    expect(pinchCells(...grid(['S.#', '#..', '...']))).toEqual([]);
  });

  it('lists a cell once, smallest first, when it belongs to two such 2×2', () => {
    //  S # .
    //  # . #      左边四格、右边四格都是对角相碰，中间一列两边都算到
    expect(pinchCells(...grid(['S#.', '#.#']))).toEqual([0, 1, 2, 3, 4, 5]);
    //  S . #
    //  . # .      两个 2×2 斜着排，只共用中间那一格
    //  # . .
    expect(pinchCells(...grid(['S.#', '.#.', '#..']))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is empty exactly when hasPinch finds nothing (500 random mazes)', () => {
    const rand = seeded(5);
    let pinched = 0;
    for (let i = 0; i < 500; i++) {
      const maze = randomMaze(rand, 2 + Math.floor(rand() * 6), 2 + Math.floor(rand() * 6), 0.05 + rand() * 0.3);
      const [floor, rows, cols] = grid(maze);
      const cells = pinchCells(floor, rows, cols);
      expect(cells.length > 0, maze.join('/')).toBe(hasPinch(floor, rows, cols));
      // 从小到大、不重复，至少是一个完整的 2×2
      expect(cells, maze.join('/')).toEqual([...new Set(cells)].sort((a, b) => a - b));
      if (cells.length > 0) {
        expect(cells.length, maze.join('/')).toBeGreaterThanOrEqual(4);
        pinched++;
      }
    }
    // 两种都得真的碰到过
    expect(pinched).toBeGreaterThan(100);
    expect(pinched).toBeLessThan(400);
  });
});

describe('strayCells', () => {
  it('gives the floor cells a wall cuts off from the given cell', () => {
    const [floor, rows, cols] = grid(['S#.', '.#.', '.#.']);
    expect(strayCells(floor, rows, cols, 0)).toEqual([2, 5, 8]);
    // 从另一片看过来，掉队的就是这一片
    expect(strayCells(floor, rows, cols, 8)).toEqual([0, 3, 6]);
  });

  it('gives every other piece when the floor is in three pieces', () => {
    //  S # . # .
    //  . # . # #
    expect(strayCells(...grid(['S#.#.', '.#.##']), 0)).toEqual([2, 4, 7]);
  });

  it('gives nothing when the floor is in one piece', () => {
    expect(strayCells(...grid(['S.#', '#..', '...']), 0)).toEqual([]);
    expect(strayCells(...grid(['S.#', '#..', '...']), 8)).toEqual([]);
  });

  it('does not count cells that only touch at a corner as connected', () => {
    expect(strayCells(...grid(['S#', '#.']), 0)).toEqual([3]);
  });

  it('does not treat the last column and the next row as neighbours', () => {
    // 第 1 行末尾的地面和第 2 行开头的地面并不相邻
    expect(strayCells(...grid(['S#.', '.##']), 0)).toEqual([2]);
  });

  it('counts all the floor as cut off when asked about a wall', () => {
    expect(strayCells(...grid(['S#', '..']), 1)).toEqual([0, 2, 3]);
  });

  it('is empty exactly when floorConnected says the floor is in one piece (500 random mazes)', () => {
    const rand = seeded(6);
    let broken = 0;
    for (let i = 0; i < 500; i++) {
      const maze = randomMaze(rand, 2 + Math.floor(rand() * 6), 2 + Math.floor(rand() * 6), 0.05 + rand() * 0.3);
      const level = parseLevel(maze);
      const cells = strayCells(level.floor, level.rows, level.cols, level.start);
      expect(cells.length === 0, maze.join('/')).toBe(floorConnected(level.floor, level.rows, level.cols));
      // 掉队的都是地面，从小到大、不重复，而且不会是出发的那一格
      expect(cells, maze.join('/')).toEqual([...new Set(cells)].sort((a, b) => a - b));
      for (const cell of cells) expect(level.floor[cell], maze.join('/')).toBe(1);
      expect(cells, maze.join('/')).not.toContain(level.start);
      if (cells.length > 0) broken++;
    }
    expect(broken).toBeGreaterThan(100);
    expect(broken).toBeLessThan(400);
  });
});
