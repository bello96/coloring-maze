import { describe, expect, it } from 'vitest';
import { starsFor } from '../src/game/stars.ts';
import { swipeDir } from '../src/ui/swipe.ts';

describe('starsFor', () => {
  it.each([
    // [走了几步, 最少步数, 星数]
    [3, 3, 3],
    [4, 3, 2],
    [5, 3, 2],
    [6, 3, 1],
    [12, 12, 3],
    [13, 12, 2],
    [15, 12, 2],
    [16, 12, 1],
    [35, 35, 3],
    [44, 35, 2],
    [45, 35, 1],
    [200, 35, 1],
  ])('%i steps on a %i-step level earns %i', (steps, par, stars) => {
    expect(starsFor(steps, par)).toBe(stars);
  });
});

describe('swipeDir', () => {
  it('ignores a finger that has barely moved', () => {
    expect(swipeDir(10, 4, 24)).toBeNull();
    expect(swipeDir(-17, -16, 24)).toBeNull();
  });

  it('follows the direction the finger moved most', () => {
    expect(swipeDir(40, 5, 24)).toBe('R');
    expect(swipeDir(-40, 12, 24)).toBe('L');
    expect(swipeDir(6, -30, 24)).toBe('U');
    expect(swipeDir(-9, 31, 24)).toBe('D');
  });

  it('waits when the finger is moving almost exactly diagonally', () => {
    // 斜着滑分不清是横是竖，宁可等手指再多滑一点
    expect(swipeDir(30, 29, 24)).toBeNull();
    expect(swipeDir(-30, 28, 24)).toBeNull();
  });

  it('decides once one direction is clearly ahead', () => {
    expect(swipeDir(40, 28, 24)).toBe('R');
    expect(swipeDir(27, -40, 24)).toBe('U');
  });
});
