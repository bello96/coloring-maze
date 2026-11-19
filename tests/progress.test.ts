import { describe, expect, it } from 'vitest';
import { BUILTIN } from '../src/game/levelset.ts';
import {
  advanced,
  bestOf,
  emptyProgress,
  keysOf,
  landing,
  LEVEL_KEY,
  loadProgress,
  mergeProgress,
  OLD_SAVE_KEY,
  passed,
  reachedFrom,
  readReached,
  record,
  SAVE_KEY,
  stateOf,
  writeProgress,
  type LevelKey,
  type Progress,
} from '../src/game/progress.ts';

const K = keysOf(BUILTIN);
/** 自己造的几关：编号就是名字，指纹是编号后面加个 1 */
const keys = (...ids: string[]): LevelKey[] => ids.map((id) => ({ id, sig: `${id}1` }));
/** 通过了这几关（每关 9 步） */
const having = (list: readonly LevelKey[]): Progress => list.reduce((p, key) => record(p, key, 9), emptyProgress());
/** 玩到第 reached 关的人，一共 count 关的时候每一关是哪一种 */
const states = (reached: number, count: number): string[] => Array.from({ length: count }, (_, i) => stateOf(reached, count, i));

describe('where the save lives', () => {
  it('is under a new name, next to the old one', () => {
    expect(SAVE_KEY).toBe('coloring-maze.v2');
    expect(OLD_SAVE_KEY).toBe('coloring-maze.v1');
  });

  it('knows each built-in level by its id and the fingerprint of its map', () => {
    expect(K).toHaveLength(80);
    expect(K[0].id).toBe('b01');
    expect(K[0].sig).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(K.map((key) => key.sig)).size).toBe(80);
  });
});

describe('reading a save', () => {
  it('moves an old save over: bests by position become records by level id', () => {
    const p = loadProgress(null, JSON.stringify({ best: [3, 0, 6], last: 2, muted: true }));
    expect(p).toEqual({ done: { b01: { best: 3, sig: K[0].sig }, b03: { best: 6, sig: K[2].sig } }, muted: true });
  });

  it('moves over all 80 bests of someone who finished the game', () => {
    const p = loadProgress(null, JSON.stringify({ best: K.map((_, i) => i + 3), last: 79, muted: false }));
    expect(Object.keys(p.done)).toHaveLength(80);
    expect(p.done.b80).toEqual({ best: 82, sig: K[79].sig });
    expect(reachedFrom(p, K)).toBe(81);
  });

  it('skips what makes no sense in an old save', () => {
    const p = loadProgress(null, JSON.stringify({ best: [3, -2, 1.5, '4', null, 7, ...new Array<number>(80).fill(5)], muted: 'yes' }));
    expect(p.done.b01.best).toBe(3);
    expect(['b02', 'b03', 'b04', 'b05'].map((id) => passed(p, id))).toEqual([false, false, false, false]);
    expect(p.done.b06.best).toBe(7);
    // 旧存档里比 80 关多出来的不管
    expect(Object.keys(p.done)).toHaveLength(76);
    expect(p.muted).toBe(false);
  });

  it('ignores the old save once a new one exists', () => {
    const p = loadProgress(JSON.stringify({ done: {}, muted: false }), JSON.stringify({ best: [3], last: 0, muted: true }));
    expect(p).toEqual(emptyProgress());
  });

  it('falls back to the old save when the new one cannot be read', () => {
    const p = loadProgress('{oops', JSON.stringify({ best: [3], last: 0, muted: false }));
    expect(passed(p, 'b01')).toBe(true);
  });

  it.each(['', 'null', '[]', '"x"', '7', '{"done":7}', '{"done":[1]}', '{oops'])('treats %j as no save at all', (raw) => {
    expect(loadProgress(raw, null)).toEqual(emptyProgress());
    expect(loadProgress(raw, raw)).toEqual(emptyProgress());
  });

  it('has nothing when there is no save of either kind', () => {
    expect(loadProgress(null, null)).toEqual({ done: {}, muted: false });
  });

  it('drops single records that make no sense and keeps the rest', () => {
    const raw = JSON.stringify({ done: { a1: { best: 4, sig: 'x' }, a2: { best: 0, sig: 'x' }, a3: { best: 2.5, sig: 'x' }, a4: { best: 3 }, a5: null, a6: 9, a7: { best: '3', sig: 'x' } }, muted: 1 });
    expect(loadProgress(raw, null)).toEqual({ done: { a1: { best: 4, sig: 'x' } }, muted: false });
  });

  it('comes back the same after being written and read again', () => {
    let p = record(emptyProgress(), { id: 'a1', sig: 's1' }, 9);
    p = { ...record(p, { id: 'zz', sig: 's2' }, 30), muted: true };
    expect(loadProgress(writeProgress(p), null)).toEqual(p);
    expect(JSON.parse(writeProgress(p))).toEqual({ done: { a1: { best: 9, sig: 's1' }, zz: { best: 30, sig: 's2' } }, muted: true });
  });
});

describe('recording a finished level', () => {
  it('keeps the better result on the same map', () => {
    let p = record(emptyProgress(), { id: 'a1', sig: 's1' }, 9);
    expect(bestOf(p, { id: 'a1', sig: 's1' })).toBe(9);
    p = record(p, { id: 'a1', sig: 's1' }, 12);
    expect(p.done.a1).toEqual({ best: 9, sig: 's1' });
    p = record(p, { id: 'a1', sig: 's1' }, 7);
    expect(p.done.a1).toEqual({ best: 7, sig: 's1' });
  });

  it('does not change the progress it was given', () => {
    const before = record(emptyProgress(), { id: 'a1', sig: 's1' }, 9);
    const copy = JSON.stringify(before);
    record(before, { id: 'a1', sig: 's1' }, 3);
    record(before, { id: 'a2', sig: 's1' }, 3);
    expect(JSON.stringify(before)).toBe(copy);
  });

  it('still counts a level as passed after its map was changed, but forgets the best result until it is played again', () => {
    const p = record(emptyProgress(), { id: 'a1', sig: 's1' }, 9);
    const changed = { id: 'a1', sig: 's2' };
    expect(passed(p, 'a1')).toBe(true);
    expect(bestOf(p, changed)).toBe(0);
    // 在新图上重玩：以这一次为准，哪怕比旧图上的步数多
    expect(record(p, changed, 20).done.a1).toEqual({ best: 20, sig: 's2' });
  });

  it('has no best result for a level never passed', () => {
    expect(bestOf(emptyProgress(), { id: 'a1', sig: 's1' })).toBe(0);
    expect(passed(emptyProgress(), 'a1')).toBe(false);
    // 编号碰巧和对象自带的属性同名也不算
    expect(passed(emptyProgress(), 'constructor')).toBe(false);
    expect(bestOf(emptyProgress(), { id: 'toString', sig: 's1' })).toBe(0);
  });

  it('keeps the record of a level that is no longer in the set', () => {
    const p = record(emptyProgress(), { id: 'gone', sig: 's' }, 5);
    expect(loadProgress(writeProgress(p), null)).toEqual(p);
    expect(mergeProgress(p, emptyProgress(), keys('a', 'b')).done.gone).toEqual({ best: 5, sig: 's' });
  });
});

describe('how far the player has got: one number', () => {
  it('lives under its own name, as a bare number that can be changed by hand', () => {
    expect(LEVEL_KEY).toBe('coloring-maze.level');
    expect(readReached('12')).toBe(12);
    expect(readReached('1')).toBe(1);
    // 手改的时候多打了空格、带上了引号，也认
    expect(readReached(' 7 ')).toBe(7);
    expect(readReached('"40"')).toBe(40);
  });

  it.each([null, '', '0', '00', '-3', '1.5', 'abc', '12abc', '{}', 'NaN', '1e3', '12345678'])('reads %j as never having played', (raw) => {
    expect(readReached(raw)).toBe(0);
  });

  it('is worked out from an older save: the level after the furthest one passed', () => {
    expect(reachedFrom(having(K.slice(0, 11)), K)).toBe(12);
    expect(reachedFrom(having(K), K)).toBe(81);
    // 中间有没通过的也一样，看的是位置最靠后的那一关
    const [a, b, c, d] = keys('a', 'b', 'c', 'd');
    expect(reachedFrom(having([a, c]), [a, b, c, d])).toBe(4);
  });

  it('is zero, never played, for a save without a single level passed', () => {
    expect(reachedFrom(emptyProgress(), K)).toBe(0);
    expect(reachedFrom({ ...emptyProgress(), muted: true }, K)).toBe(0);
  });

  it('is the first level for someone whose save knows none of the levels there are now', () => {
    // 玩过，所以不是 0；但这份关卡表里的关一关都没通过
    expect(reachedFrom(having(K.slice(0, 30)), keys('n1', 'n2', 'n3'))).toBe(1);
    expect(reachedFrom(having(K.slice(0, 30)), [])).toBe(1);
  });

  it('counts a level as passed whatever happened to its map since', () => {
    const p = record(emptyProgress(), { id: 'a', sig: 'old map' }, 4);
    expect(reachedFrom(p, keys('a', 'b', 'c'))).toBe(2);
  });

  it('keeps a veteran where they were when levels are put in or moved', () => {
    // 通过了前 60 关，第 5 位插进一关：原来轮到的第 61 关现在排第 62
    const list = [...K.slice(0, 4), { id: 'x1', sig: 'new' }, ...K.slice(4)];
    expect(reachedFrom(having(K.slice(0, 60)), list)).toBe(62);
    // 换了顺序：通过的两关挪到了第 2、3 位，轮到的是它们后面那一关
    const [a, b, c, d] = keys('a', 'b', 'c', 'd');
    expect(reachedFrom(having([a, b]), [c, a, b, d])).toBe(4);
  });

  it('moves on by one when the level in turn is passed, and stays put when an earlier one is played again', () => {
    expect(advanced(3, 2)).toBe(4);
    expect(advanced(3, 0)).toBe(3);
    expect(advanced(3, 1)).toBe(3);
    // 没记下过数字的人（比如浏览器不让存）通过了第 1 关
    expect(advanced(0, 0)).toBe(2);
    // 通过了最后一关：比关数多一，表示全通了
    expect(advanced(80, 79)).toBe(81);
  });
});

describe('which levels can be played', () => {
  it('is only the first one for a new player', () => {
    expect(states(0, 3)).toEqual(['open', 'locked', 'locked']);
    expect(states(1, 3)).toEqual(['open', 'locked', 'locked']);
    expect(landing(0, 3)).toBe(0);
    expect(landing(1, 3)).toBe(0);
  });

  it('is every level before the one reached, plus that one', () => {
    expect(states(3, 4)).toEqual(['done', 'done', 'open', 'locked']);
    expect(landing(3, 4)).toBe(2);
  });

  it('is every level once the last one has been passed, and the game then opens on the last', () => {
    expect(states(4, 3)).toEqual(['done', 'done', 'done']);
    expect(landing(4, 3)).toBe(2);
    // 手改成一个比关数大得多的数也一样
    expect(states(999, 3)).toEqual(['done', 'done', 'done']);
    expect(landing(999, 3)).toBe(2);
  });

  it('says locked for a position outside the set', () => {
    expect(stateOf(1, 2, -1)).toBe('locked');
    expect(stateOf(2, 2, 2)).toBe('locked');
    expect(stateOf(999, 2, 2)).toBe('locked');
    expect(landing(1, 0)).toBe(-1);
  });
});

describe('merging what another tab saved', () => {
  const list = keys('a', 'b', 'c');
  const [a, b, c] = list;

  it('has the levels of both', () => {
    const mine = record(emptyProgress(), a, 5);
    const theirs = record(emptyProgress(), b, 6);
    expect(mergeProgress(mine, theirs, list).done).toEqual({ a: { best: 5, sig: 'a1' }, b: { best: 6, sig: 'b1' } });
  });

  it('takes the better result when both passed the same map', () => {
    const mine = record(emptyProgress(), a, 5);
    const theirs = record(emptyProgress(), a, 3);
    expect(mergeProgress(mine, theirs, list).done.a.best).toBe(3);
    expect(mergeProgress(theirs, mine, list).done.a.best).toBe(3);
  });

  it('takes the result on the map the level has now when the two were on different maps', () => {
    const old = record(emptyProgress(), { id: 'c', sig: 'older map' }, 2);
    const now = record(emptyProgress(), c, 8);
    expect(mergeProgress(old, now, list).done.c).toEqual({ best: 8, sig: 'c1' });
    expect(mergeProgress(now, old, list).done.c).toEqual({ best: 8, sig: 'c1' });
  });

  it('keeps its own when neither is on the map the level has now, or the level is gone', () => {
    const mine = record(emptyProgress(), { id: 'c', sig: 'm' }, 2);
    const theirs = record(emptyProgress(), { id: 'c', sig: 't' }, 1);
    expect(mergeProgress(mine, theirs, list).done.c).toEqual({ best: 2, sig: 'm' });
    expect(mergeProgress(mine, theirs, []).done.c).toEqual({ best: 2, sig: 'm' });
  });

  it('keeps its own setting for the sound', () => {
    const mine = { ...emptyProgress(), muted: true };
    expect(mergeProgress(mine, emptyProgress(), list).muted).toBe(true);
    expect(mergeProgress(emptyProgress(), mine, list).muted).toBe(false);
  });

  it('changes neither of the two', () => {
    const mine = record(emptyProgress(), a, 5);
    const theirs = record(emptyProgress(), a, 3);
    const copies = [JSON.stringify(mine), JSON.stringify(theirs)];
    mergeProgress(mine, theirs, list);
    expect([JSON.stringify(mine), JSON.stringify(theirs)]).toEqual(copies);
  });
});
