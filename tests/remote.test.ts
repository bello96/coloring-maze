import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN, type LevelSet } from '../src/game/levelset.ts';
import { GRACE_MS, LEVELS_CACHE_KEY, loadLevelSet, type LoadOptions } from '../src/game/remote.ts';

type Fetch = NonNullable<LoadOptions['fetch']>;

/** 线上发布的一份：内置的前两关换个顺序，和内置的不一样，一眼分得出用的是哪份 */
const ONLINE: LevelSet = { version: 1, levels: [BUILTIN.levels[1], BUILTIN.levels[0]] };
/** 上次留在浏览器里的一份 */
const KEPT: LevelSet = { version: 1, levels: [BUILTIN.levels[2]] };
/** 格式对、但通不过校验的一份（地面断成了两片） */
const BROKEN = { version: 1, levels: [{ ...BUILTIN.levels[0], rows: ['S.#..', '#####', '#####', '#####', '#####'] }] };

const answer = (status: number, body: string): Fetch => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const online = (set: unknown): Fetch => answer(200, JSON.stringify(set));

class Shelf {
  readonly items = new Map<string, string>();
  constructor(kept?: unknown) {
    if (kept !== undefined) this.items.set(LEVELS_CACHE_KEY, typeof kept === 'string' ? kept : JSON.stringify(kept));
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

let warned: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loading the level set when the game starts', () => {
  it('keeps its copy under its own name in the browser', () => {
    expect(LEVELS_CACHE_KEY).toBe('coloring-maze.levels');
  });

  it('uses what is published online and keeps a copy for next time', async () => {
    const storage = new Shelf();
    const asked: Array<{ url: string; cache: string }> = [];
    const fetch: Fetch = async (url, init) => {
      asked.push({ url, cache: init.cache });
      return { ok: true, status: 200, text: async () => JSON.stringify(ONLINE) };
    };
    const loaded = await loadLevelSet({ fetch, storage });
    expect(loaded).toEqual({ set: ONLINE, source: 'remote' });
    expect(asked).toEqual([{ url: '/api/levels', cache: 'no-store' }]);
    expect(JSON.parse(storage.getItem(LEVELS_CACHE_KEY)!)).toEqual(ONLINE);
    expect(warned).not.toHaveBeenCalled();
  });

  const failures: ReadonlyArray<readonly [name: string, fetch: Fetch]> = [
    ['the request fails', async () => Promise.reject(new TypeError('Failed to fetch'))],
    ['nothing has been published yet (404)', answer(404, '{"error":"not_found"}')],
    ['the server is in trouble (500)', answer(500, 'oops')],
    ['the answer is not JSON', answer(200, '<html>')],
    ['the answer is JSON but not a level set', answer(200, '[1,2,3]')],
    ['the published set does not pass the check', online(BROKEN)],
    ['reading the answer fails half way', async () => ({ ok: true, status: 200, text: async () => Promise.reject(new Error('cut off')) })],
  ];

  it.each(failures)('falls back to the copy kept last time when %s', async (_name, fetch) => {
    const loaded = await loadLevelSet({ fetch, storage: new Shelf(KEPT) });
    expect(loaded).toEqual({ set: KEPT, source: 'cache' });
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it.each(failures)('falls back to the built-in levels when %s and nothing was kept', async (_name, fetch) => {
    const loaded = await loadLevelSet({ fetch, storage: new Shelf() });
    expect(loaded.source).toBe('builtin');
    expect(loaded.set).toBe(BUILTIN);
  });

  it.each([
    ['is not JSON', '{oops'],
    ['does not pass the check', JSON.stringify(BROKEN)],
    ['is something else entirely', '"hello"'],
  ])('falls back to the built-in levels when the kept copy %s', async (_name, kept) => {
    const loaded = await loadLevelSet({ fetch: answer(404, ''), storage: new Shelf(kept) });
    expect(loaded.source).toBe('builtin');
    expect(loaded.set).toBe(BUILTIN);
  });

  it('leaves a good kept copy alone when what is online is no good', async () => {
    const storage = new Shelf(KEPT);
    await loadLevelSet({ fetch: online(BROKEN), storage });
    expect(JSON.parse(storage.getItem(LEVELS_CACHE_KEY)!)).toEqual(KEPT);
  });

  it('waits two and a half seconds for the server, plus a moment for an answer that is just arriving', async () => {
    vi.useFakeTimers();
    expect(GRACE_MS).toBe(200);
    let loaded: Awaited<ReturnType<typeof loadLevelSet>> | undefined;
    const pending = loadLevelSet({ fetch: () => new Promise(() => {}), storage: new Shelf(KEPT) }).then((result) => (loaded = result));
    await vi.advanceTimersByTimeAsync(2500 + GRACE_MS - 1);
    expect(loaded).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(loaded).toEqual({ set: KEPT, source: 'cache' });
  });

  it('can be told to wait a different length of time', async () => {
    vi.useFakeTimers();
    const pending = loadLevelSet({ fetch: () => new Promise(() => {}), storage: new Shelf(), timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100 + GRACE_MS);
    expect((await pending).source).toBe('builtin');
  });

  it('still uses an answer that was already there when the time ran out (the page had been too busy to look at it)', async () => {
    // 游戏启动时要画木纹、搭舞台，主线程会被占住一两秒，手机上更久。回音其实早到了，只是没人顾得上看；
    // 等主线程空下来，"时限到了"和"回音到了"几乎是同时轮到的——这里让它们同一时刻到，而且时限排在前面
    vi.useFakeTimers();
    const storage = new Shelf();
    const justNow: Fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify(ONLINE) }), 2500));
    const pending = loadLevelSet({ fetch: justNow, storage });
    await vi.advanceTimersByTimeAsync(2500 + GRACE_MS);
    expect(await pending).toEqual({ set: ONLINE, source: 'remote' });
    expect(JSON.parse(storage.getItem(LEVELS_CACHE_KEY)!)).toEqual(ONLINE);
  });

  it('keeps an answer that came too late for this visit, so that the next visit can use it', async () => {
    vi.useFakeTimers();
    const storage = new Shelf();
    const slow: Fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify(ONLINE) }), 6000));
    const loaded = loadLevelSet({ fetch: slow, storage });
    await vi.advanceTimersByTimeAsync(2500 + GRACE_MS);
    expect((await loaded).source).toBe('builtin');
    expect(storage.getItem(LEVELS_CACHE_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(4000);
    expect(JSON.parse(storage.getItem(LEVELS_CACHE_KEY)!)).toEqual(ONLINE);
    // 下一次打开，就算又没等到，也有这一份可用
    const next = loadLevelSet({ fetch: () => new Promise(() => {}), storage });
    await vi.advanceTimersByTimeAsync(2500 + GRACE_MS);
    expect(await next).toEqual({ set: ONLINE, source: 'cache' });
  });

  it('does not let a late answer that is no good spoil the copy it has', async () => {
    vi.useFakeTimers();
    const storage = new Shelf(KEPT);
    const slowAndBad: Fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify(BROKEN) }), 6000));
    const loaded = loadLevelSet({ fetch: slowAndBad, storage });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await loaded).source).toBe('cache');
    expect(JSON.parse(storage.getItem(LEVELS_CACHE_KEY)!)).toEqual(KEPT);
  });

  it('does not keep the timer running once the server has answered', async () => {
    vi.useFakeTimers();
    await loadLevelSet({ fetch: online(ONLINE), storage: new Shelf() });
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('when the browser refuses to store anything', () => {
    const refuse = (): never => {
      throw new Error('storage is off');
    };
    const storage = { getItem: refuse, setItem: refuse };

    it('still uses what is online', async () => {
      expect(await loadLevelSet({ fetch: online(ONLINE), storage })).toEqual({ set: ONLINE, source: 'remote' });
    });

    it('still falls back to the built-in levels', async () => {
      const loaded = await loadLevelSet({ fetch: answer(404, ''), storage });
      expect(loaded.source).toBe('builtin');
      expect(loaded.set).toBe(BUILTIN);
    });
  });

  it('falls back to the built-in levels where there is neither a network nor a place to store things', async () => {
    // 不给 fetch 和 storage，用环境里的：这里（Node）没有 localStorage，请求相对地址也发不出去
    const loaded = await loadLevelSet({ timeoutMs: 50 });
    expect(loaded.source).toBe('builtin');
    expect(loaded.set).toBe(BUILTIN);
  });
});
