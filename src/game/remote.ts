// 游戏启动时去拿线上发布的关卡表。拿不到就退一步，再拿不到再退一步：
//   1. 线上那份（/api/levels），拿到且通过校验就用它，并在浏览器里留一份；
//   2. 上次留的那份（同样要过校验）；
//   3. 内置的 80 关。
// 哪一步出了问题都只在控制台记一句，绝不挡住游戏启动。
import { BUILTIN, checkLevelSet, type LevelSet } from './levelset.ts';

export const LEVELS_CACHE_KEY = 'coloring-maze.levels';

export interface Loaded {
  readonly set: LevelSet;
  /** 这份关卡表是哪来的：线上的、上次留的、内置的 */
  readonly source: 'remote' | 'cache' | 'builtin';
}

export interface LoadOptions {
  /** 发请求的办法，默认是浏览器的 fetch。测试里换成假的 */
  readonly fetch?: (url: string, init: { cache: 'no-store' }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** 留一份的地方，默认是浏览器的 localStorage */
  readonly storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** 最多等线上多久（毫秒）。等字体、画木纹本来就要一两秒，所以平时不会多等 */
  readonly timeoutMs?: number;
}

/**
 * 时限到了之后再多等的这一小会儿（毫秒）。
 * 游戏启动时要画木纹、搭舞台，主线程会被占住一两秒（手机上更久），这段时间里回音就算早到了也没人顾得上看；
 * 等主线程空下来，"时限到了"和"回音到了"几乎同时轮到，谁先谁后说不准。所以时限到了不马上放弃，
 * 先让出这一小会儿：回音已经在门口的话，足够把它读完。
 */
export const GRACE_MS = 200;

const note = (what: string): void => console.warn(`[关卡] ${what}`);

/** 把一段文字读成关卡表；不是 JSON、通不过校验都返回一句原因 */
function read(text: string): LevelSet | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return '内容不是 JSON';
  }
  const checked = checkLevelSet(data);
  if (checked.ok) return checked.set;
  return checked.level < 0 ? checked.detail : `第 ${checked.level + 1} 关：${checked.detail}`;
}

/** 永远不抛异常、不拒绝。 */
export async function loadLevelSet(options: LoadOptions = {}): Promise<Loaded> {
  const ask = options.fetch ?? ((url, init) => fetch(url, init));
  // localStorage 这几个字要到真用的时候才碰：有的环境里一碰就抛异常
  const storage = options.storage ?? {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => localStorage.setItem(key, value),
  };

  /** 在浏览器里留一份 */
  const keep = (set: LevelSet): void => {
    try {
      storage.setItem(LEVELS_CACHE_KEY, JSON.stringify(set));
    } catch {
      // 留不下（比如无痕模式）就不留，下次再拿
    }
  };

  // 1. 线上那份
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooLate = new Promise<string>((resolve) => {
    // 时限到了再让出一小会儿才算数，见 GRACE_MS
    timer = setTimeout(() => {
      timer = setTimeout(() => resolve('等了太久没有回音'), GRACE_MS);
    }, options.timeoutMs ?? 2500);
  });
  const request = (async (): Promise<LevelSet | string> => {
    try {
      const res = await ask('/api/levels', { cache: 'no-store' });
      // 404 是还没发布过，其它是服务端出了问题；对游戏来说都一样：线上没有可用的
      if (!res.ok) return `服务端回的是 ${res.status}`;
      return read(await res.text());
    } catch (err) {
      return `请求没发成（${err instanceof Error ? err.message : String(err)}）`;
    }
  })();
  const online = await Promise.race([request, tooLate]);
  clearTimeout(timer);
  if (typeof online !== 'string') {
    keep(online);
    return { set: online, source: 'remote' };
  }
  // 这一次不等了，但请求不掐掉：它晚些时候到了、又是合格的，就留下来，下次打开时至少有这一份可用
  void request.then((late) => {
    if (typeof late !== 'string') keep(late);
  });

  // 2. 上次留的那份
  let kept: LevelSet | string = '没有';
  try {
    const text = storage.getItem(LEVELS_CACHE_KEY);
    if (text) kept = read(text);
  } catch {
    kept = '读不了';
  }
  if (typeof kept !== 'string') {
    note(`拿不到线上的关卡（${online}），用上次留的那份`);
    return { set: kept, source: 'cache' };
  }

  // 3. 内置的 80 关
  note(`拿不到线上的关卡（${online}），上次留的那份${kept === '没有' ? '也没有' : `用不了（${kept}）`}，用内置的关卡`);
  return { set: BUILTIN, source: 'builtin' };
}
