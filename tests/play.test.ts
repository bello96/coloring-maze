import { describe, expect, it } from 'vitest';
import { bestOf, emptyProgress, isUnlocked, readProgress, record, writeProgress } from '../src/game/progress.ts';
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

describe('progress', () => {
  it('starts with only the first level open and nothing finished', () => {
    const p = emptyProgress(30);
    expect(isUnlocked(p, 0)).toBe(true);
    expect(isUnlocked(p, 1)).toBe(false);
    expect(bestOf(p, 0)).toBe(0);
  });

  it('opens the next level once a level is finished', () => {
    const p = record(emptyProgress(30), 0, 5);
    expect(bestOf(p, 0)).toBe(5);
    expect(isUnlocked(p, 1)).toBe(true);
    expect(isUnlocked(p, 2)).toBe(false);
  });

  it('keeps the best result when a level is finished again with more steps', () => {
    let p = record(emptyProgress(30), 0, 5);
    p = record(p, 0, 9);
    expect(bestOf(p, 0)).toBe(5);
  });

  it('replaces the best result when a level is finished in fewer steps', () => {
    let p = record(emptyProgress(30), 0, 5);
    p = record(p, 0, 3);
    expect(bestOf(p, 0)).toBe(3);
  });

  it('does not change the progress it was given', () => {
    const before = emptyProgress(30);
    record(before, 0, 5);
    expect(bestOf(before, 0)).toBe(0);
  });

  it('never locks anything past the last level', () => {
    const p = record(emptyProgress(3), 2, 9);
    expect(isUnlocked(p, 3)).toBe(false);
    expect(bestOf(p, 3)).toBe(0);
  });

  it('survives being saved and loaded', () => {
    let p = record(emptyProgress(30), 0, 5);
    p = record(p, 1, 8);
    p = { ...p, last: 2, muted: true };
    const loaded = readProgress(writeProgress(p), 30);
    expect(bestOf(loaded, 0)).toBe(5);
    expect(bestOf(loaded, 1)).toBe(8);
    expect(loaded.last).toBe(2);
    expect(loaded.muted).toBe(true);
    expect(isUnlocked(loaded, 2)).toBe(true);
    expect(isUnlocked(loaded, 3)).toBe(false);
  });

  it.each([
    ['nothing saved yet', null],
    ['text that is not JSON', '{oops'],
    ['JSON of the wrong shape', '[1,2,3]'],
    ['a best list that is not a list', '{"best":"x","last":1,"muted":false}'],
  ])('starts fresh from %s', (_name, raw) => {
    const p = readProgress(raw, 30);
    expect(bestOf(p, 0)).toBe(0);
    expect(p.last).toBe(0);
    expect(p.muted).toBe(false);
    expect(isUnlocked(p, 1)).toBe(false);
  });

  it('ignores saved numbers that make no sense', () => {
    const p = readProgress('{"best":[5,-2,"7",3.5,null,8],"last":99,"muted":"yes"}', 30);
    expect(bestOf(p, 0)).toBe(5);
    expect(bestOf(p, 1)).toBe(0);
    expect(bestOf(p, 2)).toBe(0);
    expect(bestOf(p, 3)).toBe(0);
    expect(bestOf(p, 4)).toBe(0);
    expect(bestOf(p, 5)).toBe(8);
    // 上次玩到的关卡超出范围，回到第一关
    expect(p.last).toBe(0);
    expect(p.muted).toBe(false);
  });

  it('does not reopen a level that was saved as "last played" but is still locked', () => {
    const p = readProgress('{"best":[5],"last":7,"muted":false}', 30);
    expect(p.last).toBe(0);
  });

  it('drops results for levels that no longer exist', () => {
    const p = readProgress('{"best":[5,6,7,8],"last":1,"muted":false}', 2);
    expect(bestOf(p, 1)).toBe(6);
    expect(bestOf(p, 2)).toBe(0);
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
