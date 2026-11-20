// 配置页记着"自己刚发布的那一份"：发布后的一两分钟里，服务端有可能还在回旧的，这段时间以它为准。
import { describe, expect, it } from 'vitest';
import { PUBLISHED_KEY, recentlyPublished, rememberPublished, TRUST_MS } from '../src/config/published.ts';
import { BUILTIN, type LevelSet } from '../src/game/levelset.ts';

const MINE: LevelSet = { version: 1, levels: [{ ...BUILTIN.levels[0], dye: '#c0302b' }, BUILTIN.levels[1]] };
const T0 = 1_800_000_000_000;

class Shelf {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}
const refuse = (): never => {
  throw new Error('storage is off');
};

describe('what this browser published a moment ago', () => {
  it('is trusted for two minutes', () => {
    expect(TRUST_MS).toBe(120_000);
    expect(PUBLISHED_KEY).toBe('coloring-maze.config-published');
  });

  it('comes back as it was while it is still fresh', () => {
    const shelf = new Shelf();
    rememberPublished(shelf, MINE, T0);
    expect(recentlyPublished(shelf, T0)).toEqual(MINE);
    expect(recentlyPublished(shelf, T0 + 1000)).toEqual(MINE);
    expect(recentlyPublished(shelf, T0 + TRUST_MS - 1)).toEqual(MINE);
  });

  it('comes back with the open-all switch as it was published, on or off', () => {
    const shelf = new Shelf();
    const open: LevelSet = { ...MINE, openAll: true };
    rememberPublished(shelf, open, T0);
    expect(recentlyPublished(shelf, T0 + 1000)).toEqual(open);
    rememberPublished(shelf, MINE, T0 + 2000);
    const off = recentlyPublished(shelf, T0 + 3000);
    expect(off).toEqual(MINE);
    expect(off !== null && 'openAll' in off).toBe(false);
  });

  it('is no longer used once two minutes have passed: by then the server has caught up', () => {
    const shelf = new Shelf();
    rememberPublished(shelf, MINE, T0);
    expect(recentlyPublished(shelf, T0 + TRUST_MS)).toBeNull();
    expect(recentlyPublished(shelf, T0 + 3_600_000)).toBeNull();
  });

  it('is not used when the clock says it was published in the future', () => {
    const shelf = new Shelf();
    rememberPublished(shelf, MINE, T0);
    expect(recentlyPublished(shelf, T0 - 1)).toBeNull();
  });

  it('is replaced by the next thing published', () => {
    const shelf = new Shelf();
    rememberPublished(shelf, BUILTIN, T0);
    rememberPublished(shelf, MINE, T0 + 5000);
    expect(recentlyPublished(shelf, T0 + 6000)).toEqual(MINE);
  });

  it('is nothing when nothing was published from this browser', () => {
    expect(recentlyPublished(new Shelf(), T0)).toBeNull();
  });

  it.each([
    ['text that is not JSON', '{oops'],
    ['JSON of another shape', '[1,2]'],
    ['no time', JSON.stringify({ set: MINE })],
    ['a time that is not a number', JSON.stringify({ at: 'now', set: MINE })],
    ['no set', JSON.stringify({ at: T0 })],
    ['a set that does not pass the check', JSON.stringify({ at: T0, set: { version: 1, levels: [{ ...BUILTIN.levels[0], rows: ['S.#..', '#####', '#####', '#####', '#####'] }] } })],
  ])('is nothing when what was kept is %s', (_name, kept) => {
    const shelf = new Shelf();
    shelf.setItem(PUBLISHED_KEY, kept);
    expect(recentlyPublished(shelf, T0)).toBeNull();
  });

  it('does not get in the way when the browser refuses to store anything', () => {
    const shut = { getItem: refuse, setItem: refuse };
    expect(() => rememberPublished(shut, MINE, T0)).not.toThrow();
    expect(recentlyPublished(shut, T0)).toBeNull();
  });
});
