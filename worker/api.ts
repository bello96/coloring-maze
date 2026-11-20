// 关卡接口：GET 读线上的关卡表（谁都能读），POST 只验口令（配置页进门用），PUT 发布（要口令）。
//
// 写成一个纯函数——请求进，响应出；KV 只用下面那个小接口描述，不依赖 Cloudflare 的类型。
// 所以同一个函数三处用：线上的 Worker（worker/index.ts，KV 是 Cloudflare 的）、
// 开发和预览服务器（tools/dev-api.ts，KV 是本地的一个 JSON 文件）、测试（内存里的假 KV）。
//
// 按 Cloudflare 免费版的限额来设计：每次请求只有 10 毫秒 CPU（等 KV 读写的时间不算在内，限额的出处见 wrangler.jsonc）。
// 所以发布时只跑关卡表的基本校验（checkLevelSet：格式、形状、照着给出的走法确实能通关），
// "步数是不是最少""会不会走进死局"这些贵的，都由配置页在浏览器里算好。
//
// 发布时要算的就是 JSON.parse + checkLevelSet + JSON.stringify 这三步。实测要多久——
// 2026-11-18，Node 24.13，Core Ultra 5 125H（大小核）。每份关卡表三步连着跑 50 次，各起新进程量了几轮
// （量的时候这台机器上还在跑别的测试，所以是个范围，机器闲时靠近小的那头）：
//                                                            头一次（代码还没热）   50 次的中位数
//   内置 80 关原样发布（29 611 字节）                              4–6 毫秒             1.1–1.2 毫秒
//   最坏情况：200 关、每关都是内置第 80 关                          7–12 毫秒            2.2–3.9 毫秒
//     （23×17，154 步；135 424 字节）
// 2026-11-20 把最大的图放宽到 25×20 之后又量了一遍（同一台机器，各起四次新进程）：
//   内置 80 关原样发布（29 611 字节）                              3–6 毫秒             1.2–1.6 毫秒
//   原来的最坏情况：200 关都是 23×17（135 314 字节）                7–13 毫秒            2.5–3.4 毫秒
//   现在的最坏情况：200 关都是 25×20、179 步（163 329 字节）         9–12 毫秒            3.4–3.6 毫秒
// 线上发布一次更像"头一次"——校验的代码平时没人跑，轮到发布时多半是冷的。
// 所以平常大小的关卡表有一倍左右的余量；把 200 关全配成最大的图，头一次会贴着 10 毫秒的线，甚至过线。
// 超了的请求 Cloudflare 回的是错误 1102，走不到下面任何一种响应（配置页会显示"发布失败"，再点一次多半就过了）。
// 这些数字是在 Node 里量的，不是在 Workers 的运行时里；上线后第一次发布时值得看一眼真实的 CPU 时间。
//
// 为了这个限额，校验里有三处是特意往快里写的，改动它们之前先想想这里：shape.ts 的 floorConnected（原来光它就要七八毫秒）、
// levelset.ts 里照走法回放的 follow、和边查字符边读图的那一段。优化前的数字是：内置 80 关 2.4–5.9 毫秒、
// 最坏情况 10–17 毫秒（头一次 16–40 毫秒）。
import { checkLevelSet } from '../src/game/levelset.ts';

/** 用得到的那一点 KV：按键读一段文字、按键存一段文字。Cloudflare 的 KV 绑定正好有这两个方法 */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  /** 存关卡表的 KV：键 levels 是现在这一版，键 levels:prev 是它顶替掉的上一版 */
  readonly LEVELS_KV: KV;
  /** 管理口令（线上是 Worker 的密钥）。没配、或者配成空的，就谁都写不了 */
  readonly LEVEL_ADMIN_TOKEN?: string;
}

/** 发布的请求体最多这么多字节，再大的不会是正经的关卡表 */
export const MAX_BODY = 1_000_000;

const CURRENT = 'levels';
const PREVIOUS = 'levels:prev';

// 发布之后玩家一刷新就要生效，所以哪一层都不许缓存
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/**
 * 两段文字是不是一样。不直接比：先各算一遍 SHA-256，再把两份 32 个字节从头到尾比完、中途不停。
 * 这样花多少时间和"对了前几位""口令有多长"都没有关系，没法靠响应的快慢把口令一位一位猜出来。
 */
async function sameText(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [first, second] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const left = new Uint8Array(first);
  const right = new Uint8Array(second);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** 请求带的口令对不对。服务端没配口令时谁都不对——忘了配不等于谁都能写 */
async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = env.LEVEL_ADMIN_TOKEN;
  if (!token) return false;
  return sameText(request.headers.get('Authorization') ?? '', `Bearer ${token}`);
}

/** 把请求体读成文字。超过 MAX_BODY 字节的不读完，返回 null */
async function readBody(request: Request): Promise<string | null> {
  // 先看它自己报的长度：报出来就太大的，一个字节都不用读
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return null;
  if (!request.body) return '';
  // 报的长度不一定准，也可能根本没报，所以边读边数，一过线就停——不把超大的请求体整个收进内存
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** 发布：通过校验才存，存的是校验函数整理过的那一份 */
async function publish(request: Request, env: Env): Promise<Response> {
  const text = await readBody(request);
  if (text === null) return json({ error: 'too_large', detail: `请求体不能超过 ${MAX_BODY} 字节` }, 413);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: 'invalid', detail: '请求体不是合法的 JSON', level: 0 }, 400);
  }
  const checked = checkLevelSet(data);
  // 校验函数里的关卡从 0 数起、-1 表示"不是某一关的问题"；接口对外从 1 数起，0 表示"不是某一关的问题"
  if (!checked.ok) return json({ error: 'invalid', detail: checked.detail, level: checked.level + 1 }, 400);

  // 先把线上现在这一版另存好，再写新的：万一发错了可以用 wrangler 手动恢复；
  // 而且就算写新的那一步失败了，线上也还是完整的旧版
  const old = await env.LEVELS_KV.get(CURRENT);
  if (old !== null) await env.LEVELS_KV.put(PREVIOUS, old);
  await env.LEVELS_KV.put(CURRENT, JSON.stringify(checked.set));
  return json({ ok: true, count: checked.set.levels.length }, 200);
}

async function respond(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== '/api/levels') return json({ error: 'not_found' }, 404);
  switch (request.method) {
    case 'GET': {
      // KV 里存的就是一段校验过的 JSON 文字，原样交出去；还没发布过就是 404
      const raw = await env.LEVELS_KV.get(CURRENT);
      return raw === null ? json({ error: 'not_found' }, 404) : new Response(raw, { status: 200, headers: HEADERS });
    }
    case 'POST':
      return (await authorized(request, env)) ? json({ ok: true }, 200) : json({ error: 'unauthorized' }, 401);
    case 'PUT':
      return (await authorized(request, env)) ? publish(request, env) : json({ error: 'unauthorized' }, 401);
    default:
      return json({ error: 'method_not_allowed' }, 405);
  }
}

/** 处理 /api/ 下的一个请求。什么情况下都给出一个 JSON 响应，不抛异常 */
export async function handle(request: Request, env: Env): Promise<Response> {
  try {
    return await respond(request, env);
  } catch (error) {
    // 走到这里是 KV 读写失败之类的意外：记一句，回 500，不把异常漏出去让平台回一张 HTML 的错误页
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: '关卡接口出错', method: request.method, error: reason }));
    return json({ error: 'internal' }, 500);
  }
}
