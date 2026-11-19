import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN } from '../src/game/levelset.ts';
import { devApi } from '../tools/dev-api.ts';
import { handle, type Env, type KV } from '../worker/api.ts';
import worker from '../worker/index.ts';

/** 假的 KV：内存里的一张表。broken 里记着的操作（比如 "put levels"）会出错，装作 KV 出了故障 */
class FakeKV implements KV {
  readonly data = new Map<string, string>();
  readonly broken = new Set<string>();
  async get(key: string): Promise<string | null> {
    if (this.broken.has(`get ${key}`)) throw new Error('KV 读不了');
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    if (this.broken.has(`put ${key}`)) throw new Error('KV 写不了');
    this.data.set(key, value);
  }
}

const SITE = 'https://maze.test';
/** 最简单的一张合格的图：第一行五格地面，起点在最左边，往右滚一步染完 */
const ROWS = ['S....', '#####', '#####', '#####', '#####'];
const good = (over: object = {}): Record<string, unknown> => ({ id: 'aa', rows: ROWS, dye: '#2646b8', par: 1, solution: 'R', ...over });
/** 把几关包成一份关卡表，写成请求体里的那种文字 */
const set = (...levels: unknown[]): string => JSON.stringify({ version: 1, levels });
/** 只有上面那一关（编号是 id）的关卡表，经过校验、整理之后存进 KV 的样子 */
const stored = (id: string): string =>
  `{"version":1,"levels":[{"id":"${id}","rows":["S....","#####","#####","#####","#####"],"dye":"#2646b8","par":1,"solution":"R"}]}`;

let kv: FakeKV;
beforeEach(() => {
  kv = new FakeKV();
});
afterEach(() => vi.restoreAllMocks());

interface CallInit {
  /** 口令：给了就带上 "Authorization: Bearer <口令>" */
  readonly token?: string;
  readonly body?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
}

/** 给接口发一个请求。不另说的话打的是 /api/levels，服务端配的口令是 secret */
function call(method: string, init: CallInit = {}, env: Partial<Env> = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  const request = new Request(`${SITE}${init.path ?? '/api/levels'}`, { method, headers, body: init.body });
  return handle(request, { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: 'secret', ...env });
}

/** 读出响应的状态码和 JSON 正文 */
async function answer(response: Promise<Response>): Promise<{ status: number; body: unknown }> {
  const got = await response;
  return { status: got.status, body: await got.json() };
}

/** 请求体分成几段送来（真实的大请求体就是这样一段一段到的） */
function inPieces(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

/** 带着对的口令、请求体是一个流的发布请求 */
function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  // duplex 是"请求体是流"时必须带的选项，TypeScript 自带的类型里还没有它
  const init = { method: 'PUT', headers: { Authorization: 'Bearer secret', ...headers }, body, duplex: 'half' };
  return new Request(`${SITE}/api/levels`, init as RequestInit);
}

describe('reading the published levels', () => {
  it('says there is nothing yet when no set has been published', async () => {
    const response = await call('GET');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('hands out the stored text exactly as it is', async () => {
    // 故意存一段排得很怪的文字：接口不该去解析、重排它
    const raw = '{ "version":1,\n  "levels": [] }';
    kv.data.set('levels', raw);
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
  });

  it('asks for no token, not even when the server has none set', async () => {
    kv.data.set('levels', stored('aa'));
    expect((await call('GET', {}, { LEVEL_ADMIN_TOKEN: undefined })).status).toBe(200);
  });

  it('does not mind a query string', async () => {
    kv.data.set('levels', stored('aa'));
    expect(await (await call('GET', { path: '/api/levels?t=1' })).text()).toBe(stored('aa'));
  });
});

describe('checking the token', () => {
  it('lets the right token in', async () => {
    expect(await answer(call('POST', { token: 'secret' }))).toEqual({ status: 200, body: { ok: true } });
  });

  const wrong: ReadonlyArray<readonly [name: string, headers: Record<string, string>]> = [
    ['no token at all', {}],
    ['a wrong token', { Authorization: 'Bearer wrong' }],
    ['the token cut short', { Authorization: 'Bearer secre' }],
    ['the token with something added', { Authorization: 'Bearer secret2' }],
    ['the token in capitals', { Authorization: 'Bearer SECRET' }],
    ['the token without the word Bearer', { Authorization: 'secret' }],
    ['the token under another scheme', { Authorization: 'Basic secret' }],
  ];

  it.each(wrong)('turns away %s', async (_name, headers) => {
    expect(await answer(call('POST', { headers }))).toEqual({ status: 401, body: { error: 'unauthorized' } });
  });

  it('turns away every one of a thousand wrong tokens', async () => {
    // 比口令时哪怕只漏比了一部分，一千个错口令里也会有蒙对的
    for (let i = 0; i < 1000; i++) {
      const response = await call('POST', { token: `wrong-${i}` });
      expect(response.status, `口令 wrong-${i}`).toBe(401);
    }
  });

  it('only checks: a POST publishes nothing, whatever it carries', async () => {
    expect(await answer(call('POST', { token: 'secret', body: set(good()) }))).toEqual({ status: 200, body: { ok: true } });
    expect(kv.data.size).toBe(0);
  });

  // 忘了配口令不等于谁都能写。"Bearer undefined" 和光秃秃的 "Bearer " 是最容易蒙混过去的两种
  const nobody = [undefined, ''].flatMap((configured) =>
    ['POST', 'PUT'].flatMap((method) => ['undefined', '', undefined].map((token) => [method, configured, token] as const)),
  );

  it.each(nobody)('turns away a %s when the token on the server is %j and the request brings %j', async (method, configured, token) => {
    const response = call(method, { token, body: set(good()) }, { LEVEL_ADMIN_TOKEN: configured });
    expect(await answer(response)).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(kv.data.size).toBe(0);
  });
});

describe('publishing', () => {
  it('stores the checked set and says how many levels it has', async () => {
    // 请求体里多带了不认识的字段、染料写成大写、还排了版：存下来的应该是整理过的那一份
    const body = JSON.stringify({ version: 1, note: 'x', levels: [good({ dye: '#2646B8', extra: 1 })] }, null, 2);
    expect(await answer(call('PUT', { token: 'secret', body }))).toEqual({ status: 200, body: { ok: true, count: 1 } });
    expect(kv.data.get('levels')).toBe(stored('aa'));
    // 第一次发布，没有"上一版"可留
    expect(kv.data.has('levels:prev')).toBe(false);
    expect(await (await call('GET')).text()).toBe(stored('aa'));
  });

  it('keeps the set it replaces as the one before', async () => {
    await call('PUT', { token: 'secret', body: set(good()) });
    expect((await call('PUT', { token: 'secret', body: set(good({ id: 'bb' })) })).status).toBe(200);
    expect([kv.data.get('levels:prev'), kv.data.get('levels')]).toEqual([stored('aa'), stored('bb')]);

    await call('PUT', { token: 'secret', body: set(good({ id: 'cc' })) });
    expect([kv.data.get('levels:prev'), kv.data.get('levels')]).toEqual([stored('bb'), stored('cc')]);
  });

  it('takes the 80 built-in levels', async () => {
    expect(await answer(call('PUT', { token: 'secret', body: JSON.stringify(BUILTIN) }))).toEqual({ status: 200, body: { ok: true, count: 80 } });
    expect(JSON.parse(kv.data.get('levels') ?? '')).toEqual(BUILTIN);
  });

  it('turns away a wrong token and leaves what is published alone', async () => {
    kv.data.set('levels', stored('aa'));
    expect(await answer(call('PUT', { token: 'wrong', body: set(good({ id: 'bb' })) }))).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect([...kv.data]).toEqual([['levels', stored('aa')]]);
  });

  it('turns down a body that is not JSON', async () => {
    expect(await answer(call('PUT', { token: 'secret', body: '{oops' }))).toEqual({
      status: 400,
      body: { error: 'invalid', detail: expect.stringMatching(/JSON/), level: 0 },
    });
    expect(kv.data.size).toBe(0);
  });

  it('says which level is wrong, counting from 1, and leaves what is published alone', async () => {
    kv.data.set('levels', stored('aa'));
    // 第 2 关的地面被一堵墙断成了两片
    const body = set(good(), good({ id: 'bb', rows: ['S.#..', '#####', '#####', '#####', '#####'] }));
    expect(await answer(call('PUT', { token: 'secret', body }))).toEqual({
      status: 400,
      body: { error: 'invalid', detail: expect.stringMatching(/连成一片/), level: 2 },
    });
    expect([...kv.data]).toEqual([['levels', stored('aa')]]);
  });

  // 请求体是不可信的 JSON：类型不对的东西只能换来一个 400，不能让接口出错
  const odd: ReadonlyArray<readonly [name: string, body: string | undefined, level: number]> = [
    ['levels that are a string', '{"version":1,"levels":"x"}', 0],
    ['rows that are numbers', set(good({ rows: [1, 2, 3, 4, 5] })), 1],
    ['a level that is null', '{"version":1,"levels":[null]}', 1],
    ['fewest steps with a fraction', set(good({ par: 1.5 })), 1],
    ['a second level whose route is null', set(good(), good({ id: 'bb', solution: null })), 2],
    ['null', 'null', 0],
    ['a bare list', '[]', 0],
    ['a bare number', '7', 0],
    ['an empty body', '', 0],
    ['no body at all', undefined, 0],
  ];

  it.each(odd)('turns down %s with a 400', async (_name, body, level) => {
    expect(await answer(call('PUT', { token: 'secret', body }))).toEqual({
      status: 400,
      body: { error: 'invalid', detail: expect.stringMatching(/./), level },
    });
    expect(kv.data.size).toBe(0);
  });

  describe('a body that is too large', () => {
    const tooLarge = { status: 413, body: { error: 'too_large', detail: expect.stringMatching(/./) } };

    it('is turned down at 1,000,001 bytes', async () => {
      expect(await answer(call('PUT', { token: 'secret', body: 'x'.repeat(1_000_001) }))).toEqual(tooLarge);
      expect(kv.data.size).toBe(0);
    });

    it('is turned down even when Content-Length claims it is small', async () => {
      const response = call('PUT', { token: 'secret', body: 'x'.repeat(1_000_001), headers: { 'Content-Length': '10' } });
      expect(await answer(response)).toEqual(tooLarge);
      expect(kv.data.size).toBe(0);
    });

    it('is not even read when Content-Length already says so', async () => {
      const request = new Request(`${SITE}/api/levels`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer secret', 'Content-Length': '1000001' },
        body: 'x'.repeat(1_000_001),
      });
      expect(await answer(handle(request, { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: 'secret' }))).toEqual(tooLarge);
      expect(request.bodyUsed).toBe(false);
    });

    it('is measured in bytes, not characters', async () => {
      // 40 万个汉字：字符数远不到一百万，字节数是 120 万
      expect(await answer(call('PUT', { token: 'secret', body: '字'.repeat(400_000) }))).toEqual(tooLarge);
    });

    it('is turned down when it arrives in pieces that only together go over', async () => {
      const piece = 'x'.repeat(400_000);
      expect(await answer(handle(streamed(inPieces(piece, piece, piece)), { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: 'secret' }))).toEqual(tooLarge);
    });

    it('starts one byte past a million: exactly 1,000,000 bytes still go through', async () => {
      // JSON 后面可以跟空白，用空格把一份合格的关卡表垫到正好一百万字节
      const exact = set(good()).padEnd(1_000_000, ' ');
      const taken = { status: 200, body: { ok: true, count: 1 } };
      expect(await answer(call('PUT', { token: 'secret', body: exact }))).toEqual(taken);
      // 浏览器发的请求会如实报上长度，报的正好是一百万也得收
      expect(await answer(call('PUT', { token: 'secret', body: exact, headers: { 'Content-Length': '1000000' } }))).toEqual(taken);
      expect(await answer(call('PUT', { token: 'secret', body: `${exact} ` }))).toEqual(tooLarge);
    });
  });

  it('puts a body together that arrives in pieces', async () => {
    const whole = set(good());
    const request = streamed(inPieces(whole.slice(0, 7), whole.slice(7, 60), whole.slice(60)));
    expect(await answer(handle(request, { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: 'secret' }))).toEqual({ status: 200, body: { ok: true, count: 1 } });
    expect(kv.data.get('levels')).toBe(stored('aa'));
  });
});

describe('everything else under /api/', () => {
  it.each(['DELETE', 'PATCH'])('does not allow %s on the levels', async (method) => {
    kv.data.set('levels', stored('aa'));
    expect(await answer(call(method, { token: 'secret' }))).toEqual({ status: 405, body: { error: 'method_not_allowed' } });
    expect([...kv.data]).toEqual([['levels', stored('aa')]]);
  });

  it.each(['/api/other', '/api/', '/api/levels/', '/api/levels/1', '/api/levels2'])('knows nothing at %s', async (path) => {
    // 线上有关卡的时候问：免得"认错了路径、当成读关卡"也碰巧回 404
    kv.data.set('levels', stored('aa'));
    expect(await answer(call('GET', { path }))).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('publishes nothing through another path', async () => {
    expect(await answer(call('PUT', { token: 'secret', path: '/api/other', body: set(good()) }))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(kv.data.size).toBe(0);
  });

  it('marks every answer as JSON that nothing may cache', async () => {
    const answers = [
      await call('GET'),
      await call('PUT', { token: 'secret', body: set(good()) }),
      await call('GET'),
      await call('POST', { token: 'secret' }),
      await call('POST'),
      await call('PUT', { token: 'secret', body: '{oops' }),
      await call('PUT', { token: 'secret', body: 'x'.repeat(1_000_001) }),
      await call('DELETE'),
      await call('GET', { path: '/api/other' }),
    ];
    expect(answers.map((response) => response.status)).toEqual([404, 200, 200, 200, 401, 400, 413, 405, 404]);
    for (const response of answers) {
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
});

describe('when the store itself fails', () => {
  it('answers 500 as JSON and leaves a line in the log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    kv.broken.add('get levels');
    const response = await call('GET');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('has already put the old set aside by the time it writes the new one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kv.data.set('levels', stored('aa'));
    kv.broken.add('put levels');
    expect((await call('PUT', { token: 'secret', body: set(good({ id: 'bb' })) })).status).toBe(500);
    // 新的没写成：线上还是旧的那份，而且它已经另存好了
    expect([...kv.data]).toEqual([
      ['levels', stored('aa')],
      ['levels:prev', stored('aa')],
    ]);
  });
});

describe('the Worker entry', () => {
  /** 假的静态资源：记下交过来的请求，回一张固定的页面 */
  function site(): { readonly seen: Request[]; readonly page: Response; readonly env: Env & { ASSETS: { fetch(request: Request): Promise<Response> } } } {
    const seen: Request[] = [];
    const page = new Response('<p>页面</p>');
    const ASSETS = {
      async fetch(request: Request): Promise<Response> {
        seen.push(request);
        return page;
      },
    };
    return { seen, page, env: { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: 'secret', ASSETS } };
  }

  it('answers what is under /api/ itself', async () => {
    const { seen, env } = site();
    kv.data.set('levels', stored('aa'));
    const response = await worker.fetch(new Request(`${SITE}/api/levels`), env);
    expect(await response.text()).toBe(stored('aa'));
    expect(seen).toHaveLength(0);
  });

  it.each(['/', '/config', '/assets/main.js', '/apiary'])('hands %s over to the static files', async (path) => {
    const { seen, page, env } = site();
    const request = new Request(`${SITE}${path}`);
    expect(await worker.fetch(request, env)).toBe(page);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(request);
  });

  it.each(['/1', '/12', '/200', '/12/', '/012'])('answers %s, the address of a level, with the page of the game', async (path) => {
    const { seen, page, env } = site();
    const request = new Request(`${SITE}${path}`, { headers: { accept: 'text/html', 'if-none-match': '"abc"' } });
    expect(await worker.fetch(request, env)).toBe(page);
    // 没有 /12 这么个文件：向静态资源要的是网站的根地址，那里就是游戏那一页。请求头原样带过去
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${SITE}/`);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].headers.get('accept')).toBe('text/html');
    expect(seen[0].headers.get('if-none-match')).toBe('"abc"');
  });

  it.each(['/abc', '/0', '/12/3', '/1.5', '/12abc', '/1234567', '/12.html'])('leaves %s, which is no level, for the static files to turn down', async (path) => {
    const { seen, env } = site();
    const request = new Request(`${SITE}${path}`);
    await worker.fetch(request, env);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(request);
  });

  it('gives the page of the game only to someone reading a level address, not posting to it', async () => {
    const { seen, env } = site();
    const request = new Request(`${SITE}/12`, { method: 'POST', body: 'x' });
    await worker.fetch(request, env);
    expect(seen[0]).toBe(request);
  });
});

describe('the stand-in API of the dev and preview servers', () => {
  type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
  type Hook = 'configureServer' | 'configurePreviewServer';
  const HOOKS: readonly Hook[] = ['configureServer', 'configurePreviewServer'];

  /** 一个临时目录，装作项目的根目录：不另说的话，插件把它的 KV 文件放在这下面的 node_modules/.cache 里 */
  let root: string;
  const kvFile = (): string => join(root, 'node_modules/.cache/coloring-maze/dev-kv.json');
  const running: Server[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'maze-dev-api-'));
    // 跑测试的这个终端里就算设了 MAZE_DEV_KV，也不能让它把文件引到别处去
    vi.stubEnv('MAZE_DEV_KV', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const closing = running.splice(0).map(
      (server) =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    );
    await Promise.all(closing);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * 像 Vite 那样把插件挂到一个真的 HTTP 服务器上（hook 说的是开发服务器还是预览服务器的那个钩子），返回服务器的地址。
   * 插件不管的请求会落到最后那个处理函数上：它回 299，正文是 "passed on: " 加上它看到的路径。
   */
  async function serve(hook: Hook): Promise<string> {
    const used: Middleware[] = [];
    const configure = devApi()[hook] as unknown as (server: unknown) => void;
    configure({ config: { root }, middlewares: { use: (middleware: Middleware) => used.push(middleware) } });
    const last: Middleware = (req, res) => {
      res.statusCode = 299;
      res.end(`passed on: ${req.url}`);
    };
    const server = createServer((req, res) => {
      const chain = [...used, last];
      const step = (i: number): void =>
        chain[i](req, res, (error) => {
          if (error === undefined) return step(i + 1);
          res.statusCode = 599;
          res.end(String(error));
        });
      step(0);
    });
    running.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const publish = (base: string, body: string, token = 'dev-token'): Promise<Response> =>
    fetch(`${base}/api/levels`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body });
  const passedOn = async (base: string, path: string): Promise<string> => (await fetch(`${base}${path}`)).text();

  it.each(HOOKS)('answers /api/levels with the real handler when added through %s', async (hook) => {
    const base = await serve(hook);
    expect(await answer(fetch(`${base}/api/levels`))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await answer(publish(base, set(good())))).toEqual({ status: 200, body: { ok: true, count: 1 } });

    const response = await fetch(`${base}/api/levels`);
    expect(await response.text()).toBe(stored('aa'));
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    // 校验不过时说的话也是处理函数的原话
    const broken = set(good(), good({ id: 'bb', rows: ['S.#..', '#####', '#####', '#####', '#####'] }));
    expect(await answer(publish(base, broken))).toEqual({
      status: 400,
      body: { error: 'invalid', detail: expect.stringMatching(/连成一片/), level: 2 },
    });
  });

  it('keeps what is published in a JSON file under node_modules/.cache, making the folders when they are missing', async () => {
    const base = await serve('configureServer');
    // 只是读一下的话，不该留下任何文件
    await fetch(`${base}/api/levels`);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);

    await publish(base, set(good()));
    await publish(base, set(good({ id: 'bb' })));
    expect(JSON.parse(readFileSync(kvFile(), 'utf8'))).toEqual({ levels: stored('bb'), 'levels:prev': stored('aa') });
  });

  it('still has it after a restart, and in the preview server too', async () => {
    await publish(await serve('configureServer'), set(good()));
    const later = await serve('configurePreviewServer');
    expect(await (await fetch(`${later}/api/levels`)).text()).toBe(stored('aa'));
  });

  it('puts the file where MAZE_DEV_KV says', async () => {
    const file = join(root, 'elsewhere', 'deeper', 'kv.json');
    vi.stubEnv('MAZE_DEV_KV', file);
    await publish(await serve('configureServer'), set(good()));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ levels: stored('aa') });
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });

  it('reads a MAZE_DEV_KV that is not a full path from the project folder', async () => {
    vi.stubEnv('MAZE_DEV_KV', 'maze-test-kv/kv.json');
    await publish(await serve('configureServer'), set(good()));
    expect(JSON.parse(readFileSync(join(root, 'maze-test-kv', 'kv.json'), 'utf8'))).toEqual({ levels: stored('aa') });
  });

  it('takes dev-token, and nothing else, as the token', async () => {
    const base = await serve('configureServer');
    const check = (token: string): Promise<Response> => fetch(`${base}/api/levels`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect((await check('dev-token')).status).toBe(200);
    expect((await check('secret')).status).toBe(401);
    expect((await publish(base, set(good()), 'dev-token2')).status).toBe(401);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });

  it('passes a large request body through whole', async () => {
    // 内置 80 关轮着排满 200 关，六万多字节：一个网络包装不下，会分几段到
    const many = { version: 1, levels: Array.from({ length: 200 }, (_, i) => ({ ...BUILTIN.levels[i % 80], id: `r${i}` })) };
    const base = await serve('configureServer');
    expect(await answer(publish(base, JSON.stringify(many)))).toEqual({ status: 200, body: { ok: true, count: 200 } });
    expect(await (await fetch(`${base}/api/levels`)).json()).toEqual(many);
  });

  it.each(HOOKS)('shows /config as config.html and leaves every other path alone (%s)', async (hook) => {
    const base = await serve(hook);
    expect(await passedOn(base, '/config')).toBe('passed on: /config.html');
    expect(await passedOn(base, '/config?from=game')).toBe('passed on: /config.html?from=game');
    for (const path of ['/', '/index.html', '/src/main.ts?t=1', '/configure', '/config/x', '/apiary', '/api']) {
      expect(await passedOn(base, path)).toBe(`passed on: ${path}`);
    }
  });

  it('answers 500 when the file is not something it wrote, and goes on serving', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(dirname(kvFile()), { recursive: true });
    writeFileSync(kvFile(), '{oops');
    const base = await serve('configureServer');
    expect(await answer(fetch(`${base}/api/levels`))).toEqual({ status: 500, body: { error: 'internal' } });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(await passedOn(base, '/')).toBe('passed on: /');
    // 坏掉的文件原样留着，等人来看，不悄悄盖掉
    expect(readFileSync(kvFile(), 'utf8')).toBe('{oops');
  });
});
