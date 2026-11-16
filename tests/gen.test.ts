import { describe, expect, it } from 'vitest';
import { parseLevel } from '../src/game/level.ts';
import { floorConnected, hasPinch } from '../src/game/shape.ts';
import { analyze, shortfall } from '../src/game/solver.ts';
import { mend } from '../tools/gen.ts';
import { seeded } from './helpers/random.ts';

/** 一直试到造出 count 张为止（大多数时候一开始摆的木块就不合格，直接放弃） */
function mended(seed: number, n: number, count: number, symmetric: boolean): string[][] {
  const rand = seeded(seed);
  const out: string[][] = [];
  for (let i = 0; i < 4000 && out.length < count; i++) {
    const rows = mend(rand, n, Math.round(n * (0.7 + rand() * 2)), symmetric);
    if (rows) out.push(rows);
  }
  expect(out).toHaveLength(count);
  return out;
}

describe('mend: boards made by placing blocks and then fixing them cell by cell', () => {
  it('can always be finished and can never trap the player (9×9, checked by the solver)', () => {
    for (const rows of [...mended(1, 9, 8, false), ...mended(2, 9, 8, true)]) {
      const a = analyze(parseLevel(rows));
      expect(a.solvable, rows.join('/')).toBe(true);
      expect(a.safe, rows.join('/')).toBe(true);
    }
  });

  it('makes 15×15 boards the tray can be built for, between 55% and 85% floor', () => {
    for (const rows of [...mended(3, 15, 6, false), ...mended(4, 15, 6, true)]) {
      const level = parseLevel(rows);
      expect(level.rows).toBe(15);
      expect(level.cols).toBe(15);
      expect(hasPinch(level.floor, 15, 15)).toBe(false);
      expect(floorConnected(level.floor, 15, 15)).toBe(true);
      expect(level.floorCount).toBeGreaterThanOrEqual(225 * 0.55);
      expect(level.floorCount).toBeLessThanOrEqual(225 * 0.85);
      expect(shortfall(level)).toBe(0);
    }
  });

  it('keeps the walls point-symmetric when asked to', () => {
    for (const rows of mended(5, 15, 6, true)) {
      const { floor } = parseLevel(rows);
      for (let cell = 0; cell < floor.length; cell++) expect(floor[cell]).toBe(floor[floor.length - 1 - cell]);
    }
  });
});
