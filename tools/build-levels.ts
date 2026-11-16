// 生成 30 关并写进 src/game/levels.ts。
//
//   node tools/build-levels.ts            先给每个尺寸造一大批候选，再按难度曲线挑 30 关
//   node tools/build-levels.ts pool 9     只造 9×9 的候选（几个尺寸可以同时各开一个窗口跑）
//   node tools/build-levels.ts pick       只重新挑选（用已经造好的候选）
//
// 候选存在 node_modules/.cache/coloring-maze/ 里，种子固定，所以重跑得到的是同一批。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLevel } from '../src/game/level.ts';
import { analyze, SolverLimitError } from '../src/game/solver.ts';
import { seeded } from '../tests/helpers/random.ts';
import { blocks, carve, greedySteps, shapeOk, type Rand } from './gen.ts';

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
const TRIES: Record<number, number> = { 5: 30_000, 6: 40_000, 7: 50_000, 8: 50_000, 9: 60_000, 10: 60_000 };
/** 求解一个候选最多搜多少局面，超过就放弃这个候选 */
const SEARCH_LIMIT = 6_000_000;

const hashRows = (rows: string[]): number => {
  let h = 2166136261;
  for (const ch of rows.join('/')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

function makeOne(rand: Rand, n: number): { rows: string[]; style: Style } | null {
  const kind = rand();
  if (kind < 0.4) {
    const moves = 3 + Math.floor(rand() * (n * 3 - 2));
    const made = carve(rand, n, moves, Math.floor(rand() * 4));
    return made ? { rows: made.rows, style: 'carve' } : null;
  }
  const symmetric = kind >= 0.6;
  const pieces = Math.round(n * (0.35 + rand() * (symmetric ? 0.55 : 1.0)));
  const rows = blocks(rand, n, pieces, symmetric);
  return rows ? { rows, style: symmetric ? 'sym' : 'blocks' } : null;
}

function buildPool(n: number): Candidate[] {
  const rand = seeded(n * 7919 + 20261116);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const tries = TRIES[n];
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
    try {
      const a = analyze(level, SEARCH_LIMIT);
      if (!a.solvable || !a.safe || a.par < 3) continue;
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
    if (i % 5000 === 4999) {
      console.log(`  ${n}×${n}: ${i + 1}/${tries} 次，候选 ${out.length} 个，${((performance.now() - t0) / 1000).toFixed(0)} 秒`);
    }
  }
  console.log(`${n}×${n}: 候选 ${out.length} 个（另有 ${limited} 个太复杂放弃），用时 ${((performance.now() - t0) / 1000).toFixed(0)} 秒`);
  return out;
}

const poolFile = (n: number): string => path.join(CACHE, `pool-${n}-${TRIES[n]}-${SEARCH_LIMIT}.json`);

function loadPool(n: number, build: boolean): Candidate[] {
  const file = poolFile(n);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Candidate[];
  if (!build) throw new Error(`还没有 ${n}×${n} 的候选，先运行 node tools/build-levels.ts pool ${n}`);
  const pool = buildPool(n);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(pool));
  return pool;
}

/**
 * 难度曲线：每关的尺寸、最少步数（允许的范围）、希望的 gap，以及最少要有多开阔。
 * 最少步数从头到尾不减，尺寸也不减。
 */
interface Slot {
  n: number;
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
];

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

function pick(pools: Map<number, Candidate[]>): Candidate[] {
  const chosen: Candidate[] = [];
  PLAN.forEach((slot, i) => {
    const minOpen = slot.minOpen ?? 0.55;
    const prev = chosen[chosen.length - 1];
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of pools.get(slot.n)!) {
      if (c.par < slot.par[0] || c.par > slot.par[1]) continue;
      if (c.open < minOpen) continue;
      if (chosen.some((d) => d.rows.length === slot.n && difference(d.rows, c.rows) < 0.2)) continue;
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
    if (!best) throw new Error(`第 ${i + 1} 关（${slot.n}×${slot.n}，最少 ${slot.par.join('–')} 步）没有合适的候选`);
    chosen.push(best);
  });
  return chosen;
}

function write(levels: Candidate[]): void {
  const lines: string[] = [
    '// 这个文件由 tools/build-levels.ts 生成（npm run levels），不要手改。',
    '// 每一关都由求解器确认过：能通关、不会困死，par 是真正的最少步数，solution 是其中一种走法。',
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

const [command, arg] = process.argv.slice(2);
const SIZES = [5, 6, 7, 8, 9, 10];
if (command === 'pool') {
  for (const n of arg ? [Number(arg)] : SIZES) loadPool(n, true);
} else {
  const pools = new Map<number, Candidate[]>();
  for (const n of SIZES) pools.set(n, loadPool(n, command !== 'pick'));
  for (const n of SIZES) {
    const pool = pools.get(n)!;
    const pars = new Map<number, number>();
    for (const c of pool) pars.set(c.par, (pars.get(c.par) ?? 0) + 1);
    const list = [...pars].sort((a, b) => a[0] - b[0]).map(([par, count]) => `${par}:${count}`);
    console.log(`${n}×${n} 候选 ${pool.length} 个，按最少步数分布 ${list.join(' ')}`);
  }
  const levels = pick(pools);
  write(levels);
  levels.forEach((c, i) => {
    const level = parseLevel(c.rows);
    console.log(
      `第 ${String(i + 1).padStart(2)} 关 ${level.rows}×${level.cols} ${c.style.padEnd(6)} 最少 ${String(c.par).padStart(2)} 步  gap ${c.gap.toFixed(1).padStart(5)}  地面 ${Math.round(c.open * 100)}%  停靠点 ${c.stops}`,
    );
  });
}
