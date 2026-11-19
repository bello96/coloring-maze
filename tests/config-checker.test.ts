// 配置页里管后台线程的那一层：排队、换图时作废重来、超时、出错。线程本身是假的，钟也是假的。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Verdict } from '../src/config/check.ts';
import { Checker, SOLVE_LIMIT_MS, type CheckState, type WorkerLike } from '../src/config/checker.ts';
import type { Repair } from '../src/solve/repair.ts';

class FakeWorker implements WorkerLike {
  readonly sent: Array<{ seq: number; rows: readonly string[] }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: unknown): void {
    this.sent.push(message as { seq: number; rows: readonly string[] });
  }
  terminate(): void {
    this.terminated = true;
  }
  /** 线程回了一条消息（针对它最近收到的那份图，除非另外指定 seq） */
  reply(body: object, seq = this.sent[this.sent.length - 1].seq): void {
    this.onmessage?.({ data: { seq, ...body } });
  }
}

const A = ['S....', '.....'];
const A2 = ['S...#', '.....'];
const B = ['S.#..', '.....'];
const C = ['S..#.', '.....'];
const OK: Verdict = { kind: 'ok', par: 4, solution: 'RDLU', safe: true };
const RISKY: Verdict = { kind: 'ok', par: 4, solution: 'RDLU', safe: false };
const UNSOLVABLE: Verdict = { kind: 'unsolvable' };
const FIX: Repair = { changes: [{ cell: 3, to: '#' }], rows: ['S..#.', '.....'] };

let workers: FakeWorker[];
let seen: Array<[id: string, state: CheckState]>;
let checker: Checker;
const last = (id: string): CheckState | undefined => seen.filter(([who]) => who === id).at(-1)?.[1];
const worker = (): FakeWorker => workers[workers.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  seen = [];
  checker = new Checker(
    () => {
      const made = new FakeWorker();
      workers.push(made);
      return made;
    },
    (id, state) => seen.push([id, state]),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checking one level', () => {
  it('sends the map to the thread and reports the verdict when it comes back', () => {
    checker.request('a', A);
    expect(workers).toHaveLength(1);
    expect(worker().sent).toEqual([{ seq: expect.any(Number), rows: A }]);
    expect(last('a')).toEqual({ phase: 'solving' });
    worker().reply({ verdict: OK });
    expect(last('a')).toEqual({ phase: 'done', verdict: OK });
    worker().reply({ done: true });
    expect(last('a')).toEqual({ phase: 'done', verdict: OK });
    expect(worker().terminated).toBe(false);
  });

  it('waits for a suggestion when the map cannot be finished', () => {
    checker.request('a', A);
    worker().reply({ verdict: UNSOLVABLE });
    expect(last('a')).toEqual({ phase: 'repairing', verdict: UNSOLVABLE });
    worker().reply({ repair: FIX });
    expect(last('a')).toEqual({ phase: 'done', verdict: UNSOLVABLE, repair: FIX });
    worker().reply({ done: true });
    expect(last('a')).toEqual({ phase: 'done', verdict: UNSOLVABLE, repair: FIX });
  });

  it('waits for a suggestion too when the map can be finished but might trap the player', () => {
    checker.request('a', A);
    worker().reply({ verdict: RISKY });
    expect(last('a')).toEqual({ phase: 'repairing', verdict: RISKY });
    worker().reply({ repair: FIX });
    expect(last('a')).toEqual({ phase: 'done', verdict: RISKY, repair: FIX });
  });

  it('takes a suggestion that comes before the verdict, and goes on waiting for the verdict', () => {
    // 形状没问题的图，线程先找建议、再算最少步数（见 worker.ts）
    checker.request('a', A);
    worker().reply({ repair: FIX });
    expect(last('a')).toEqual({ phase: 'solving', repair: FIX });
    worker().reply({ verdict: RISKY });
    expect(last('a')).toEqual({ phase: 'done', verdict: RISKY, repair: FIX });
    worker().reply({ done: true });
    expect(last('a')).toEqual({ phase: 'done', verdict: RISKY, repair: FIX });
  });

  it('uses one thread for one level after another', () => {
    checker.request('a', A);
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    checker.request('b', B);
    expect(workers).toHaveLength(1);
    expect(worker().sent.map((message) => message.rows)).toEqual([A, B]);
    expect(worker().sent[1].seq).not.toBe(worker().sent[0].seq);
  });
});

describe('when a map changes while it is being checked', () => {
  it('stops the thread, starts another and sends the new map', () => {
    checker.request('a', A);
    const first = worker();
    checker.request('a', A2);
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(worker().sent.map((message) => message.rows)).toEqual([A2]);
    expect(last('a')).toEqual({ phase: 'solving' });
  });

  it('goes on with that same level, not with one that was waiting behind it', () => {
    // 正在改的这一关就是用户正看着的：它的图又变了，接着算的应该还是它，而不是把它排到别的关后面
    checker.request('a', A);
    checker.request('b', B);
    checker.request('a', A2);
    expect(workers).toHaveLength(2);
    expect(worker().sent.map((message) => message.rows)).toEqual([A2]);
    expect(last('a')).toEqual({ phase: 'solving' });
    expect(last('b')).toEqual({ phase: 'queued' });
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    expect(worker().sent.map((message) => message.rows)).toEqual([A2, B]);
  });

  it('ignores whatever the stopped thread still has to say', () => {
    checker.request('a', A);
    const first = worker();
    const stale = first.sent[0].seq;
    checker.request('a', A2);
    first.reply({ verdict: UNSOLVABLE }, stale);
    expect(last('a')).toEqual({ phase: 'solving' });
    // 同一个线程上过时的编号也不认
    worker().reply({ verdict: UNSOLVABLE }, stale);
    expect(last('a')).toEqual({ phase: 'solving' });
    worker().reply({ verdict: OK });
    expect(last('a')).toEqual({ phase: 'done', verdict: OK });
  });

  it('checks only the newest map when it changes again before its turn has come', () => {
    checker.request('a', A);
    checker.request('b', B);
    checker.request('b', C);
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    expect(worker().sent.map((message) => message.rows)).toEqual([A, C]);
  });

  it('stops the thread too when the map changes while a suggestion is being looked for', () => {
    checker.request('a', A);
    worker().reply({ verdict: UNSOLVABLE });
    const first = worker();
    checker.request('a', A2);
    expect(first.terminated).toBe(true);
    expect(last('a')).toEqual({ phase: 'solving' });
  });
});

describe('several levels waiting', () => {
  it('lets the one being checked finish and then takes the next', () => {
    checker.request('a', A);
    checker.request('b', B);
    expect(last('b')).toEqual({ phase: 'queued' });
    expect(worker().sent).toHaveLength(1);
    expect(worker().terminated).toBe(false);
    worker().reply({ verdict: OK });
    expect(worker().sent).toHaveLength(1);
    worker().reply({ done: true });
    expect(worker().sent.map((message) => message.rows)).toEqual([A, B]);
    expect(last('b')).toEqual({ phase: 'solving' });
  });

  it('takes the level the user is looking at before the others', () => {
    checker.request('a', A);
    checker.request('b', B);
    checker.request('c', C);
    checker.prefer('c');
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    expect(worker().sent.map((message) => message.rows)).toEqual([A, C]);
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    expect(worker().sent.map((message) => message.rows)).toEqual([A, C, B]);
  });

  it('is not put out by preferring a level that is not waiting', () => {
    checker.request('a', A);
    checker.prefer('a');
    checker.prefer('nobody');
    expect(worker().sent).toHaveLength(1);
    expect(worker().terminated).toBe(false);
  });
});

describe('when the thread takes too long or breaks', () => {
  it('gives up on the fewest steps after three minutes, stops the thread and goes on with the next level', () => {
    expect(SOLVE_LIMIT_MS).toBe(180_000);
    checker.request('a', A);
    checker.request('b', B);
    const first = worker();
    vi.advanceTimersByTime(SOLVE_LIMIT_MS - 1);
    expect(last('a')).toEqual({ phase: 'solving' });
    expect(first.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(last('a')).toEqual({ phase: 'timeout' });
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(worker().sent.map((message) => message.rows)).toEqual([B]);
    expect(last('b')).toEqual({ phase: 'solving' });
  });

  it('does not count the time spent looking for a suggestion', () => {
    checker.request('a', A);
    vi.advanceTimersByTime(SOLVE_LIMIT_MS - 1000);
    worker().reply({ verdict: UNSOLVABLE });
    vi.advanceTimersByTime(600_000);
    expect(last('a')).toEqual({ phase: 'repairing', verdict: UNSOLVABLE });
    expect(worker().terminated).toBe(false);
    worker().reply({ repair: FIX });
    expect(last('a')).toEqual({ phase: 'done', verdict: UNSOLVABLE, repair: FIX });
  });

  it('keeps the suggestion it already has when the fewest steps take too long, or the thread gives up or breaks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 三分钟到了
    checker.request('a', A);
    worker().reply({ repair: FIX });
    vi.advanceTimersByTime(SOLVE_LIMIT_MS);
    expect(last('a')).toEqual({ phase: 'timeout', repair: FIX });
    // 线程自己说太难
    checker.request('b', B);
    worker().reply({ repair: FIX });
    worker().reply({ tooHard: true });
    expect(last('b')).toEqual({ phase: 'timeout', repair: FIX });
    worker().reply({ done: true });
    // 线程说这张图没算成
    checker.request('c', C);
    worker().reply({ repair: FIX });
    worker().reply({ failed: 'the solver did not load' });
    expect(last('c')).toEqual({ phase: 'failed', repair: FIX });
    worker().reply({ done: true });
    // 线程坏了
    checker.request('a', A2);
    worker().reply({ repair: FIX });
    worker().onerror?.(new Error('wasm did not load'));
    expect(last('a')).toEqual({ phase: 'failed', repair: FIX });
  });

  it('starts the three minutes afresh for each level', () => {
    checker.request('a', A);
    vi.advanceTimersByTime(SOLVE_LIMIT_MS - 1000);
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    checker.request('b', B);
    vi.advanceTimersByTime(SOLVE_LIMIT_MS - 1000);
    expect(last('b')).toEqual({ phase: 'solving' });
    expect(worker().terminated).toBe(false);
  });

  it('says the map is too hard when the thread itself gives up', () => {
    checker.request('a', A);
    checker.request('b', B);
    worker().reply({ tooHard: true });
    expect(last('a')).toEqual({ phase: 'timeout' });
    // 线程是自己停手的，还能接着用
    expect(worker().terminated).toBe(false);
    worker().reply({ done: true });
    expect(worker().sent.map((message) => message.rows)).toEqual([A, B]);
  });

  it('reports a failure when the thread says something went wrong with this map, and keeps the thread', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    checker.request('a', A);
    checker.request('b', B);
    worker().reply({ failed: 'the solver did not load' });
    expect(last('a')).toEqual({ phase: 'failed' });
    // 原因记在控制台里，方便查
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('the solver did not load'));
    expect(worker().terminated).toBe(false);
    worker().reply({ done: true });
    expect(workers).toHaveLength(1);
    expect(worker().sent.map((message) => message.rows)).toEqual([A, B]);
  });

  it('reports a failure when the thread breaks, and goes on with the next level on a new thread', () => {
    checker.request('a', A);
    checker.request('b', B);
    const first = worker();
    first.onerror?.(new Error('wasm did not load'));
    expect(last('a')).toEqual({ phase: 'failed' });
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(worker().sent.map((message) => message.rows)).toEqual([B]);
  });
});

describe('forgetting a level (it was deleted)', () => {
  it('takes it out of the queue', () => {
    checker.request('a', A);
    checker.request('b', B);
    checker.forget('b');
    worker().reply({ verdict: OK });
    worker().reply({ done: true });
    expect(worker().sent).toHaveLength(1);
  });

  it('stops the thread when that level is the one being checked, and goes on with the next', () => {
    checker.request('a', A);
    checker.request('b', B);
    const first = worker();
    checker.forget('a');
    expect(first.terminated).toBe(true);
    expect(worker().sent.map((message) => message.rows)).toEqual([B]);
    // 不再为它报告任何状态
    const before = seen.length;
    first.reply({ verdict: OK });
    expect(seen).toHaveLength(before);
  });

  it('does nothing for a level it has never heard of', () => {
    checker.forget('nobody');
    expect(workers).toHaveLength(0);
  });
});
