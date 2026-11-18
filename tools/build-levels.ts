// 生成 80 关并写进 src/game/levels.ts。
//
//   node tools/build-levels.ts             先给每个尺寸造一大批候选，再按难度曲线挑 80 关
//   node tools/build-levels.ts pool 9      只造 9×9 的候选（几个尺寸可以同时各开一个窗口跑）
//   node tools/build-levels.ts pool 21x15  只造 21 行 × 15 列的候选
//   node tools/build-levels.ts pick        只重新挑选（用已经造好的候选）
//
// 候选存在 node_modules/.cache/coloring-maze/ 里，种子固定，所以重跑得到的是同一批。
// 15×15 和长方形的候选求解起来慢得多，会自动分给多个线程一起算（怎么分是固定的，和电脑有几个核无关）。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseLevel, transposeDef } from '../src/game/level.ts';
import { analyze, stepGraph, SolverLimitError, type Engine } from '../src/game/solver.ts';
import { seeded } from '../tests/helpers/random.ts';
import { blocks, carve, greedySteps, mend, shapeOk, type Rand } from './gen.ts';
import { shortestTour, TourLimitError } from './mip.ts';

type Style = 'carve' | 'blocks' | 'sym';

interface Candidate {
  rows: string[];
  style: Style;
  par: number;
  solution: string;
  /** "走一步看一步"的玩法平均比最少步数多走几步：越大越需要事先规划 */
  gap: number;
  /** 地面占整个棋盘的比例 */
  open: number;
  stops: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'coloring-maze');

/** 每个尺寸试多少次。大尺寸的好候选很稀少，要多试。 */
const TRIES: Record<number, number> = { 5: 30_000, 6: 40_000, 7: 50_000, 8: 50_000, 9: 60_000, 10: 60_000, 15: 48_000 };
/** 求解一个候选最多搜多少局面，超过就放弃这个候选。大图用的搜法每个局面占的内存多，又是十几个线程一起算，所以少给一些。 */
const SEARCH_LIMIT = 6_000_000;
const SEARCH_LIMIT_BIG = 2_000_000;
/** 15×15 和长方形的候选分成固定的这么多份，各用各的种子，可以同时算 */
const SHARDS = 16;
/** 从这个尺寸起算"大图"：换一套造法和搜法（见 makeBig 和求解器的 Engine） */
const BIG = 15;
/**
 * 51 关以后用的长方形大图：几行 × 几列（存的时候竖着放，游戏里会按屏幕的横竖转过来）。
 * 这么大的开阔图求解器搜不动，最少步数改用整数规划来算（见 mip.ts）。
 */
const RECTS: ReadonlyArray<readonly [rows: number, cols: number]> = [
  [19, 15],
  [21, 15],
  [23, 17],
];
/** 每种长方形要多少个候选（平分给 SHARDS 份） */
const RECT_WANTED = 240;
/** 整数规划每一轮最多展开多少个分支节点、最多解几轮，超过就放弃这个候选 */
const TOUR_NODES = 3000;
const TOUR_ROUNDS = 60;

const hashRows = (rows: string[]): number => {
  let h = 2166136261;
  for (const ch of rows.join('/')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

function makeOne(rand: Rand, n: number): { rows: string[]; style: Style } | null {
  if (n >= BIG) return makeBig(rand, n);
  const kind = rand();
  if (kind < 0.4) {
    const moves = 3 + Math.floor(rand() * (n * 3 - 2));
    const made = carve(rand, n, n, moves, Math.floor(rand() * 4));
    return made ? { rows: made.rows, style: 'carve' } : null;
  }
  const symmetric = kind >= 0.6;
  const pieces = Math.round(n * (0.35 + rand() * (symmetric ? 0.55 : 1.0)));
  const rows = blocks(rand, n, n, pieces, symmetric);
  return rows ? { rows, style: symmetric ? 'sym' : 'blocks' } : null;
}

/** 大图：开凿要凿得久得多才铺得开；摆木块改用"修补"，随机摆的通不了关 */
function makeBig(rand: Rand, n: number): { rows: string[]; style: Style } | null {
  const kind = rand();
  if (kind < 0.4) {
    const moves = n * 3 + Math.floor(rand() * n * 8);
    const made = carve(rand, n, n, moves, Math.floor(rand() * 4));
    return made ? { rows: made.rows, style: 'carve' } : null;
  }
  const symmetric = kind >= 0.6;
  const pieces = Math.round(n * (0.7 + rand() * 2));
  const rows = mend(rand, n, n, pieces, symmetric);
  return rows ? { rows, style: symmetric ? 'sym' : 'blocks' } : null;
}

/**
 * 试 tries 次，把合格的候选收集起来。
 * @param engine 小图一直是用"一层层全搜"筛的，换了搜法筛出来的就不是原来那一批了，所以照旧
 */
function collect(n: number, seed: number, tries: number, engine: Engine, label: string): { list: Candidate[]; limited: number } {
  const rand = seeded(seed);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const big = n >= BIG;
  const t0 = performance.now();
  let limited = 0;
  for (let i = 0; i < tries; i++) {
    const made = makeOne(rand, n);
    if (!made) continue;
    const id = made.rows.join('/');
    if (seen.has(id)) continue;
    seen.add(id);
    const level = shapeOk(made.rows);
    if (!level) continue;
    const open = level.floorCount / (n * n);
    if (open > 0.9) continue;
    // 大图只留用得上的：太挤的、步数还不如 10×10 的都不要（省下估 gap 的时间）
    if (big && open < 0.55) continue;
    try {
      const a = analyze(level, big ? SEARCH_LIMIT_BIG : SEARCH_LIMIT, engine);
      if (!a.solvable || !a.safe || a.par < (big ? 30 : 3)) continue;
      const judge = seeded(hashRows(made.rows));
      let total = 0;
      const runs = 30;
      for (let k = 0; k < runs; k++) total += greedySteps(level, judge);
      out.push({
        rows: made.rows,
        style: made.style,
        par: a.par,
        solution: a.solution,
        gap: Math.round((total / runs - a.par) * 100) / 100,
        open: Math.round(open * 1000) / 1000,
        stops: a.stops,
      });
    } catch (err) {
      if (!(err instanceof SolverLimitError)) throw err;
      limited++;
    }
    if (!big && i % 5000 === 4999) {
      console.log(`  ${label}: ${i + 1}/${tries} 次，候选 ${out.length} 个，${((performance.now() - t0) / 1000).toFixed(0)} 秒`);
    }
  }
  return { list: out, limited };
}

/**
 * 长方形大图的候选：一直造到凑够 wanted 个为止。全部用"修补"的办法造（所以一定能通关、不会困死），
 * 最少步数用整数规划算。
 */
function collectRect(rows: number, cols: number, seed: number, wanted: number): { list: Candidate[]; limited: number } {
  const rand = seeded(seed);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  // 木块摆多少按面积算：和同样面积的正方形一样多
  const n = Math.round(Math.sqrt(rows * cols));
  let limited = 0;
  for (let i = 0; i < wanted * 400 && out.length < wanted; i++) {
    const symmetric = rand() < 0.6;
    const made = mend(rand, rows, cols, Math.round(n * (0.7 + rand() * 2)), symmetric);
    if (!made) continue;
    const id = made.join('/');
    if (seen.has(id)) continue;
    seen.add(id);
    const level = shapeOk(made);
    if (!level) continue;
    try {
      const tour = shortestTour(level, { maxNodes: TOUR_NODES, maxRounds: TOUR_ROUNDS });
      if (!tour) continue;
      const judge = seeded(hashRows(made));
      let total = 0;
      const runs = 30;
      // 这么大的图，走一步看一步可能要走好几百步
      for (let k = 0; k < runs; k++) total += greedySteps(level, judge, 2000);
      out.push({
        rows: made,
        style: symmetric ? 'sym' : 'blocks',
        par: tour.par,
        solution: tour.solution,
        gap: Math.round((total / runs - tour.par) * 100) / 100,
        open: Math.round((level.floorCount / (rows * cols)) * 1000) / 1000,
        stops: stepGraph(level)!.stops,
      });
    } catch (err) {
      if (!(err instanceof TourLimitError)) throw err;
      limited++;
    }
  }
  return { list: out, limited };
}

function buildPool(n: number): Candidate[] {
  const t0 = performance.now();
  const { list, limited } = collect(n, n * 7919 + 20261116, TRIES[n], 'breadth', `${n}×${n}`);
  console.log(`${n}×${n}: 候选 ${list.length} 个（另有 ${limited} 个太复杂放弃），用时 ${((performance.now() - t0) / 1000).toFixed(0)} 秒`);
  return list;
}

/** 大图的候选：分成 SHARDS 份，几个线程分着算，最后按份的顺序拼起来（所以结果和线程数无关） */
async function buildBigPool(n: number, cols: number): Promise<Candidate[]> {
  const t0 = performance.now();
  const name = `${n}×${cols}`;
  const parts: Array<{ list: Candidate[]; limited: number }> = new Array(SHARDS);
  let next = 0;
  let finished = 0;
  const workers = Math.max(1, Math.min(SHARDS, availableParallelism() - 2));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < SHARDS) {
        const shard = next++;
        parts[shard] = await new Promise((resolve, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { n, cols, shard } });
          worker.once('message', resolve);
          worker.once('error', reject);
        });
        finished++;
        console.log(`  ${name}: 第 ${finished}/${SHARDS} 份算完，${((performance.now() - t0) / 1000).toFixed(0)} 秒`);
      }
    }),
  );
  const seen = new Set<string>();
  const list: Candidate[] = [];
  let limited = 0;
  for (const part of parts) {
    limited += part.limited;
    for (const c of part.list) {
      const id = c.rows.join('/');
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(c);
    }
  }
  console.log(`${name}: 候选 ${list.length} 个（另有 ${limited} 个太复杂放弃），用时 ${((performance.now() - t0) / 1000).toFixed(0)} 秒`);
  return list;
}

const poolFile = (n: number, cols: number): string =>
  n === cols
    ? path.join(CACHE, `pool-${n}-${TRIES[n]}-${n >= BIG ? SEARCH_LIMIT_BIG : SEARCH_LIMIT}.json`)
    : path.join(CACHE, `pool-${n}x${cols}-${RECT_WANTED}-${TOUR_NODES}-${TOUR_ROUNDS}.json`);

async function loadPool(n: number, cols: number, build: boolean): Promise<Candidate[]> {
  const file = poolFile(n, cols);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Candidate[];
  if (!build) throw new Error(`还没有 ${n}×${cols} 的候选，先运行 node tools/build-levels.ts pool ${n === cols ? n : `${n}x${cols}`}`);
  const pool = n >= BIG || n !== cols ? await buildBigPool(n, cols) : buildPool(n);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(pool));
  return pool;
}

/**
 * 难度曲线：每关的尺寸、最少步数（允许的范围）、希望的 gap，以及最少要有多开阔。
 * 最少步数从头到尾不减，尺寸也不减。
 */
interface Slot {
  /** 几行 */
  n: number;
  /** 几列；不写就是正方形 */
  cols?: number;
  par: [number, number];
  gap: number;
  minOpen?: number;
}
const PLAN: Slot[] = [
  { n: 5, par: [3, 3], gap: 0, minOpen: 0.4 },
  { n: 5, par: [4, 5], gap: 0, minOpen: 0.5 },
  { n: 5, par: [6, 6], gap: 0.5 },
  { n: 6, par: [7, 7], gap: 0.5 },
  { n: 6, par: [8, 8], gap: 1 },
  { n: 6, par: [9, 9], gap: 1.5 },
  { n: 6, par: [10, 10], gap: 2 },
  { n: 6, par: [11, 11], gap: 3 },
  { n: 7, par: [12, 12], gap: 2 },
  { n: 7, par: [13, 13], gap: 2.5 },
  { n: 7, par: [14, 14], gap: 3 },
  { n: 7, par: [15, 15], gap: 4 },
  { n: 7, par: [16, 16], gap: 5 },
  { n: 7, par: [17, 17], gap: 6 },
  { n: 8, par: [18, 18], gap: 4 },
  { n: 8, par: [19, 19], gap: 5 },
  { n: 8, par: [20, 20], gap: 6 },
  { n: 8, par: [21, 21], gap: 7 },
  { n: 8, par: [22, 22], gap: 8 },
  { n: 8, par: [23, 23], gap: 9 },
  { n: 9, par: [24, 24], gap: 7 },
  { n: 9, par: [25, 25], gap: 8 },
  { n: 9, par: [26, 26], gap: 9 },
  { n: 9, par: [27, 27], gap: 10 },
  { n: 9, par: [28, 28], gap: 12 },
  { n: 10, par: [29, 29], gap: 9 },
  { n: 10, par: [30, 30], gap: 10 },
  { n: 10, par: [31, 31], gap: 12 },
  { n: 10, par: [32, 33], gap: 14 },
  { n: 10, par: [34, 40], gap: 16 },
  // 31–50 关：换成 15×15。最少步数和 gap 都从第 30 关往上接，所以每一关都比第 30 关难。
  // 前一半是凿出来的大迷宫（开阔的图在 15×15 上起码要五十多步），后一半是要想得很远的开阔图。
  { n: 15, par: [36, 36], gap: 17 },
  { n: 15, par: [37, 37], gap: 18 },
  { n: 15, par: [38, 38], gap: 18 },
  { n: 15, par: [39, 40], gap: 19 },
  { n: 15, par: [41, 42], gap: 19 },
  { n: 15, par: [43, 44], gap: 20 },
  { n: 15, par: [45, 46], gap: 20 },
  { n: 15, par: [47, 48], gap: 21 },
  { n: 15, par: [49, 51], gap: 22 },
  { n: 15, par: [52, 54], gap: 23 },
  { n: 15, par: [55, 56], gap: 25 },
  { n: 15, par: [57, 58], gap: 26 },
  { n: 15, par: [59, 60], gap: 28 },
  { n: 15, par: [61, 62], gap: 30 },
  { n: 15, par: [63, 64], gap: 32 },
  { n: 15, par: [65, 66], gap: 34 },
  { n: 15, par: [67, 68], gap: 36 },
  { n: 15, par: [69, 70], gap: 38 },
  { n: 15, par: [71, 73], gap: 40 },
  { n: 15, par: [74, 80], gap: 44 },
  // 51–80 关：长方形的大图，一段比一段大。最少步数和 gap 接着第 50 关往上走，最后一关要一百五十步上下。
  { n: 19, cols: 15, par: [77, 78], gap: 46 },
  { n: 19, cols: 15, par: [79, 80], gap: 47 },
  { n: 19, cols: 15, par: [81, 82], gap: 48 },
  { n: 19, cols: 15, par: [83, 84], gap: 49 },
  { n: 19, cols: 15, par: [85, 86], gap: 50 },
  { n: 19, cols: 15, par: [87, 88], gap: 52 },
  { n: 19, cols: 15, par: [89, 90], gap: 54 },
  { n: 19, cols: 15, par: [91, 92], gap: 56 },
  { n: 19, cols: 15, par: [93, 94], gap: 58 },
  { n: 19, cols: 15, par: [95, 97], gap: 60 },
  { n: 21, cols: 15, par: [98, 99], gap: 62 },
  { n: 21, cols: 15, par: [100, 101], gap: 64 },
  { n: 21, cols: 15, par: [102, 103], gap: 66 },
  { n: 21, cols: 15, par: [104, 105], gap: 68 },
  { n: 21, cols: 15, par: [106, 107], gap: 70 },
  { n: 21, cols: 15, par: [108, 109], gap: 72 },
  { n: 21, cols: 15, par: [110, 112], gap: 74 },
  { n: 21, cols: 15, par: [113, 115], gap: 76 },
  { n: 21, cols: 15, par: [116, 118], gap: 78 },
  { n: 21, cols: 15, par: [119, 122], gap: 80 },
  { n: 23, cols: 17, par: [123, 125], gap: 84 },
  { n: 23, cols: 17, par: [126, 128], gap: 88 },
  { n: 23, cols: 17, par: [129, 131], gap: 92 },
  { n: 23, cols: 17, par: [132, 134], gap: 96 },
  { n: 23, cols: 17, par: [135, 137], gap: 100 },
  { n: 23, cols: 17, par: [138, 140], gap: 104 },
  { n: 23, cols: 17, par: [141, 143], gap: 108 },
  { n: 23, cols: 17, par: [144, 147], gap: 112 },
  { n: 23, cols: 17, par: [148, 151], gap: 116 },
  { n: 23, cols: 17, par: [152, 170], gap: 120 },
];

const sizeKey = (rows: number, cols: number): string => `${rows}x${cols}`;

/** 两个同尺寸的迷宫有多少格不一样（占比） */
function difference(a: string[], b: string[]): number {
  let diff = 0;
  let total = 0;
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) {
      total++;
      if ((a[r][c] === '#') !== (b[r][c] === '#')) diff++;
    }
  }
  return diff / total;
}

function pick(pools: Map<string, Candidate[]>): Candidate[] {
  const chosen: Candidate[] = [];
  PLAN.forEach((slot, i) => {
    const minOpen = slot.minOpen ?? 0.55;
    const cols = slot.cols ?? slot.n;
    const prev = chosen[chosen.length - 1];
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of pools.get(sizeKey(slot.n, cols))!) {
      if (c.par < slot.par[0] || c.par > slot.par[1]) continue;
      if (c.open < minOpen) continue;
      if (chosen.some((d) => d.rows.length === slot.n && d.rows[0].length === cols && difference(d.rows, c.rows) < 0.2)) continue;
      let score = -Math.abs(c.gap - slot.gap) * 2;
      score -= Math.abs(c.open - 0.7) * 8;
      score -= (c.par - slot.par[0]) * 0.5;
      // 相邻两关换一种样子
      if (prev && prev.style === c.style) score -= 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) throw new Error(`第 ${i + 1} 关（${slot.n}×${cols}，最少 ${slot.par.join('–')} 步）没有合适的候选`);
    chosen.push(best);
  });
  return chosen;
}

/**
 * 15×15 的最少步数是求解器搜出来的。核对的办法是把关键格换两种分法各再算一遍：
 * 分法不同，搜索时用的下界就完全不同，算出来的最少步数却必须一样。对不上就不往下写。
 */
function confirm(levels: Candidate[]): void {
  const t0 = performance.now();
  levels.forEach((c, i) => {
    if (c.rows.length < BIG || c.rows.length !== c.rows[0].length) return;
    for (const groupSize of [14, 12]) {
      const a = analyze(parseLevel(c.rows), 40_000_000, 'guided', groupSize);
      if (a.par !== c.par) throw new Error(`第 ${i + 1} 关：关键格 ${groupSize} 个一组算出来最少 ${a.par} 步，和原来的 ${c.par} 步对不上`);
    }
  });
  console.log(`15×15 的每一关都换了两种分组重算过，最少步数一致（${((performance.now() - t0) / 1000).toFixed(0)} 秒）`);
}

/**
 * 长方形的大图只有整数规划算得动。核对的办法：把图沿对角线翻过来（行列对调，玩法不变，但交给整数规划的
 * 是另一道题）、再换一个随机种子，问"比标的最少步数再少一步行不行"——必须是不行。
 */
function confirmRects(levels: Candidate[]): void {
  const t0 = performance.now();
  levels.forEach((c, i) => {
    if (c.rows.length === c.rows[0].length) return;
    const flipped = transposeDef(c);
    if (shortestTour(parseLevel(flipped.rows), { seed: 20261118, atMost: c.par - 1 })) {
      throw new Error(`第 ${i + 1} 关：翻过来重算，找到了比 ${c.par} 步更少的走法`);
    }
  });
  console.log(`长方形的每一关都翻过来重算过，没有更少的走法（${((performance.now() - t0) / 1000).toFixed(0)} 秒）`);
}

function write(levels: Candidate[]): void {
  const lines: string[] = [
    '// 这个文件由 tools/build-levels.ts 生成（npm run levels），不要手改。',
    '// 每一关都确认过：能通关、不会困死，par 是真正的最少步数，solution 是其中一种走法。',
    "import type { LevelDef } from './level.ts';",
    '',
    'export const LEVELS: readonly LevelDef[] = [',
  ];
  levels.forEach((c, i) => {
    lines.push(`  // 第 ${i + 1} 关`);
    lines.push('  {');
    lines.push('    rows: [');
    for (const row of c.rows) lines.push(`      '${row}',`);
    lines.push('    ],');
    lines.push(`    par: ${c.par},`);
    lines.push(`    solution: '${c.solution}',`);
    lines.push('  },');
  });
  lines.push('];', '');
  writeFileSync(path.join(ROOT, 'src', 'game', 'levels.ts'), lines.join('\n'));
}

const SIZES: ReadonlyArray<readonly [rows: number, cols: number]> = [...[5, 6, 7, 8, 9, 10, 15].map((n) => [n, n] as const), ...RECTS];

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'pool') {
    const [rows, cols = rows] = (arg ?? '').split('x').map(Number);
    for (const [n, c] of arg ? [[rows, cols] as const] : SIZES) await loadPool(n, c, true);
    return;
  }
  const pools = new Map<string, Candidate[]>();
  for (const [n, c] of SIZES) pools.set(sizeKey(n, c), await loadPool(n, c, command !== 'pick'));
  for (const [n, c] of SIZES) {
    const pool = pools.get(sizeKey(n, c))!;
    const pars = new Map<number, number>();
    for (const item of pool) pars.set(item.par, (pars.get(item.par) ?? 0) + 1);
    const list = [...pars].sort((a, b) => a[0] - b[0]).map(([par, count]) => `${par}:${count}`);
    console.log(`${n}×${c} 候选 ${pool.length} 个，按最少步数分布 ${list.join(' ')}`);
  }
  const levels = pick(pools);
  confirm(levels);
  confirmRects(levels);
  write(levels);
  levels.forEach((c, i) => {
    const level = parseLevel(c.rows);
    console.log(
      `第 ${String(i + 1).padStart(2)} 关 ${level.rows}×${level.cols} ${c.style.padEnd(6)} 最少 ${String(c.par).padStart(3)} 步  gap ${c.gap.toFixed(1).padStart(5)}  地面 ${Math.round(c.open * 100)}%  停靠点 ${c.stops}`,
    );
  });
}

if (isMainThread) {
  await main();
} else {
  // 线程里：算自己那一份候选，交回去
  const { n, cols, shard } = workerData as { n: number; cols: number; shard: number };
  const seed = n * 7919 + 20261116 + (shard + 1) * 1_000_003;
  parentPort!.postMessage(
    n === cols ? collect(n, seed, TRIES[n] / SHARDS, 'guided', `${n}×${n}`) : collectRect(n, cols, seed + cols * 104_729, RECT_WANTED / SHARDS),
  );
}
