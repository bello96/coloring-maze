// 配置页记着"这个浏览器刚发布的那一份"。
//
// 为什么要记：线上的关卡表存在 Cloudflare KV 里，写进去的内容传到各地要一会儿（最长约一分钟），
// 这期间去读，读到的可能还是上一版，甚至是"还没发布过"。发布完顺手刷新一下页面是很自然的动作——
// 要是这时页面老老实实显示读到的旧版，再点一次发布，刚才改的就被旧的盖掉了。
// 所以发布成功后把那一份连同时间记在浏览器里，两分钟之内再打开配置页，以它为准；
// 过了两分钟，服务端早该跟上了，就不再用它。
import { checkLevelSet, type LevelSet } from '../game/levelset.ts';

export const PUBLISHED_KEY = 'coloring-maze.config-published';
/** 自己刚发布的那一份，在这么久之内（毫秒）比服务端回的更可信 */
export const TRUST_MS = 120_000;

/** 用得到的那一点浏览器存储 */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 刚发布成功：记下这一份和现在的时刻。记不下（比如无痕模式）就算了 */
export function rememberPublished(store: Store, set: LevelSet, now: number): void {
  try {
    store.setItem(PUBLISHED_KEY, JSON.stringify({ at: now, set }));
  } catch {
    // 记不下就不记：最坏不过是回到没有这层保护的样子
  }
}

/**
 * 这个浏览器两分钟之内发布过的那一份；没有、过期了、读不懂，都是 null。
 * @param now 现在的时刻（毫秒）
 */
export function recentlyPublished(store: Store, now: number): LevelSet | null {
  try {
    const kept: unknown = JSON.parse(store.getItem(PUBLISHED_KEY) ?? 'null');
    if (typeof kept !== 'object' || kept === null) return null;
    const { at, set } = kept as { at?: unknown; set?: unknown };
    // 时刻比现在还晚，说明电脑的钟被拨过，这一份多新多旧说不准，不用
    if (typeof at !== 'number' || now < at || now - at >= TRUST_MS) return null;
    const checked = checkLevelSet(set);
    return checked.ok ? checked.set : null;
  } catch {
    return null;
  }
}
