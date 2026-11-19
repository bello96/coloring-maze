// 大图的"最少几步"在 Node 里的入口：加载 Node 版的 HiGHS，转给 src/solve/tour.ts 去算（算法和它的说明都在那边）。
// 只在生成和检查关卡时用（npm run levels、测试），不会打进游戏里。
import loadHighs from 'highs';
import type { Level } from '../src/game/level.ts';
import { shortestTour as tourWith, type Tour, type TourOptions } from '../src/solve/tour.ts';

export { TourLimitError, type Tour, type TourOptions } from '../src/solve/tour.ts';

const highs = await loadHighs();

/** 算出一关的最少步数和一种走法；通不了关返回 null。 */
export function shortestTour(level: Level, options: TourOptions = {}): Tour | null {
  return tourWith(highs, level, options);
}
