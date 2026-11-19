// 配置页的后台线程：收到一张图，先回检查的结论，需要的话再回一条修改建议，最后回一句"办完了"。
// 主线程那头是 checker.ts；一次只会收到一张图，算完了才有下一张。
// 求解库 HiGHS（3.5 MB 的 WebAssembly）只有这个线程会加载，而且等到真要算最少步数时才加载。
import loadHighs from 'highs';
import wasmUrl from 'highs/runtime?url';
import { suggestRepair } from '../solve/repair.ts';
import { TourLimitError, type Solver } from '../solve/tour.ts';
import { fullCheck, precheck, wantsAdvice } from './check.ts';
import type { FromWorker, ToWorker } from './checker.ts';

let highs: Promise<Solver> | null = null;

const reply = (message: FromWorker): void => postMessage(message);

async function check(seq: number, rows: readonly string[]): Promise<void> {
  try {
    // 便宜的那两步不用求解库：图一眼就不行的时候，不必为它去下载求解库
    const early = precheck(rows);
    const verdict = early ?? fullCheck(await (highs ??= loadHighs({ locateFile: () => wasmUrl })), rows);
    reply({ seq, verdict });
    if (wantsAdvice(verdict)) reply({ seq, repair: suggestRepair(rows) });
  } catch (err) {
    if (err instanceof TourLimitError) {
      reply({ seq, tooHard: true });
    } else {
      // 求解库没加载成的话，下一张图再试一次
      highs = null;
      reply({ seq, failed: err instanceof Error ? err.message : String(err) });
    }
  }
  reply({ seq, done: true });
}

onmessage = (event: MessageEvent<ToWorker>) => void check(event.data.seq, event.data.rows);
