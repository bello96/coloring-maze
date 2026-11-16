import { describe, expect, it } from 'vitest';
import { parseLevel } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { traceFloor, type Point } from '../src/view/outline.ts';

/** 同一个圈可以从任意一个顶点开始、顺着或逆着写；转成统一的写法再比较 */
function canonical(loop: readonly Point[]): string {
  const variants: string[] = [];
  for (const list of [loop, [...loop].reverse()]) {
    for (let i = 0; i < list.length; i++) {
      variants.push([...list.slice(i), ...list.slice(0, i)].map(([x, y]) => `${x},${y}`).join(' '));
    }
  }
  return variants.sort()[0];
}

/** 鞋带公式：多边形围住的面积（不管顺逆时针） */
function area(loop: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

describe('traceFloor', () => {
  it('draws a square around a single cell', () => {
    const o = traceFloor(parseLevel(['S']));
    expect(canonical(o.outer)).toBe(canonical([[0, 0], [1, 0], [1, 1], [0, 1]]));
    expect(o.islands).toEqual([]);
  });

  it('follows the inside corner of an L-shaped floor', () => {
    const o = traceFloor(parseLevel(['S.', '.#']));
    expect(canonical(o.outer)).toBe(canonical([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]));
    expect(o.islands).toEqual([]);
  });

  it('steps around a wall that is attached to the edge of the board', () => {
    const o = traceFloor(parseLevel(['S#.', '...']));
    expect(canonical(o.outer)).toBe(canonical([[0, 0], [1, 0], [1, 1], [2, 1], [2, 0], [3, 0], [3, 2], [0, 2]]));
    expect(o.islands).toEqual([]);
  });

  it('reports a wall surrounded by floor as an island', () => {
    const o = traceFloor(parseLevel(['S..', '.#.', '...']));
    expect(canonical(o.outer)).toBe(canonical([[0, 0], [3, 0], [3, 3], [0, 3]]));
    expect(o.islands.map(canonical)).toEqual([canonical([[1, 1], [2, 1], [2, 2], [1, 2]])]);
  });

  it('tells an island from a wall that reaches the edge of the board', () => {
    // 左边那条竖着的墙四周都是地面，是孤岛；右边那块贴着棋盘右边缘，算在外圈轮廓里
    const o = traceFloor(parseLevel(['S.....', '.#..#.', '.#..##', '......']));
    expect(o.islands.map(canonical)).toEqual([canonical([[1, 1], [2, 1], [2, 3], [1, 3]])]);
    expect(canonical(o.outer)).toBe(
      canonical([[0, 0], [6, 0], [6, 2], [5, 2], [5, 1], [4, 1], [4, 3], [6, 3], [6, 4], [0, 4]]),
    );
  });

  it('gives each of two islands its own loop', () => {
    const o = traceFloor(parseLevel(['S....', '.#.#.', '.#...', '.....']));
    expect(o.islands.map(canonical).sort()).toEqual(
      [canonical([[1, 1], [2, 1], [2, 3], [1, 3]]), canonical([[3, 1], [4, 1], [4, 2], [3, 2]])].sort(),
    );
    expect(canonical(o.outer)).toBe(canonical([[0, 0], [5, 0], [5, 4], [0, 4]]));
  });

  it('leaves out points in the middle of a straight edge', () => {
    const o = traceFloor(parseLevel(['S...', '....']));
    expect(o.outer).toHaveLength(4);
  });

  it.each(LEVELS.map((def, i) => ({ def, name: `level ${i + 1}` })))(
    'encloses exactly the floor of $name',
    ({ def }) => {
      const level = parseLevel(def.rows);
      const o = traceFloor(level);
      const enclosed = area(o.outer) - o.islands.reduce((sum, loop) => sum + area(loop), 0);
      expect(enclosed).toBe(level.floorCount);
    },
  );
});
