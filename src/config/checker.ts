// 配置页里管后台线程的那一层。最少步数要在后台线程里算（大图要几秒到一两分钟，不能卡住界面），这里负责：
// 排队（一次只算一关，用户正看着的那一关优先）、图又改了就作废重来、算太久就放弃、线程坏了换一个。
// 线程里的求解是一口气算到底的，中途叫不停，所以"作废"和"放弃"都是直接结束线程、另起一个。
import { wantsAdvice, type Verdict } from './check.ts';
import type { Repair } from '../solve/repair.ts';

/** queued 排着队；solving 线程正在查这张图，结论还没来；repairing 结论有了，还在等修改建议；done 都好了；timeout 太复杂算不出最少步数；failed 线程出了错 */
export type CheckPhase = 'queued' | 'solving' | 'repairing' | 'done' | 'timeout' | 'failed';

export interface CheckState {
  readonly phase: CheckPhase;
  readonly verdict?: Verdict;
  /** 修改建议。图不合格就一定会有一条，可能比结论先到；还没到、或者图用不着建议，就没有这一项 */
  readonly repair?: Repair;
}

/** 主线程发给后台线程的：算这张图。seq 是这一次的编号，线程回话时带上 */
export interface ToWorker {
  readonly seq: number;
  readonly rows: readonly string[];
}

/** 后台线程回的。一张图回一次结论；不合格的图另外回一条修改建议（哪个先算出来哪个先回，见 worker.ts）；最后回一句"这张图的事办完了" */
export type FromWorker =
  | { readonly seq: number; readonly verdict: Verdict }
  | { readonly seq: number; readonly repair: Repair }
  /** 太复杂，在限定的工作量内算不出最少步数 */
  | { readonly seq: number; readonly tooHard: true }
  /** 这张图没算成（比如求解库没加载成），failed 是原因。线程本身还能接着用 */
  | { readonly seq: number; readonly failed: string }
  | { readonly seq: number; readonly done: true };

/** 用到的那一点线程接口（浏览器的 Worker 就是这样的；测试里换成假的） */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * 结论最多等多久（毫秒）。绝大部分是算最少步数的时间；结论到了以后才找的修改建议不算在内，那边自己有时限。
 *
 * 算最少步数要多久，看图有多大、多开阔。2026-11-20 在 Node 24 里实测（Core Ultra 5 125H，四张图同时算；
 * 图是关卡生成器"修补"出来的开阔图，地面占六到八成，和内置的后 30 关是一类）：
 *   23×17：16 张都在时限内算出来了，中位数 27 秒，九成在 63 秒内，最慢 128 秒；
 *   25×20：16 张里 15 张算出来了，中位数 57 秒，九成在 91 秒内，最慢 99 秒；剩下 1 张到 180 秒还没算完。
 *          另外单独算过 8 张：7 张用了 22–70 秒，1 张用了 706 秒。
 * 也就是最大的图大约慢一倍，十来张里会有一张在时限内算不出来——那时页面会请人把图改简单些（多放几块墙就快了）。
 */
export const SOLVE_LIMIT_MS = 180_000;

interface Job {
  readonly id: string;
  readonly seq: number;
  state: CheckState;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class Checker {
  private readonly spawn: () => WorkerLike;
  private readonly onChange: (id: string, state: CheckState) => void;
  private worker: WorkerLike | null = null;
  /** 排着队的关（编号），先来的在前 */
  private waiting: string[] = [];
  /** 排着队的每一关最新的图 */
  private readonly maps = new Map<string, readonly string[]>();
  /** 正在算的那一关 */
  private job: Job | null = null;
  private seq = 0;

  /**
   * @param spawn 起一个后台线程
   * @param onChange 某一关的检查有了进展
   */
  constructor(spawn: () => WorkerLike, onChange: (id: string, state: CheckState) => void) {
    this.spawn = spawn;
    this.onChange = onChange;
  }

  /** 这一关的图变了：重新检查。正在算的要是它的旧图，结束那个线程另起一个；还在排队的话只算最新的这张 */
  request(id: string, rows: readonly string[]): void {
    // 正在算的就是这一关：它多半是用户正在改的那一关，新图接着算，不排到别的关后面去
    const underWay = this.job?.id === id;
    if (underWay) this.stop();
    this.maps.set(id, rows);
    if (underWay) this.waiting.unshift(id);
    else if (!this.waiting.includes(id)) this.waiting.push(id);
    this.onChange(id, { phase: 'queued' });
    this.next();
  }

  /** 用户正看着这一关：它在排队的话，挪到最前面 */
  prefer(id: string): void {
    const at = this.waiting.indexOf(id);
    if (at > 0) this.waiting.unshift(...this.waiting.splice(at, 1));
  }

  /** 这一关删掉了：不用再算，也不再报告它的状态 */
  forget(id: string): void {
    this.waiting = this.waiting.filter((other) => other !== id);
    this.maps.delete(id);
    if (this.job?.id === id) {
      this.stop();
      this.next();
    }
  }

  /** 空着的话，取排在最前面的那一关开始算 */
  private next(): void {
    if (this.job || this.waiting.length === 0) return;
    const id = this.waiting.shift()!;
    const rows = this.maps.get(id)!;
    this.maps.delete(id);
    const seq = ++this.seq;
    const job: Job = { id, seq, state: { phase: 'solving' }, timer: undefined };
    job.timer = setTimeout(() => this.giveUp(job), SOLVE_LIMIT_MS);
    this.job = job;
    this.onChange(id, job.state);
    this.worker ??= this.start();
    const message: ToWorker = { seq, rows };
    this.worker.postMessage(message);
  }

  private start(): WorkerLike {
    const worker = this.spawn();
    worker.onmessage = (event) => {
      // 已经被结束的线程，它还在路上的消息不理
      if (worker === this.worker) this.receive(event.data as FromWorker);
    };
    worker.onerror = () => {
      if (worker === this.worker) this.broken();
    };
    return worker;
  }

  private receive(message: FromWorker): void {
    const job = this.job;
    if (!job || message.seq !== job.seq) return;
    const { verdict, repair } = job.state;
    if ('verdict' in message) {
      clearTimeout(job.timer);
      // 建议要是已经先到了，这张图就都好了
      const waiting = wantsAdvice(message.verdict) && !repair;
      this.report(job, keeping({ phase: waiting ? 'repairing' : 'done', verdict: message.verdict }, repair));
    } else if ('repair' in message) {
      // 结论还没来的话接着等结论
      this.report(job, verdict ? { phase: 'done', verdict, repair: message.repair } : { phase: 'solving', repair: message.repair });
    } else if ('tooHard' in message) {
      clearTimeout(job.timer);
      this.report(job, keeping({ phase: 'timeout' }, repair));
    } else if ('failed' in message) {
      clearTimeout(job.timer);
      console.error(`[检查] ${message.failed}`);
      this.report(job, keeping({ phase: 'failed' }, repair));
    } else {
      // 这张图的事办完了，线程空出来了
      clearTimeout(job.timer);
      this.job = null;
      this.next();
    }
  }

  private report(job: Job, state: CheckState): void {
    job.state = state;
    this.onChange(job.id, state);
  }

  /** 算了太久：线程卡在求解里叫不停，直接结束它 */
  private giveUp(job: Job): void {
    if (this.job !== job) return;
    this.stop();
    this.onChange(job.id, keeping({ phase: 'timeout' }, job.state.repair));
    this.next();
  }

  /** 线程自己出了错（比如求解库没加载成） */
  private broken(): void {
    const job = this.job;
    this.stop();
    if (job) this.onChange(job.id, keeping({ phase: 'failed' }, job.state.repair));
    this.next();
  }

  /** 结束线程，丢开正在算的那一关。下次要算时另起一个线程 */
  private stop(): void {
    if (this.job) clearTimeout(this.job.timer);
    this.job = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

/** 已经到手的修改建议要一直带着：最少步数后来算不出来、线程后来坏了，建议照样作数 */
function keeping(state: CheckState, repair: Repair | undefined): CheckState {
  return repair ? { ...state, repair } : state;
}
