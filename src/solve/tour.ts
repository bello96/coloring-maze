// 大图的"最少几步"：写成整数规划，交给 HiGHS 去解。两个地方共用这一份：生成和检查关卡的工具（Node，见 tools/mip.ts），
// 和配置页（浏览器的后台线程）；游戏页不引用它。
// HiGHS 在 Node 和浏览器里的加载办法不一样，所以这里不加载，由调用方加载好了传进来（见 Solver）。
//
// 为什么要第二种算法：求解器（src/game/solver.ts）靠搜索，15×15 的开阔图已经是它的极限，再大就搜不完了。
// 换个角度看这个问题——小球的走法是"停靠点图"上从起点出发的一条路，每条边（一步）染一些格子，
// 要的是把每个关键格都至少染到一次的最短的路。于是：
//
//   x_e  这一步一共走几次（非负整数）        y_v  最后是不是停在 v（恰好一个是 1）
//   最小化  所有 x_e 之和
//   每个停靠点：滚出去的次数 − 滚进来的次数 = [v 是起点] − y_v     （一笔画：除了头尾，进几次就出几次）
//   每个关键格：能染到它的那些步，加起来至少走一次
//   连通：走过的边得连成一片，才能真的一笔走完
//
// 满足这些的一组 x 一定能排成一条真的走法（欧拉路），所以整数规划的最优值就是最少步数。
// "连通"的条件多得列不完，用老办法：先不管它去解；解出来要是分成了几片，就针对没连上起点的每一片补一条
// 它违反了的条件（"要么有一步从外面滚进这一片，要么这片独占的关键格改由外面的某一步来染"），再解，直到连成一片。
// 补的每一条都是真正的走法一定满足的，所以没补全时解出来的数只会偏小不会偏大，
// 最后那个连成一片的解就是真正的最少步数。
//
// 这和求解器的搜索是完全不同的两条路，两边算出来的数在几百张图上逐一对过（tests/mip.test.ts）。
import type { Dir, Level } from '../game/level.ts';
import { isDone, newGame, roll, steps } from '../game/rules.ts';
import { stepGraph } from '../game/solver.ts';

/**
 * 加载好的 HiGHS。这里只用到它的 solve，所以只写这么一点，不从 highs 包里引类型——
 * 这个文件就和"HiGHS 是怎么加载的"无关了，Node 版、浏览器版的都能传进来。
 */
export interface Solver {
  solve(model: string, options?: Record<string, unknown>): { readonly Status: string; readonly Columns: unknown };
}

export interface Tour {
  /** 最少要走几步 */
  readonly par: number;
  /** 一种步数最少的走法 */
  readonly solution: string;
  /** 解了几轮才连成一片 */
  readonly rounds: number;
  /** 其中补了几条"这一片里的步只要走了，就得有一步从外面滚进来"（少见的那种连通条件，见下） */
  readonly forced: number;
}

/** 工作量超过上限时抛出：这一关太复杂，没法在限定的工作量内算出最少步数 */
export class TourLimitError extends Error {}

export interface TourOptions {
  /** 每一轮最多展开多少个分支节点。用节点数而不用时间来设限，同一张图在哪台电脑上结果都一样 */
  readonly maxNodes?: number;
  /** 最多解几轮 */
  readonly maxRounds?: number;
  /** HiGHS 的随机种子。换一个种子，搜索的过程不同，最优值必须相同——用来核对 */
  readonly seed?: number;
  /** 只找不超过这么多步的走法；没有就返回 null。已经知道一种走法、只想确认"再少一步就不行"时用，比从头找最优快 */
  readonly atMost?: number;
  /** 连通条件只用少见的那一种（见下面"这一片没有独占的关键格"处）。慢得多，只是为了让测试能把这条平时很少走到的路也核对一遍 */
  readonly forcedOnly?: boolean;
}

/**
 * 算出一关的最少步数和一种走法；通不了关返回 null。
 * @param highs 调用方加载好的 HiGHS
 */
export function shortestTour(highs: Solver, level: Level, options: TourOptions = {}): Tour | null {
  const { maxNodes = 200_000, maxRounds = 200, seed = 0 } = options;
  const graph = stepGraph(level);
  if (!graph) return null;
  const { stops, rolls, keys } = graph;
  if (keys.length === 0) return { par: 0, solution: '', rounds: 0, forced: 0 };

  const out: number[][] = Array.from({ length: stops }, () => []);
  const into: number[][] = Array.from({ length: stops }, () => []);
  rolls.forEach((r, i) => {
    out[r.from].push(i);
    into[r.to].push(i);
  });
  const keysOfRoll: number[][] = rolls.map(() => []);
  keys.forEach((list, k) => list.forEach((i) => keysOfRoll[i].push(k)));

  const sum = (ids: Iterable<number>): string => [...ids].map((i) => `x${i}`).join(' + ');
  const head: string[] = ['Minimize', ` steps: ${sum(rolls.keys())}`, 'Subject To'];
  for (let v = 0; v < stops; v++) {
    const terms = [...out[v].map((i) => `+ x${i}`), ...into[v].map((i) => `- x${i}`), `+ y${v}`];
    head.push(` flow${v}: ${terms.join(' ')} = ${v === 0 ? 1 : 0}`);
  }
  head.push(` end: ${Array.from({ length: stops }, (_, v) => `y${v}`).join(' + ')} = 1`);
  keys.forEach((list, k) => head.push(` dye${k}: ${sum(list)} >= 1`));
  if (options.atMost !== undefined) head.push(` atmost: ${sum(rolls.keys())} <= ${options.atMost}`);
  const tail: string[] = [
    'Generals',
    ` ${rolls.map((_, i) => `x${i}`).join(' ')}`,
    'Binaries',
    ` ${Array.from({ length: stops }, (_, v) => `y${v}`).join(' ')}`,
    'End',
  ];
  /** 补上的连通条件 */
  const cuts: string[] = [];
  // 一步最多会走几次：最少步数的走法里，相邻两次"染到新的关键格"之间走的是一条最短路（不会重复走同一步），
  // 这样的间隔最多和关键格一样多，所以任何一步都走不到关键格个数的两倍
  const most = keys.length * 2;
  let forced = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const model = [...head, ...cuts.map((cut, i) => ` join${i}: ${cut}`), ...tail].join('\n');
    // 目标值总是整数，上下界相差不到 1 就已经是最优
    const result = highs.solve(model, { output_flag: false, random_seed: seed, mip_max_nodes: maxNodes, mip_rel_gap: 0, mip_abs_gap: 0.5 });
    // 步数不可能是负的，所以"无解或无界"在这里也只能是无解
    if (result.Status === 'Infeasible' || result.Status === 'Primal infeasible or unbounded') return null;
    if (result.Status !== 'Optimal') throw new TourLimitError(`第 ${round} 轮没解完：${result.Status}`);
    const columns = result.Columns as Record<string, { Primal: number }>;
    const x = rolls.map((_, i) => Math.round(columns[`x${i}`].Primal));

    // 走过的边连成了几片？piece[v] 是停靠点 v 在第几片，起点所在的是第 0 片
    const piece = new Int32Array(stops).fill(-1);
    const spread = (from: number, id: number): void => {
      const stack = [from];
      piece[from] = id;
      while (stack.length > 0) {
        const v = stack.pop()!;
        for (const i of out[v]) {
          if (x[i] > 0 && piece[rolls[i].to] < 0) {
            piece[rolls[i].to] = id;
            stack.push(rolls[i].to);
          }
        }
        for (const i of into[v]) {
          if (x[i] > 0 && piece[rolls[i].from] < 0) {
            piece[rolls[i].from] = id;
            stack.push(rolls[i].from);
          }
        }
      }
    };
    spread(0, 0);
    let pieces = 1;
    for (let i = 0; i < rolls.length; i++) if (x[i] > 0 && piece[rolls[i].from] < 0) spread(rolls[i].from, pieces++);

    if (pieces === 1) {
      const solution = eulerTrail(stops, rolls, out, x);
      const par = x.reduce((a, b) => a + b, 0);
      // 照着走一遍，确认真的走得通、真的染完了
      const game = newGame(level);
      for (const ch of solution) if (!roll(game, ch as Dir)) throw new Error('整数规划给出的走法里有一步滚不动');
      if (!isDone(game) || steps(game) !== par) throw new Error('整数规划给出的走法没有把迷宫染完');
      return { par, solution, rounds: round, forced };
    }

    for (let c = 1; c < pieces; c++) {
      // 这一片独占的关键格：这一轮里只被这一片里出发的步染到
      const own = new Set<number>();
      for (let i = 0; i < rolls.length; i++) if (x[i] > 0 && piece[rolls[i].from] === c) for (const k of keysOfRoll[i]) own.add(k);
      for (let i = 0; i < rolls.length; i++) if (x[i] > 0 && piece[rolls[i].from] !== c) for (const k of keysOfRoll[i]) own.delete(k);
      const entering: number[] = [];
      for (let i = 0; i < rolls.length; i++) if (piece[rolls[i].from] !== c && piece[rolls[i].to] === c) entering.push(i);
      let added = 0;
      for (const k of options.forcedOnly ? [] : own) {
        // 要染到 k：要么有一步从外面滚进这一片，要么由一步从这一片外面出发、不进这一片的步来染
        const elsewhere = keys[k].filter((i) => piece[rolls[i].from] !== c && piece[rolls[i].to] !== c);
        cuts.push(`${sum([...entering, ...elsewhere])} >= 1`);
        if (++added === 3) break;
      }
      if (added > 0) continue;
      // 这一片没有独占的关键格：它是为了凑先前补的某个条件才冒出来的。那就直说——
      // 这一片里的步只要走了，就得有一步从外面滚进来（一步最多走 most 次，所以"滚进来的次数 × most ≥ 这一步走的次数"）
      const inside: number[] = [];
      for (let i = 0; i < rolls.length; i++) if (x[i] > 0 && piece[rolls[i].from] === c) inside.push(i);
      forced += Math.min(6, inside.length);
      for (const f of inside.slice(0, 6)) cuts.push(`${entering.map((i) => `${most} x${i}`).join(' + ')} - x${f} >= 0`);
    }
  }
  throw new TourLimitError(`解了 ${maxRounds} 轮还没连成一片`);
}

/** 把每条边走 x 次的"一笔画"排出来：从起点出发，每条边正好用完 */
function eulerTrail(stops: number, rolls: ReadonlyArray<{ readonly to: number; readonly dir: Dir }>, out: readonly number[][], x: readonly number[]): string {
  const left = x.slice();
  const next = new Int32Array(stops);
  const trail: number[] = [];
  const walk: Array<{ at: number; via: number }> = [{ at: 0, via: -1 }];
  while (walk.length > 0) {
    const top = walk[walk.length - 1];
    let moved = false;
    while (next[top.at] < out[top.at].length) {
      const i = out[top.at][next[top.at]];
      if (left[i] > 0) {
        left[i]--;
        walk.push({ at: rolls[i].to, via: i });
        moved = true;
        break;
      }
      next[top.at]++;
    }
    if (!moved) {
      walk.pop();
      if (top.via >= 0) trail.push(top.via);
    }
  }
  return trail
    .reverse()
    .map((i) => rolls[i].dir)
    .join('');
}
