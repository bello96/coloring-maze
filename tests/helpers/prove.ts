// 长方形的大图（第 51 关起）：确认标的最少步数真的是最少。
// 这些图只有整数规划（tools/mip.ts）算得动，一关要算几秒到几十秒，所以分成几个测试文件，好让它们同时跑。
import { describe, expect, it } from 'vitest';
import { parseLevel } from '../../src/game/level.ts';
import { LEVELS } from '../../src/game/levels.ts';
import { shortfall } from '../../src/game/solver.ts';
import { shortestTour } from '../../tools/mip.ts';

/**
 * 第 from 关到第 to 关：不会困死；比标的最少步数再少一步就走不通。
 * （标的那条走法确实那么多步就能走通，是 levels.test.ts 里对每一关都查的；两头一夹，标的就是最少步数。）
 */
export function proveFewest(from: number, to: number): void {
  const cases = LEVELS.slice(from - 1, to).map((def, i) => ({ def, number: from + i }));
  describe.each(cases)('level $number', ({ def }) => {
    const level = parseLevel(def.rows);

    it('cannot trap the player', () => {
      expect(shortfall(level)).toBe(0);
    });

    it('cannot be finished in one step fewer than its stated fewest steps', () => {
      expect(shortestTour(level, { atMost: def.par - 1 })).toBeNull();
    }, 900_000);
  });
}
