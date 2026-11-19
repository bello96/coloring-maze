// 配置页和服务端打交道的那一层：服务端各种各样的回应，各归成哪一种结果。
// 这些结果决定页面上说什么、发布算不算成功，所以一种一种钉住。fetch 是假的。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLevels, publishLevels, verifyToken } from '../src/config/api.ts';
import { BUILTIN, type LevelSet } from '../src/game/levelset.ts';

const SET: LevelSet = { version: 1, levels: [BUILTIN.levels[0], BUILTIN.levels[1]] };
const BROKEN = { version: 1, levels: [{ ...BUILTIN.levels[0], rows: ['S.#..', '#####', '#####', '#####', '#####'] }] };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
let calls: Call[];
/** 下一次请求怎么回：给一个响应，或者给一个错误（请求根本没发成） */
function answer(next: Response | Error): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body });
    if (next instanceof Error) throw next;
    return next;
  });
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('asking whether a token is right', () => {
  it('sends the token the way the server wants it', async () => {
    answer(json(200, { ok: true }));
    expect(await verifyToken('s3cret')).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/levels', method: 'POST', headers: { Authorization: 'Bearer s3cret' } });
  });

  it('says "denied" only when the server says so', async () => {
    answer(json(401, { error: 'unauthorized' }));
    expect(await verifyToken('nope')).toBe('denied');
  });

  it.each([500, 503, 404, 429])('says the server could not be asked when it answers %i', async (status) => {
    answer(json(status, {}));
    expect(await verifyToken('s3cret')).toBe('unreachable');
  });

  it('says the server could not be asked when the request does not get through', async () => {
    answer(new TypeError('Failed to fetch'));
    expect(await verifyToken('s3cret')).toBe('unreachable');
  });
});

describe('reading what is published', () => {
  it('gives the set, tidied by the same check the server uses', async () => {
    answer(json(200, { ...SET, extra: 1 }));
    expect(await fetchLevels()).toEqual({ kind: 'set', set: SET });
    expect(calls[0]).toMatchObject({ url: '/api/levels', method: 'GET' });
  });

  it('says nothing has been published yet on a 404', async () => {
    answer(json(404, { error: 'not_found' }));
    expect(await fetchLevels()).toEqual({ kind: 'empty' });
  });

  it.each<readonly [string, Response | Error]>([
    ['the server is in trouble', json(500, { error: 'internal' })],
    ['the request does not get through', new TypeError('Failed to fetch')],
    ['the answer is not JSON', new Response('<html>', { status: 200 })],
    ['the published set does not pass the check', json(200, BROKEN)],
    ['the answer is JSON of another shape', json(200, [1, 2, 3])],
  ])('says it cannot read the levels when %s — never "nothing published", which would invite overwriting them', async (_name, response) => {
    answer(response);
    expect(await fetchLevels()).toEqual({ kind: 'broken' });
  });
});

describe('publishing', () => {
  it('sends the whole set with the token', async () => {
    answer(json(200, { ok: true, count: 2 }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'ok' });
    expect(calls[0]).toMatchObject({ url: '/api/levels', method: 'PUT', headers: { Authorization: 'Bearer s3cret' } });
    expect(JSON.parse(calls[0].body as string)).toEqual(SET);
  });

  it('says the token no longer works on a 401', async () => {
    answer(json(401, { error: 'unauthorized' }));
    expect(await publishLevels('old', SET)).toEqual({ kind: 'denied' });
  });

  it('passes on which level the server turned down, and why', async () => {
    answer(json(400, { error: 'invalid', detail: '地面要连成一片', level: 2 }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'invalid', detail: '地面要连成一片', level: 2 });
  });

  it('says level 0 when the trouble is not with one particular level', async () => {
    answer(json(400, { error: 'invalid', detail: '关卡表的格式不对', level: 0 }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'invalid', detail: '关卡表的格式不对', level: 0 });
    answer(json(400, { error: 'invalid', detail: '关卡表的格式不对', level: 'x' }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'invalid', detail: '关卡表的格式不对', level: 0 });
  });

  it('treats a 400 that gives no reason like any other failure', async () => {
    answer(json(400, { error: 'bad request' }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'failed', status: 400 });
    answer(new Response('<html>', { status: 400 }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'failed', status: 400 });
  });

  it.each([413, 429, 500, 503])('reports a failure with the status when the server answers %i', async (status) => {
    answer(json(status, { error: 'x' }));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'failed', status });
  });

  it('reports a failure without a status when the request does not get through', async () => {
    answer(new TypeError('Failed to fetch'));
    expect(await publishLevels('s3cret', SET)).toEqual({ kind: 'failed', status: null });
  });

  it('never counts anything but a 200 as published', async () => {
    for (const status of [201, 204, 301, 302]) {
      answer(new Response(null, { status }));
      expect((await publishLevels('s3cret', SET)).kind, String(status)).toBe('failed');
    }
  });
});
