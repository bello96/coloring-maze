// 配置页和服务端打交道的三件事：验口令、读线上的关卡表、发布。接口的约定见 worker/api.ts。
// 这里只管发请求，把服务端各种各样的回应归成几种结果；每种结果在页面上怎么说，由用到的地方定。
import { checkLevelSet, type LevelSet } from '../game/levelset.ts';

const ENDPOINT = '/api/levels';

const note = (what: string): void => console.warn(`[关卡] ${what}`);

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 响应的内容用不着，也把它读完再丢。
 * 只看状态码、不读内容的话，这个请求在浏览器那里一直算"没结束"，白占着一条连接
 * （直接掐掉也行，但开发者工具里会把它记成一条失败的请求，看着吓人）。
 */
function discard(res: Response): void {
  res.arrayBuffer().catch(() => undefined);
}

/** 验口令的结果：ok 口令对；denied 口令不对；unreachable 没问成（断网、服务端出错） */
export type Verified = 'ok' | 'denied' | 'unreachable';

/** 问服务端这个口令对不对。不抛异常 */
export async function verifyToken(token: string): Promise<Verified> {
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    discard(res);
    if (res.status === 200) return 'ok';
    if (res.status === 401) return 'denied';
    note(`验口令时服务端回的是 ${res.status}`);
    return 'unreachable';
  } catch (err) {
    note(`验口令的请求没发成（${reason(err)}）`);
    return 'unreachable';
  }
}

/** 读线上关卡的结果：set 读到了；empty 还没发布过；broken 读不到，或者读到的通不过校验 */
export type Fetched = { readonly kind: 'set'; readonly set: LevelSet } | { readonly kind: 'empty' } | { readonly kind: 'broken' };

/** 读线上现在的关卡表。不抛异常 */
export async function fetchLevels(): Promise<Fetched> {
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store' });
    if (res.status !== 200) {
      discard(res);
      if (res.status === 404) return { kind: 'empty' };
      note(`读线上的关卡时服务端回的是 ${res.status}`);
      return { kind: 'broken' };
    }
    const checked = checkLevelSet(await res.json());
    if (checked.ok) return { kind: 'set', set: checked.set };
    note(`线上的关卡通不过校验：${checked.level < 0 ? '' : `第 ${checked.level + 1} 关，`}${checked.detail}`);
    return { kind: 'broken' };
  } catch (err) {
    note(`读线上的关卡没读成（${reason(err)}）`);
    return { kind: 'broken' };
  }
}

/** 发布的结果 */
export type Published =
  | { readonly kind: 'ok' }
  /** 服务端校验没过。level 是出问题的那一关排第几（从 1 数起），不是某一关的问题时是 0 */
  | { readonly kind: 'invalid'; readonly level: number; readonly detail: string }
  /** 口令不管用了 */
  | { readonly kind: 'denied' }
  /** 别的情况。status 是服务端回的状态码；请求根本没发成是 null */
  | { readonly kind: 'failed'; readonly status: number | null };

/** 把这份关卡表发布到线上。不抛异常 */
export async function publishLevels(token: string, set: LevelSet): Promise<Published> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(set),
    });
  } catch (err) {
    note(`发布的请求没发成（${reason(err)}）`);
    return { kind: 'failed', status: null };
  }
  if (res.status !== 400) {
    discard(res);
    if (res.status === 200) return { kind: 'ok' };
    if (res.status === 401) return { kind: 'denied' };
    note(`发布时服务端回的是 ${res.status}`);
    return { kind: 'failed', status: res.status };
  }
  const body: unknown = await res.json().catch(() => null);
  const { detail, level } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  // 400 却说不出原因的（不是我们的接口回的），和别的失败一样对待
  if (typeof detail !== 'string' || detail === '') return { kind: 'failed', status: 400 };
  return { kind: 'invalid', detail, level: typeof level === 'number' && Number.isInteger(level) && level > 0 ? level : 0 };
}
