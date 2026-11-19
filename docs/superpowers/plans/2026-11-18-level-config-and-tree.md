# 关卡配置页 + 选关树 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关卡改成在 `/config` 网页上配置、发布到 Cloudflare KV 后所有玩家生效；选关从弹出面板换成刻在长木板上的一棵树（首页）。

**Architecture:** 关卡表（`LevelSet`）是唯一的数据格式，校验函数 `checkLevelSet` 由游戏、配置页、Worker 三处共用。游戏启动时拉 `/api/levels`，三级回退到内置 80 关；存档改成按关卡编号记（v2）。配置页是 Vite 的第二个入口，最少步数用 HiGHS 在 Web Worker 里算；修改建议是在 `shortfall` 上做的定宽搜索。树是普通 DOM + SVG，用浏览器自带滚动。

**Tech Stack:** TypeScript 7、Vite 8（rolldown）、vitest 5、three.js（只有游戏页）、highs 1.15（只有配置页的 Worker 线程）、Cloudflare Workers 静态资源 + KV、wrangler 4.156。

**Spec:** `docs/superpowers/specs/2026-11-18-level-config-and-tree-design.md`（先读它；本计划只写它没定的名字、签名和测试）

## Global Constraints

- **不提交 git**：用户说「提交并推送」才提交。每个任务以"跑通本任务的测试 + `npx tsc --noEmit`"收尾，不 commit。
- **第 1–50 关一格不能变**（`tests/levels.test.ts` 的指纹 `34d9a00c`）；`src/game/levels.ts` 不动；内置 80 关的测试不改。
- `src/view/stain.ts` 的行为不动；托盘倾斜 `TILT = 0.011` 不许调大。
- 只做设计文档里的范围。不加设计里没有的界面元素、提示文案、确认框（唯一的确认是配置页的 `beforeunload`）。
- 界面文字全部中文；代码注释中文，照现有文件的口吻。
- 地图大小：行、列各 5–23；长边 ≤ 23，短边 ≤ 17。关卡数 1–200。`id` 是 `^[a-z0-9]{2,12}$`。`dye` 是 `#rrggbb`。
- 管理口令绝不经过助手：本地开发固定用 `dev-token`；线上的 `LEVEL_ADMIN_TOKEN` 由用户自己 `wrangler secret put`。
- npm 安装走 `env -u HTTPS_PROXY -u HTTP_PROXY npm … --registry=https://registry.npmmirror.com --prefer-offline`。
- 测试命令：单个文件 `npx vitest run tests/<name>.test.ts`；全量 `npm test`（几分钟，会占满 CPU）；类型 `npx tsc --noEmit`。
- 导入一律带 `.ts` 后缀（`allowImportingTsExtensions`），只用可擦除的 TS 语法（`erasableSyntaxOnly`：不用 enum、参数属性）。
- 上线（建 KV、`npm run deploy`）在任务 10，**做之前停下来给用户看图并等口令**。

## Review Focus

设计没明说、但真用起来最容易出事的五种情况。每条的测试加在括号里的任务中：

1. **存不了、读不了 `localStorage`**（无痕模式、被禁用）：游戏照常启动、能玩，关卡加载不抛错。（任务 3、5）
2. **发布请求的内容类型不对**（`levels` 是字符串、`rows` 里有数字、`par` 是小数、嵌了 `null`）：接口回 400，不是 500。（任务 1、4）
3. **线上关卡表和玩家存档对不上**（关比存档少、只剩一关、编号全是新的、排第一的是长方形大图）：树照常画出来，能进关，提示牌不压住托盘。（任务 3、8）
4. **配置页把图改成"没有地面"或"起点被裁掉"**（缩小尺寸、把起点周围全涂成墙）：图里始终恰好一个起点，不出异常。（任务 7）
5. **只有一格地面的图**（起点就是全部）：最少步数是 0，游戏里永远触发不了通关——校验必须拦下（`par ≥ 1`）；修改建议也不能把图改成这样。（任务 1、6）

---

## 文件结构

| 文件 | 负责什么 |
| --- | --- |
| `src/game/levelset.ts`（新） | `LevelEntry`/`LevelSet`、`checkLevelSet`、内置关卡表 `BUILTIN`、染料色板 `DYES`、图的指纹 `sigOf` |
| `src/view/dyes.ts`（删） | 色板搬进 `levelset.ts`；颜色从关卡里取 |
| `src/game/progress.ts`（重写） | 存档 v2、v1 迁移、合并、"哪些关能玩" |
| `src/game/remote.ts`（新） | 启动时拉线上关卡，三级回退 |
| `src/game/shape.ts`（加） | `pinchCells`、`strayCells`：给配置页圈出有问题的格子 |
| `src/game/solver.ts`（加） | `unreachedCells`：怎么滚都染不到的格子 |
| `src/solve/tour.ts`（新） | 整数规划算最少步数（从 `tools/mip.ts` 搬来，HiGHS 由调用方传入） |
| `src/solve/repair.ts`（新） | 修改建议 |
| `tools/mip.ts`（变薄） | 加载 Node 版 HiGHS，转调 `src/solve/tour.ts` |
| `worker/api.ts`、`worker/index.ts`（新） | `/api/levels` 的处理函数、Worker 入口 |
| `tools/dev-api.ts`（新） | Vite 插件：开发和预览服务器里的假接口 + `/config` 路径 |
| `config.html`、`src/config/*`（新） | 配置页 |
| `src/ui/tree.ts`（新） | 选关树 |
| `src/app.ts`、`src/ui/hud.ts`、`src/main.ts`、`index.html`、`src/style.css` | 接上关卡表、存档 v2、树 |

---

### Task 1: 关卡表的格式和基本校验

**Files:**
- Create: `src/game/levelset.ts`
- Delete: `src/view/dyes.ts`（任务 3 改完 `app.ts` 后再删；本任务先不动它）
- Test: `tests/levelset.test.ts`

**Interfaces:**
- Consumes: `parseLevel`、`LevelDef`（`level.ts`）；`newGame/roll/isDone/steps`（`rules.ts`）；`floorConnected/hasPinch`（`shape.ts`）；`LEVELS`（`levels.ts`）
- Produces:

```ts
export interface LevelEntry extends LevelDef { readonly id: string; readonly dye: string }
export interface LevelSet { readonly version: 1; readonly levels: readonly LevelEntry[] }
export const LIMITS: { readonly maxLevels: 200; readonly minSide: 5; readonly maxLong: 23; readonly maxShort: 17 };
/** 八种现成的染料：靛蓝、茜红、松绿、藤黄、紫、叶绿、玫红、湖蓝（和原来 dyes.ts 的顺序、数值一样） */
export const DYES: readonly string[]; // ['#2646b8','#c0302b','#0e8a78','#dd8e10','#6f3bb5','#3f8f2e','#cf3f77','#1787c2']
/** '#2646b8' → 0x2646b8 */
export function dyeNumber(css: string): number;
/** 行、列合不合尺寸上的规定 */
export function sizeOk(rows: number, cols: number): boolean;
/** 一张图的指纹：rows.join('/') 的 FNV-1a 32 位，8 位十六进制 */
export function sigOf(rows: readonly string[]): string;
export type Checked =
  | { readonly ok: true; readonly set: LevelSet }
  /** level：出错的是第几关（从 0 数起）；不是某一关的问题时是 -1 */
  | { readonly ok: false; readonly level: number; readonly detail: string };
/** 基本校验。通过时返回的 set 只含认识的字段（多余的字段丢掉），dye 统一成小写 */
export function checkLevelSet(data: unknown): Checked;
/** 内置 80 关：编号 b01–b80，染料按 DYES 轮着取 */
export const BUILTIN: LevelSet;
```

校验顺序（遇到第一个问题就返回）：`data` 是对象且 `version === 1` → `levels` 是 1–200 项的数组 → 逐关：`id` 格式、不重复 → `rows` 是字符串数组、每行一样长、只有 `#.S`、`sizeOk` → 恰好一个 `S` → 地面连成一片 → 没有只在角上相碰的墙 → `dye` 匹配 `/^#[0-9a-f]{6}$/i` → `par` 是 ≥ 1 的整数 → `solution` 只含 `URDL` 且长度等于 `par` → 照着走每一步都滚得动、走完正好染完。任何一步都不许抛异常（输入是不可信的 JSON）。

- [ ] **Step 1: 写测试 `tests/levelset.test.ts`**

```ts
const good = (over: object = {}) => ({ id: 'aa', rows: ['S....', '#####', '#####', '#####', '#####'], dye: '#2646b8', par: 1, solution: 'R', ...over });
const set = (...levels: unknown[]) => ({ version: 1, levels });
const bad = (data: unknown) => { const r = checkLevelSet(data); expect(r.ok).toBe(false); return r as { level: number; detail: string }; };

it('accepts the 80 built-in levels, numbered b01 to b80 with the dyes taking turns', () => {
  const r = checkLevelSet(JSON.parse(JSON.stringify(BUILTIN)));
  expect(r.ok).toBe(true);
  expect(BUILTIN.levels).toHaveLength(80);
  expect(BUILTIN.levels[0]).toMatchObject({ id: 'b01', dye: '#2646b8', par: 3, solution: 'ULD' });
  expect(BUILTIN.levels[8].dye).toBe('#2646b8');
  expect(BUILTIN.levels[79].id).toBe('b80');
});
it('keeps only the fields it knows and lower-cases the dye', () => {
  const r = checkLevelSet(set(good({ dye: '#AABBCC', extra: 1 })));
  expect(r).toEqual({ ok: true, set: { version: 1, levels: [{ id: 'aa', rows: good().rows, dye: '#aabbcc', par: 1, solution: 'R' }] } });
});
```

每条约束一个反例（`it.each`），断言 `bad(...)` 的 `level`：不是对象 / `null` / 数组 / `version: 2` / `levels: 'x'` / 0 关 / 201 关 → `-1`；
`id` 为 `'B1'`、`'a'`、13 位、数字 `7` → `0`；第二关和第一关同 `id` → `1`；
`rows` 为 `'x'`、`[1,2,3,4,5]`、行长不等、含 `'x'` 字符、4 行、24 行、`23×18`（短边 18）、`18×18` → `0`；
两个 `S`、没有 `S` → `0`；地面断成两片、对角相碰 → `0`；
`dye` 为 `'red'`、`'#12345'`、`123` → `0`；
`par` 为 `0`（只有起点一格）、`1.5`、`'1'`、和 `solution` 长度不等 → `0`；
`solution` 含 `'X'`、第一步滚不动（`'L'`）、走完没染完 → `0`；
`set(good(), null)` → `1`；`set(good(), 'x')` → `1`。

```ts
it('gives a different fingerprint to a different map and the same one to the same map', () => {
  expect(sigOf(['S.', '..'])).toMatch(/^[0-9a-f]{8}$/);
  expect(sigOf(['S.', '..'])).toBe(sigOf(['S.', '..']));
  expect(sigOf(['S.', '..'])).not.toBe(sigOf(['S.', '.#']));
});
it('says which sizes are allowed', () => {
  expect([sizeOk(5, 5), sizeOk(23, 17), sizeOk(17, 23), sizeOk(4, 9), sizeOk(24, 5), sizeOk(18, 18), sizeOk(23, 18)]).toEqual([true, true, true, false, false, false, false]);
});
```

- [ ] **Step 2:** `npx vitest run tests/levelset.test.ts` → 失败（模块不存在）
- [ ] **Step 3: 实现 `src/game/levelset.ts`**（签名见上）
- [ ] **Step 4:** `npx vitest run tests/levelset.test.ts` → 全过；`npx tsc --noEmit` → 无错

---

### Task 2: 存档 v2、迁移、"哪些关能玩"

**Files:**
- Rewrite: `src/game/progress.ts`
- Test: `tests/progress.test.ts`（新）

**Interfaces:**
- Consumes: `LevelSet`、`BUILTIN`、`sigOf`（任务 1）
- Produces:

```ts
export const SAVE_KEY = 'coloring-maze.v2';
export const OLD_SAVE_KEY = 'coloring-maze.v1';
/** 一关在存档里用什么认：固定编号 + 现在这张图的指纹 */
export interface LevelKey { readonly id: string; readonly sig: string }
export function keysOf(set: LevelSet): LevelKey[];
export interface Done { readonly best: number; readonly sig: string }
export interface Progress { readonly done: Readonly<Record<string, Done>>; readonly muted: boolean }
export function emptyProgress(): Progress;
/** v2 的内容读得懂就用它；否则把 v1 迁过来；都没有就是空的 */
export function loadProgress(v2: string | null, v1: string | null): Progress;
export function writeProgress(p: Progress): string;
/** 通过了没有（图后来被改过也算通过） */
export function passed(p: Progress, id: string): boolean;
/** 最好步数；没通过、或者通过之后图被改过，返回 0 */
export function bestOf(p: Progress, key: LevelKey): number;
/** 记一次通关：同一张图取更少的步数；图变了就以这次为准 */
export function record(p: Progress, key: LevelKey, steps: number): Progress;
/** 合并另一个标签页存的：同一张图取更好的；指纹不同时取和 keys 对得上的那份，都对不上取自己的；muted 以自己为准 */
export function mergeProgress(mine: Progress, theirs: Progress, keys: readonly LevelKey[]): Progress;
export type NodeState = 'done' | 'open' | 'locked';
/** 第 i 关：通过了是 done；没通过但排第一、或前一位通过了是 open；其余 locked */
export function stateOf(p: Progress, keys: readonly LevelKey[], i: number): NodeState;
/** 位置最靠后的那个 open 的关；没有（全通了）就是最后一关 */
export function topOpen(p: Progress, keys: readonly LevelKey[]): number;
```

v1 迁移：`best[i] > 0`（整数）且 `i < 80` → `done['b' + 两位序号] = { best, sig: 内置第 i 关的指纹 }`；`muted` 照搬。读不懂的一律当没有，个别不合理的记录单独丢掉（`best` 不是正整数、`sig` 不是字符串）。

- [ ] **Step 1: 写测试 `tests/progress.test.ts`**

```ts
const K = keysOf(BUILTIN);
it('moves an old save over: bests by position become records by level id', () => {
  const p = loadProgress(null, JSON.stringify({ best: [3, 0, 6], last: 2, muted: true }));
  expect(p).toEqual({ done: { b01: { best: 3, sig: K[0].sig }, b03: { best: 6, sig: K[2].sig } }, muted: true });
});
it('ignores the old save once a new one exists', () => {
  expect(loadProgress(JSON.stringify({ done: {}, muted: false }), JSON.stringify({ best: [3], last: 0, muted: true }))).toEqual(emptyProgress());
});
it('falls back to the old save when the new one cannot be read', () => {
  expect(passed(loadProgress('{oops', JSON.stringify({ best: [3], last: 0, muted: false })), 'b01')).toBe(true);
});
it.each(['', 'null', '[]', '"x"', '{"done":7}'])('treats %j as no save at all', (raw) => { expect(loadProgress(raw, null)).toEqual(emptyProgress()); });
it('drops single records that make no sense and keeps the rest', () => {
  const raw = JSON.stringify({ done: { a1: { best: 4, sig: 'x' }, a2: { best: 0, sig: 'x' }, a3: { best: 2.5, sig: 'x' }, a4: { best: 3 }, a5: null }, muted: 1 });
  expect(loadProgress(raw, null)).toEqual({ done: { a1: { best: 4, sig: 'x' } }, muted: false });
});
it('keeps the better result on the same map, and starts over when the map has changed', () => {
  let p = record(emptyProgress(), { id: 'a1', sig: 's1' }, 9);
  p = record(p, { id: 'a1', sig: 's1' }, 12);
  expect(p.done.a1).toEqual({ best: 9, sig: 's1' });
  expect(bestOf(p, { id: 'a1', sig: 's2' })).toBe(0);
  expect(passed(p, 'a1')).toBe(true);
  expect(record(p, { id: 'a1', sig: 's2' }, 20).done.a1).toEqual({ best: 20, sig: 's2' });
});
it('keeps the record of a level that is no longer in the set', () => {
  const p = record(emptyProgress(), { id: 'gone', sig: 's' }, 5);
  expect(loadProgress(writeProgress(p), null)).toEqual(p);
});
```

`stateOf` / `topOpen`（设计 6.4 的例子，用自造的 keys `k('a')…`）：
- 新玩家：`['open','locked','locked']`，`topOpen = 0`。
- 通过前两关：`['done','done','open','locked']`，`topOpen = 2`。
- 老玩家通过了 `b01`–`b60`，在第 5 位（下标 4）插入新关 `x1`：下标 4 是 `open`，下标 61（原来的 b61）是 `open`，下标 62 是 `locked`，`topOpen = 61`。
- 换顺序：通过了 a、b，顺序改成 `[c, a, b, d]` → `['open','done','done','open']`。
- 全通：`topOpen = 最后一关的下标`。

`mergeProgress`：两边各有对方没有的关 → 并集；同关同指纹 → 取小；同关不同指纹 → 取指纹和 `keys` 对得上的那份；都对不上 → 自己的；`muted` 取自己的。

- [ ] **Step 2:** `npx vitest run tests/progress.test.ts` → 失败
- [ ] **Step 3: 重写 `src/game/progress.ts`**（旧的导出全部删掉；`app.ts`、`hud.ts` 在任务 3 跟着改，所以本任务结束时 `tsc` 会在这两个文件报错——任务 2、3 连着做，中间不单独验 `tsc`）
- [ ] **Step 4:** `npx vitest run tests/progress.test.ts` → 全过

---

### Task 3: 游戏改用"启动时拿到的关卡表"

**Files:**
- Modify: `src/app.ts`、`src/ui/hud.ts`、`src/main.ts`
- Delete: `src/view/dyes.ts`
- Modify: `tests/app.test.ts`、`tests/helpers/fake-browser.ts`

**Interfaces:**
- Consumes: 任务 1、2 的全部导出
- Produces:

```ts
// src/app.ts
export class App {
  constructor(canvas: HTMLCanvasElement, font: string);
  /** 木纹、字体、关卡表都备好之后调用 */
  start(set: LevelSet): void;
  snapshot(): { level: number; id: string; steps: number; pos: number; dyed: number; floor: number; phase: string; idle: boolean; settled: boolean; solution: string };
}
// src/ui/hud.ts —— 面板还在（任务 8 才拆），只是不再自己读存档
export interface TileInfo { readonly par: number; readonly dye: string; readonly best: number; readonly open: boolean }
openLevels(tiles: readonly TileInfo[], current: number): void;
```

做法：`App` 里不再出现 `LEVELS`、`dyeOf`、`dyeCss`、`isUnlocked`、`progress.last`。染料 `entry.dye`（CSS）和 `dyeNumber(entry.dye)`（给 `view.enter`）。存档用 `SAVE_KEY`，读用 `loadProgress(读 v2, 读 v1)`，存之前 `mergeProgress(mine, loadProgress(读 v2, null), keys)`。提示牌：`index === 0 && !passed(progress, 第一关的 id)`。面板里某一关能不能点：`stateOf(...) !== 'locked'`。**过渡期**（到任务 8 为止）`start(set)` 打开 `topOpen(progress, keys)` 那一关。`main.ts` 先传 `BUILTIN`（任务 5 换成线上的）。

- [ ] **Step 1: 改 `tests/app.test.ts` 的辅助函数和用到旧存档格式的用例**

```ts
const SAVE = 'coloring-maze.v2';
const K = keysOf(BUILTIN);
/** 按内置关卡的顺序给出每关的最好步数（0 = 没通过），拼成一份 v2 存档 */
const saveOf = (bests: readonly number[], muted = false) => ({ done: Object.fromEntries(bests.flatMap((b, i) => (b > 0 ? [[K[i].id, { best: b, sig: K[i].sig }]] : []))), muted });
interface BootOptions { readonly bests?: readonly number[]; readonly screen?: { width: number; height: number }; readonly set?: LevelSet; /** 进第几关（从 1 数起）；不给就停在启动时打开的那一关 */ readonly enter?: number }
async function boot(options: BootOptions = {}): Promise<{ browser: FakeBrowser; app: Inner }>;
/** 从选关面板进第 n 关（从 1 数起），等它摆好 */
async function enter(browser: FakeBrowser, n: number): Promise<void>;
```

原来靠 `last` 直接进某一关的用例改成 `boot({ bests, enter: n })`；读存档断言的地方改成 `JSON.parse(...).done.b01.best`。删掉两条只和 `last` 有关的断言（"comes back to the level that was being played"、乱按测试里的 `progress.last`）。新增：

```ts
it('reads an old save and writes a new one without touching the old', async () => {
  const browser = new FakeBrowser(); browser.install();
  browser.storage.set('coloring-maze.v1', JSON.stringify({ best: [3, 5], last: 1, muted: true }));
  /* 启动 → 进第 1 关 → 走完 */
  expect(JSON.parse(browser.storage.get(SAVE)!)).toMatchObject({ done: { b01: { best: 3 }, b02: { best: 5 } }, muted: true });
  expect(JSON.parse(browser.storage.get('coloring-maze.v1')!).best).toEqual([3, 5]);
});
it('plays a set that is not the built-in one, with each level in its own dye', async () => { /* set = [BUILTIN 第 3 关改 id 'x1' dye '#123456', BUILTIN 第 1 关]；par 文案、view.enter 收到的 0x123456、通关后 done.x1 */ });
it('still starts and can be played when the browser refuses to store anything', async () => { /* localStorage.getItem / setItem 都抛异常；走完第 1 关 phase === 'done' */ });
```

- [ ] **Step 2:** `npx vitest run tests/app.test.ts` → 失败
- [ ] **Step 3: 改 `src/app.ts`、`src/ui/hud.ts`、`src/main.ts`，删 `src/view/dyes.ts`**
- [ ] **Step 4:** `npx vitest run tests/app.test.ts tests/progress.test.ts tests/levelset.test.ts` → 全过；`npx tsc --noEmit` → 无错

---

### Task 4: Worker 接口、wrangler 配置、开发服务器里的假接口

**Files:**
- Create: `worker/api.ts`、`worker/index.ts`、`tools/dev-api.ts`
- Modify: `wrangler.jsonc`、`vite.config.ts`、`tsconfig.json`（`include` 加 `"worker"`）
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `checkLevelSet`（任务 1）
- Produces:

```ts
// worker/api.ts —— 纯函数，不依赖 Cloudflare 的类型
export interface KV { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }
export interface Env { readonly LEVELS_KV: KV; readonly LEVEL_ADMIN_TOKEN?: string }
export const MAX_BODY = 1_000_000;
export function handle(request: Request, env: Env): Promise<Response>;
// worker/index.ts
export default { fetch(request, env: Env & { ASSETS: { fetch(r: Request): Promise<Response> } }): Promise<Response> };  // /api/* 交给 handle，其余交给 env.ASSETS
// tools/dev-api.ts
export function devApi(): import('vite').Plugin;  // dev 和 preview 都生效：/api/* 走 handle；/config → /config.html
```

接口（所有响应 `Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`）：

| 请求 | 响应 |
| --- | --- |
| `GET /api/levels` | 200 KV 里的原文；没有时 404 `{"error":"not_found"}` |
| `POST /api/levels` | 口令对 200 `{"ok":true}`；否则 401 `{"error":"unauthorized"}` |
| `PUT /api/levels` | 401；请求体超过 `MAX_BODY` 字节 413 `{"error":"too_large","detail":…}`；不是 JSON 或校验不过 400 `{"error":"invalid","detail":…,"level":N}`（`N` 从 1 数起，不是某一关的问题时是 0）；成功 200 `{"ok":true,"count":N}` |
| `/api/levels` 的其它方法 | 405 `{"error":"method_not_allowed"}` |
| `/api/` 下别的路径 | 404 `{"error":"not_found"}` |

口令：`Authorization: Bearer <口令>`；`LEVEL_ADMIN_TOKEN` 没配或是空串时一律 401；比较用不提前返回的逐字符比较。发布：先读旧的 `levels`，有就写进 `levels:prev`，再写 `levels`（内容是 `JSON.stringify(校验后的 set)`）。超长判断先看 `Content-Length`，读完再按实际字节数查一遍。

`wrangler.jsonc`：加 `"main": "worker/index.ts"`、`"assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": ["/api/*"] }`、`"kv_namespaces": [{ "binding": "LEVELS_KV", "id": "<任务 10 填>" }]`。写之前用 cloudflare:wrangler 技能和 Cloudflare 当前文档核对这三项的写法、`html_handling` 的默认值（`/config` → `config.html`）和免费版每次请求的 CPU 限额，把查到的限额写进 `wrangler.jsonc` 的注释。

`tools/dev-api.ts`：KV 是一个 JSON 文件，路径取环境变量 `MAZE_DEV_KV`，没有就用 `node_modules/.cache/coloring-maze/dev-kv.json`；口令固定 `dev-token`。`vite.config.ts`：`plugins: [devApi()]`，`build.rolldownOptions.input = { main: 'index.html', config: 'config.html' }`（`config.html` 任务 7 才有；本任务先建一个只有标题的占位页，保证 `npm run build` 能过）。

- [ ] **Step 1: 写测试 `tests/api.test.ts`**

```ts
class FakeKV implements KV { readonly data = new Map<string, string>(); async get(k: string) { return this.data.get(k) ?? null; } async put(k: string, v: string) { this.data.set(k, v); } }
const call = (method: string, init: { token?: string; body?: string; path?: string; headers?: Record<string, string> } = {}, env: Partial<Env> = {}) => { /* 拼 Request，默认 env = { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: 'secret' } */ };
```

用例（名字 + 断言）：
- `GET` 没发布过 → 404 `{error:'not_found'}`，`Cache-Control` 是 `no-store`。
- `GET` 发布过 → 200，正文就是 KV 里的原文。
- `POST` 不带口令 / 口令错 / 口令对 → 401 / 401 / 200 `{ok:true}`。
- 没配 `LEVEL_ADMIN_TOKEN`（`undefined` 和 `''` 各一次）时，`POST` 和 `PUT` 带 `Bearer undefined`、`Bearer `、不带 → 全是 401，KV 没被写。
- `PUT` 口令错 → 401，KV 没被写。
- `PUT` 正文 `{oops` → 400 `{error:'invalid', level:0}`。
- `PUT` 第 2 关地面断开 → 400 `level === 2`，`detail` 非空，KV 没被写。
- `PUT` 类型不对的几种（`{"version":1,"levels":"x"}`、`rows:[1,2,3,4,5]`、`levels:[null]`、`par:1.5`）→ 都是 400，没有一个抛异常。
- `PUT` 正文 1 000 001 字节 → 413，KV 没被写；`Content-Length` 谎报成 10 但正文超长 → 也是 413。
- `PUT` 成功 → 200 `{ok:true,count:1}`；`levels` 是校验后的 JSON；第一次发布后没有 `levels:prev`。
- `PUT` 第二次成功 → `levels:prev` 是第一次的内容，`levels` 是第二次的。
- `PUT` 内置 80 关 → 200 `count: 80`。
- `DELETE /api/levels` → 405；`GET /api/other` → 404。

- [ ] **Step 2:** `npx vitest run tests/api.test.ts` → 失败
- [ ] **Step 3: 实现 `worker/api.ts`、`worker/index.ts`**
- [ ] **Step 4:** `npx vitest run tests/api.test.ts` → 全过
- [ ] **Step 5: 量一下最坏情况的校验时间**：Node 里对"200 关、每关都是内置第 80 关（23×17，154 步，换成各不相同的 id）"跑 `JSON.parse` + `checkLevelSet` + `JSON.stringify` 各 50 次取中位数，把数字写进 `worker/api.ts` 顶部的注释（预期两三毫秒；超过 8 毫秒就停下来报告）。
- [ ] **Step 6: 实现 `tools/dev-api.ts`，改 `vite.config.ts`、`tsconfig.json`、`wrangler.jsonc`，建占位的 `config.html`**
- [ ] **Step 7:** `npx tsc --noEmit` 无错；`npm run build` 成功且 `dist/config.html` 存在；`WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run` 打包成功（KV id 还是占位符，dry-run 不联网）；起 `npx vite preview` 后 `curl` 验：`GET /api/levels` 404 → `PUT`（`Bearer dev-token`，内置 80 关）200 → `GET` 200 → `/config` 返回占位页。

---

### Task 5: 游戏启动时拉线上关卡

**Files:**
- Create: `src/game/remote.ts`
- Modify: `src/main.ts`
- Test: `tests/remote.test.ts`

**Interfaces:**
- Consumes: `checkLevelSet`、`BUILTIN`、`LevelSet`（任务 1）；`App.start(set)`（任务 3）
- Produces:

```ts
export const LEVELS_CACHE_KEY = 'coloring-maze.levels';
export interface Loaded { readonly set: LevelSet; readonly source: 'remote' | 'cache' | 'builtin' }
export interface LoadOptions {
  readonly fetch?: (url: string, init: { cache: 'no-store'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readonly storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  readonly timeoutMs?: number; // 默认 2500
}
/** 永远不抛异常、不拒绝；每种失败在控制台记一句 */
export function loadLevelSet(options?: LoadOptions): Promise<Loaded>;
```

`main.ts`：`boot()` 一开头就发请求（和画木纹、等字体同时进行），`app.start((await levels).set)`。

- [ ] **Step 1: 写测试 `tests/remote.test.ts`**（`vi.spyOn(console, 'warn')` 压住输出）
  - 线上给了合格的关卡表 → `source: 'remote'`，`set` 等于它，缓存里留了一份。
  - `fetch` 拒绝 / 回 404 / 回 500 / 正文不是 JSON / 关卡表校验不过，而缓存里有合格的 → `source: 'cache'`。
  - 同上而缓存是空的 / 缓存不是 JSON / 缓存校验不过 → `source: 'builtin'`，`set === BUILTIN`。
  - `fetch` 永远不返回：`vi.useFakeTimers()`，推进 2499 毫秒还没结果，再推进 1 毫秒 → 回退；传给 `fetch` 的 `signal.aborted === true`。
  - `storage.getItem`、`setItem` 都抛异常：线上合格 → 仍是 `'remote'`；线上失败 → `'builtin'`。
  - 线上不合格时不覆盖缓存里原来那份合格的。
- [ ] **Step 2:** `npx vitest run tests/remote.test.ts` → 失败
- [ ] **Step 3: 实现 `src/game/remote.ts`，改 `src/main.ts`**
- [ ] **Step 4:** `npx vitest run tests/remote.test.ts tests/app.test.ts` → 全过；`npx tsc --noEmit` 无错

---

### Task 6: 求解搬家；修改建议

**Files:**
- Create: `src/solve/tour.ts`、`src/solve/repair.ts`
- Modify: `tools/mip.ts`（只剩加载 HiGHS + 转调）、`src/game/shape.ts`、`src/game/solver.ts`、`package.json`（`highs` 从 `devDependencies` 挪到 `dependencies`，`package-lock.json` 跟着更新）
- Test: `tests/repair.test.ts`；`tests/shape.test.ts`、`tests/solver.test.ts` 各加几条；`tests/mip.test.ts`、`tests/levels-*.test.ts`、`tools/build-levels.ts` **不改**且照样通过

**Interfaces:**
- Consumes: `stepGraph`、`shortfall`（`solver.ts`）；`hasPinch`、`floorConnected`（`shape.ts`）
- Produces:

```ts
// src/solve/tour.ts —— 算法原样搬过来，一行逻辑都不改，只是 HiGHS 由调用方传入
export interface Solver { solve(model: string, options?: Record<string, unknown>): { readonly Status: string; readonly Columns: unknown } }
export interface Tour { readonly par: number; readonly solution: string; readonly rounds: number; readonly forced: number }
export interface TourOptions { readonly maxNodes?: number; readonly maxRounds?: number; readonly seed?: number; readonly atMost?: number; readonly forcedOnly?: boolean }
export class TourLimitError extends Error {}
export function shortestTour(highs: Solver, level: Level, options?: TourOptions): Tour | null;
// tools/mip.ts —— 对外的样子不变
export { TourLimitError, type Tour, type TourOptions } from '../src/solve/tour.ts';
export function shortestTour(level: Level, options?: TourOptions): Tour | null;

// src/game/shape.ts
/** 只在角上相碰的那些 2×2 里的格子（去重，从小到大） */
export function pinchCells(floor: Uint8Array, rows: number, cols: number): number[];
/** 和 from 那一格不连着的地面格 */
export function strayCells(floor: Uint8Array, rows: number, cols: number, from: number): number[];
// src/game/solver.ts
/** 怎么滚都染不到的地面格 */
export function unreachedCells(level: Level): number[];

// src/solve/repair.ts
export interface Change { readonly cell: number; /** '#' 改成墙，'.' 改成地面，'S' 把起点挪到这格（原来的起点变成普通地面） */ readonly to: '#' | '.' | 'S' }
export interface Repair { readonly changes: readonly Change[]; readonly rows: readonly string[] }
export interface RepairOptions { readonly maxChanges?: number; /** 整个搜索最多花多少毫秒，默认 30000 */ readonly maxMs?: number; readonly now?: () => number }
/** 这张图合不合格：地面至少两格、没有只在角上相碰的墙、shortfall 为 0 */
export function sound(rows: readonly string[]): boolean;
/** 改最少的格子让图合格。已经合格返回 changes 为空；maxChanges（默认 6）格以内没找到返回 null */
export function suggestRepair(rows: readonly string[], options?: RepairOptions): Repair | null;
export function applyChanges(rows: readonly string[], changes: readonly Change[]): string[];
```

**修改建议的算法**（签名和测试定不下它，所以写明）：

```
一次改动 = 把某一格墙↔地面互换（起点那格不能改成墙），或者把起点挪到另一格地面。同一格不改两次，起点最多挪一次。
离合格多远 lack(图) = shortfall(图) + 3 × 只在角上相碰的 2×2 的个数 + (地面只有一格 ? 1000 : 0)
合格 = lack 为 0

候选数 n = 格子数 + 地面格数；每一层最多评估 E = clamp(round(2_400_000 / 格子数), 4000, 40000) 张图
第 1 层：评估全部 n 种只改一格的图（扫描顺序：先按格子编号从小到大试互换，再按编号试挪起点）。有合格的 → 返回扫描顺序里第一个。
第 d 层（d = 2 … maxChanges）：从上一层评估过的图里留下 lack 最小的 keep = max(6, floor(E / n)) 张（并列按扫描顺序），
  每张再试全部只改一格的；同一张结果图（floor + 起点）一层里只评估一次；有合格的 → 返回第一个。
  keep ≥ 上一层的图数时这一层就是穷举，所以 10×10 以内"改两格"也保证是最少的。
每评估 64 张图看一次钟，超过 maxMs 返回 null。
```

评估时直接在 `Uint8Array` 上改一格、拼 `Level` 对象交给 `shortfall`，不来回转字符画。

- [ ] **Step 1: 搬家**：建 `src/solve/tour.ts`（从 `tools/mip.ts` 剪过来，`highs` 变成第一个参数），`tools/mip.ts` 改成转调；改 `package.json` 并用 npmmirror 重新生成锁文件。
- [ ] **Step 2:** `npx vitest run tests/mip.test.ts tests/gen.test.ts` → 全过（几分钟）。这一步证明搬家没改变任何结果。
- [ ] **Step 3: 写测试**

`tests/shape.test.ts` 加：`pinchCells` 在 `['S#', '#.']` 上返回 `[0,1,2,3]`，在没有对角相碰的图上返回 `[]`；`strayCells` 在两片地面的图上返回另一片的格子。
`tests/solver.test.ts` 加：`unreachedCells(parseLevel(['S..', '#.#', '#.#']))` 返回 `[4, 7]`；对内置第 1 关返回 `[]`。

`tests/repair.test.ts`：

```ts
const ok = (rows: readonly string[]) => sound(rows);
/** 穷举：只改一格能不能修好 */
function fixableInOne(rows: readonly string[]): boolean;
/** 穷举：改两格能不能修好（只用于 6×6 以内） */
function fixableInTwo(rows: readonly string[]): boolean;

it('leaves a map that is already fine alone', () => {
  for (const i of [0, 7, 22, 40]) expect(suggestRepair(BUILTIN.levels[i].rows)).toEqual({ changes: [], rows: [...BUILTIN.levels[i].rows] });
});
it('gives back a map that is sound, within six changes, never touching a cell twice (300 random bad maps, 5×5 to 9×9)', () => {
  // seeded(11)；randomMaze(rand, 5–9, 5–9, 0.1–0.4)；跳过本来就 sound 的
  // 对每个非 null 的结果：sound(result.rows)、applyChanges(rows, result.changes) 等于 result.rows、
  //   changes.length 在 1–6 之间、cell 互不相同、to 为 'S' 的最多一个
  // 至少 150 张找到了建议（否则等于没测）
});
it('never changes more than one cell when one is enough (checked against trying every single change)', () => { /* 同样的随机图：fixableInOne(rows) 为真时 changes.length === 1；这种情况至少碰到 60 次 */ });
it('never changes more than two cells on a small map when two are enough', () => { /* 5×5、5×6、6×6 各 60 张：!fixableInOne && fixableInTwo 时 changes.length === 2；至少碰到 20 次 */ });
it('repairs a built-in level after one of its cells has been spoilt', () => { /* 内置第 5、12、20 关各挑一格地面改成墙使它不 sound；建议不超过 1 格 */ });
it('never suggests walling up everything but the start', () => {
  // 只有起点和远处一格地面：把那一格改成墙会只剩一格地面，不算修好
  const r = suggestRepair(['S####', '#####', '####.', '#####', '#####']);
  expect(r === null || (ok(r.rows) && r.rows.join('').replaceAll('#', '').length >= 2)).toBe(true);
});
it('says so when nothing within the allowed number of changes helps', () => { /* 找一张 !fixableInOne 的随机图，suggestRepair(rows, { maxChanges: 1 }) 为 null */ });
it('gives up when it runs out of time', () => { /* now 每次调用加 1000：suggestRepair(坏图, { maxMs: 1, now }) 为 null */ });
it('finds something for a hand-drawn 15×15 with a few blocks within its time limit', () => { /* 一张写死的 15×15 开阔图（四五块墙，起点在角上）；结果非 null 时 sound；用时 < 30 秒 */ });
```

- [ ] **Step 4:** `npx vitest run tests/repair.test.ts tests/shape.test.ts tests/solver.test.ts` → 新用例失败
- [ ] **Step 5: 实现 `pinchCells`、`strayCells`、`unreachedCells`、`src/solve/repair.ts`**
- [ ] **Step 6:** 同一条命令 → 全过；`npx tsc --noEmit` 无错

---

### Task 7: 配置页

**Files:**
- Create: `config.html`（替换任务 4 的占位页）、`src/config/main.ts`、`model.ts`、`check.ts`、`worker.ts`、`checker.ts`、`grid.ts`、`list.ts`、`gate.ts`、`api.ts`、`config.css`
- Modify: `vite.config.ts`（`worker: { format: 'es' }`，如果需要）
- Test: `tests/config-model.test.ts`、`tests/config-check.test.ts`、`tests/config-checker.test.ts`

**Interfaces:**
- Consumes: `LevelSet`、`LevelEntry`、`BUILTIN`、`DYES`、`LIMITS`、`sizeOk`、`checkLevelSet`（任务 1）；`shortestTour`、`Solver`、`TourLimitError`（任务 6）；`suggestRepair`、`applyChanges`、`Repair`、`Change`（任务 6）；`pinchCells`、`strayCells`、`unreachedCells`、`shortfall`；接口的约定（任务 4）
- Produces（页面内部用；任务 9 的浏览器走查靠这些 DOM id）：

```ts
// src/config/model.ts —— 纯逻辑
export interface Draft { readonly id: string; readonly rows: readonly string[]; readonly dye: string; /** 还没算出来（图改过）是 null */ readonly par: number | null; readonly solution: string | null }
export function draftsOf(set: LevelSet): Draft[];
/** 有哪一关还没算出最少步数就返回 null */
export function setOf(drafts: readonly Draft[]): LevelSet | null;
/** 画一格：'#' 墙、'.' 地面。起点那格不能涂成墙。没变化时返回原来那个数组（同一个引用） */
export function paint(rows: readonly string[], cell: number, to: '#' | '.'): readonly string[];
/** 起点挪到这格地面；点的是墙就不动 */
export function moveStart(rows: readonly string[], cell: number): readonly string[];
/** 改大小：多出来的是地面；改小裁掉右边、下边；起点被裁掉就放到第一个地面格上，一格地面都不剩就把左上角变成起点 */
export function resize(rows: readonly string[], toRows: number, toCols: number): string[];
/** 另一边是 other 格时，这一边最多能有几格（17 或 23） */
export function maxSide(other: number): number;
/** 新关：7×7 的空地，起点在左上角 */
export function blankRows(): string[];
/** 6 位随机编号，和 taken 里的都不重复 */
export function newId(taken: ReadonlySet<string>, rand?: () => number): string;
export function moved<T>(list: readonly T[], from: number, to: number): T[];

// src/config/check.ts —— 纯逻辑，主线程和 Worker 线程都用
export type Verdict =
  | { readonly kind: 'shape'; readonly problem: 'few' | 'split' | 'pinch'; readonly cells: readonly number[] }
  | { readonly kind: 'unreached'; readonly cells: readonly number[] }
  | { readonly kind: 'unsolvable' }
  | { readonly kind: 'ok'; readonly par: number; readonly solution: string; /** shortfall 为 0 */ readonly safe: boolean };
/** 便宜的那两步（形状、每一格滚不滚得到）；没问题返回 null */
export function precheck(rows: readonly string[]): Extract<Verdict, { kind: 'shape' | 'unreached' }> | null;
/** 全部四步 */
export function fullCheck(highs: Solver, rows: readonly string[]): Verdict;
/** 一条建议写成一句话，例如"把圈出的 2 格改成墙""把圈出的 1 格改成墙、1 格改成地面""把起点挪到圈出的那一格" */
export function describe(changes: readonly Change[]): string;

// src/config/checker.ts —— 管 Worker 线程
export type CheckPhase = 'queued' | 'solving' | 'repairing' | 'done' | 'timeout' | 'failed';
export interface CheckState { readonly phase: CheckPhase; readonly verdict?: Verdict; /** undefined 还在找，null 没找到 */ readonly repair?: Repair | null }
export interface WorkerLike { postMessage(message: unknown): void; terminate(): void; onmessage: ((event: { data: unknown }) => void) | null; onerror: ((event: unknown) => void) | null }
export const SOLVE_LIMIT_MS = 180_000;
export class Checker {
  constructor(spawn: () => WorkerLike, onChange: (id: string, state: CheckState) => void);
  /** 这一关的图变了：排队重查。正在算的就是这一关的旧图时，结束那个线程另起一个 */
  request(id: string, rows: readonly string[]): void;
  /** 优先算这一关（用户正看着的那一关） */
  prefer(id: string): void;
  forget(id: string): void;
}
// Worker 的收发：主线程发 { seq, rows }；线程回 { seq, verdict }，需要建议时再回 { seq, repair }，最后回 { seq, done: true }
```

页面的 DOM id（浏览器走查用）：`#gate`（口令弹层）、`#gate-input`、`#gate-submit`、`#gate-error`；`#level-list`（`li[data-id]`，不能发布的带 `.bad`）、`#btn-add`、`#btn-delete`；`#grid`（canvas，带 `data-rows`、`data-cols`）；`#size-rows`、`#size-cols`；`#brush-wall`、`#brush-floor`、`#brush-start`；`#dyes`（8 个 `button[data-dye]` + `#dye-custom`）；`#checks`（每项一个 `li`，`.pass`/`.fail`/`.warn`/`.busy`）、`#btn-apply`（采用建议）、`#par`；`#btn-publish`、`#publish-note`、`#link-game`。口令记在 `localStorage['coloring-maze.admin-token']`。

行为按设计 6.5。几处设计没写到的细节：
- 进门：先 `POST` 验口令；通过后 `GET /api/levels`：200 且校验过 → 用它；404 → 内置 80 关；其它（网络错、500、校验不过）→ 页面中间一句"读不到线上的关卡，请刷新重试"，不让编辑（免得用内置关卡把线上的盖掉）。
- 检查的四步在右栏按顺序各占一行；前一步没过，后面的显示成没查。`'few'` 的文案是"地面至少要有两格"。
- 改染料不触发重查（不影响图）；改图把这一关的 `par`/`solution` 置成 `null` 并 `checker.request`。把图改回和上次发布时一模一样时，直接恢复原来的 `par`/`solution`，不重算。
- 主线程每次改动立刻跑 `precheck`（毫秒级）更新画布上的圈和左栏的红标，Worker 的结果回来再补上后两步。
- 发布按钮：有任何一关 `par === null` 或被拦 → 禁用，`#publish-note` 写"第 N 关还不能发布"或"正在算第 N 关"。401 → 清口令、重新弹口令层。
- 字体用系统的黑体（`system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`），配色沿用游戏的木头色（`--table`、`--walnut`、`--birch`、`--cream`、`--ink`）。配置页不加载 three.js，木纹用 CSS 渐变近似。
- HiGHS：`worker.ts` 里 `import loadHighs from 'highs'` + `import wasmUrl from 'highs/runtime?url'`，`loadHighs({ locateFile: () => wasmUrl })`；第一次用到才加载。

先用 frontend-design 技能定版式和控件样式，再写页面。

- [ ] **Step 1: 写 `tests/config-model.test.ts`**
  - `draftsOf(BUILTIN)` 有 80 项，`setOf(draftsOf(BUILTIN))` 深等于 `BUILTIN`；有一项 `par: null` 时 `setOf` 返回 `null`。
  - `paint`：地面涂成墙、墙涂成地面；涂起点成墙 → 返回原数组（`toBe`）；涂成原来就是的样子 → 返回原数组。
  - `moveStart`：挪到地面格后恰好一个 `S`、原起点是 `.`；点墙 → 返回原数组。
  - `resize`：`5×5 → 7×6` 多出来的全是 `.`；`7×7 → 5×5` 裁掉右、下；起点在被裁掉的地方 → 新图恰好一个 `S`，在第一个地面格；裁完一格地面都不剩（剩下的全是墙）→ 左上角是 `S`；任何情况下结果都恰好一个 `S`（对 200 张随机图 × 随机新尺寸查一遍）。
  - `maxSide(17) === 23`，`maxSide(18) === 17`，`maxSide(5) === 23`。
  - `blankRows()` 是 7 行 `'S......'` 开头、其余 `'.......'`。
  - `newId`：匹配 `/^[a-z0-9]{6}$/`；`rand` 先给出一个已占用的再给出新的 → 返回新的。
  - `moved([a,b,c,d], 0, 2)` → `[b,c,a,d]`；`moved(list, 3, 0)` → `[d,a,b,c]`；不改原数组。
- [ ] **Step 2: 写 `tests/config-check.test.ts`**（HiGHS 用 `import loadHighs from 'highs'` 在 Node 里加载）
  - `precheck`：只有起点 → `{kind:'shape',problem:'few'}`；两片地面 → `problem:'split'`，`cells` 是另一片；对角相碰 → `problem:'pinch'`；`['S....','##.##','##.##','#####','#####']`（小球只在第一行两头来回，停不到中间那一列上方）→ `{kind:'unreached', cells:[7,12]}`；内置各关 → `null`。
  - `fullCheck`：内置第 1、16、35 关 → `{kind:'ok', par: 内置的 par, safe: true}`，`solution` 照着走能通关。
  - `fullCheck`："每一格都滚得到，但没有一条路线能全染上"——用 `seeded(21)` 的随机图找一张 `precheck` 为 `null` 而 `shortestTour` 为 `null` 的 → `{kind:'unsolvable'}`。
  - `fullCheck`：能通关但 `shortfall > 0` 的（同样用随机图找）→ `kind:'ok'` 且 `safe === false`。
  - `describe`：`[{to:'#'},{to:'#'}]` → `'把圈出的 2 格改成墙'`；一墙一地 → `'把圈出的 1 格改成墙、1 格改成地面'`；`[{to:'S'}]` → `'把起点挪到圈出的那一格'`；起点加一格墙 → `'把起点挪到圈出的那一格，另外 1 格改成墙'`。
- [ ] **Step 3: 写 `tests/config-checker.test.ts`**（假的 `WorkerLike` + `vi.useFakeTimers()`）
  - `request` 一关 → 线程收到 `{seq, rows}`，状态 `solving`；线程回 `verdict`（`ok`、`safe`）和 `done` → 状态 `done`。
  - 回的 `verdict` 是 `unsolvable` → 状态 `repairing`；再回 `repair` 和 `done` → `done`，带着建议。
  - 正在算 A 时 A 的图又变了 → 旧线程被 `terminate`，新线程收到新图；旧 `seq` 的消息即使到了也不理。
  - 正在算 A 时 `request` B → A 不被打断，A 完了才发 B；`prefer(C)` 让 C 排到 B 前面。
  - 180 秒没回 `verdict` → 线程被 `terminate`，状态 `timeout`，接着算下一关；找建议的阶段不受这 180 秒限制。
  - 线程 `onerror` → 状态 `failed`，接着算下一关。
  - `forget(A)`：A 在排队 → 不再算；A 正在算 → 线程被结束。
- [ ] **Step 4:** `npx vitest run tests/config-model.test.ts tests/config-check.test.ts tests/config-checker.test.ts` → 失败
- [ ] **Step 5: 实现 `model.ts`、`check.ts`、`checker.ts`** → 同一条命令全过
- [ ] **Step 6: 实现页面**：`config.html`、`config.css`、`api.ts`、`gate.ts`、`grid.ts`、`list.ts`、`worker.ts`、`main.ts`
- [ ] **Step 7:** `npx tsc --noEmit` 无错；`npm run build` 成功；`dist/` 里游戏页的 JS 不含 `highs`（`grep -L`），`highs.wasm` 只被配置页的 Worker 引用。
- [ ] **Step 8: 真浏览器走一遍**（puppeteer，脚本放 scratchpad；`MAZE_DEV_KV` 指到 scratchpad 里的临时文件；`npx vite preview`）：输错口令看到报错 → 输 `dev-token` 进门 → 看到 80 关 → 第 3 关涂一格墙使它通不了关 → 右栏出现"通不了关"和建议、发布按钮禁用 → 点「采用建议」→ 最少步数重新出现 → 新增一关（7×7）并画几格墙 → 等它算完 → 发布 → `GET /api/levels` 有 81 关 → 刷新配置页回显 81 关。1440×900 截图自己看一遍版式。

---

### Task 8: 选关树、改流程、拆掉旧面板

**Files:**
- Create: `src/ui/tree.ts`
- Modify: `index.html`、`src/style.css`、`src/app.ts`、`src/ui/hud.ts`、`src/ui/input.ts`、`src/view/view.ts`（只改 `enter` 的滑入）
- Modify: `tests/app.test.ts`、`tests/helpers/fake-browser.ts`
- Test: `tests/tree.test.ts`（新）

**Interfaces:**
- Consumes: `stateOf`、`topOpen`、`bestOf`、`NodeState`（任务 2）；`starsFor`
- Produces:

```ts
// src/ui/tree.ts
export interface TreeNode { readonly state: NodeState; readonly dye: string; /** 最好步数，没有是 0 */ readonly best: number; /** 几颗星，没有是 0 */ readonly stars: 0 | 1 | 2 | 3 }
export interface Spot { readonly x: number; readonly y: number; /** 枝杈朝哪边伸：-1 左，1 右 */ readonly side: -1 | 1 }
export interface TreeLayout { readonly width: number; readonly height: number; /** 每一关的木片中心，下标 0 是第 1 关（最靠下） */ readonly spots: readonly Spot[]; /** 树干、每根枝杈的 SVG 路径 */ readonly trunk: string; readonly branches: readonly string[] }
/** 纯几何：count 关、木板宽 width 像素时，树怎么排 */
export function layoutTree(count: number, width: number): TreeLayout;
export class Tree {
  constructor(onPick: (index: number) => void);
  /** 重画整棵树（关卡表或存档变了之后） */
  render(nodes: readonly TreeNode[]): void;
  /** 亮出来，并滚到第 focus 关在屏幕中间 */
  show(focus: number): void;
  hide(): void;
  readonly shown: boolean;
}
// src/ui/hud.ts
export interface HudHandlers { undo(): void; restart(): void; levels(): void; toggleSound(): void; next(): void; again(): void }
/** 进了一关 / 回到树上：步数和那排按钮亮出来 / 收起来（收起来时提示牌和通关面板也一起收） */
setPlaying(on: boolean): void;
// src/ui/input.ts —— onDir 返回 true 表示这次按键用掉了；没用掉就不拦浏览器的默认动作（树上方向键照常滚动）
export function listen(surface: HTMLElement, onDir: (dir: Dir) => boolean): void;
// src/app.ts
phase: 'tree' | 'entering' | 'playing' | 'done';   // snapshot().phase 多一个 'tree'；在树上时 snapshot().level 是上次那一关（没进过是 0）
```

DOM：`index.html` 里删掉 `<section class="levels" id="levels">` 整块，换成 `<section class="tree" id="tree" hidden aria-label="选关"><div class="tree-board" id="tree-board"></div></section>`；通关面板的按钮变成「再来一次」`#btn-again`、「选关」`#btn-result-levels`、「下一关」`#btn-next`。树的木片是 `button.knot`（`data-level` 从 1 数起；`.done`/`.open`/`.locked`；`locked` 的 `disabled`），按第 1 关到最后一关的顺序放在 `#tree-board` 里的 `ol.tree-knots` 中。

流程（设计 6.6）：
- `start(set)`：亮出树，滚到 `topOpen`；不进关。在树上时不调 `view.layout`（3D 画面不渲染）。
- 点 `open`/`done` 的木片 → `tree.hide()`、`hud.setPlaying(true)`、`open(index)`。从树上进关一律是重新摆一个托盘（哪怕和上次是同一关）。`view.enter` 改成没有旧托盘时新托盘也从右边滑进来（镜头直接到位，不平移）。
- 「选关」（`#btn-levels` 或 `#btn-result-levels`）→ 回到树：这一局不保留，树重画，滚到刚才那一关。
- 弹珠还在滚、托盘还在换、庆祝还没演完的时候都可以回树；回树之后这些动画的后续不许再改 `phase`、不许弹通关面板（`App` 里加一个"第几次换屏"的计数，异步的后续先对一下）。**最后一步已经按下、弹珠还在滚的时候回树：这次通关照记**，树上马上有星。
- 提示牌、`hasNext`、朝向的规则不变。

样子按设计 6.6：胡桃木板（`--wood-dark`）居中、最宽 560 像素，手机上铺满；树干和枝杈是刻出来的凹槽（深色线 + 一道受光边）；木片是圆的桦木片；星星和最好步数刻在木片外侧；通过的关叶子填上那一关的染料色。先用 frontend-design 技能定细节，边做边截图调（390×844、1440×900 各一张）。

- [ ] **Step 1: 写 `tests/tree.test.ts`**
  - `layoutTree(80, 560)`：`spots` 有 80 个；`y` 严格递减（第 1 关最靠下）；相邻两关 `side` 相反；所有木片中心离左右边缘至少 40 像素；相邻两关的中心距离至少 70 像素；`height` 大于 `spots[0].y`；`branches` 有 80 条；`trunk` 以 `M` 开头。
  - `layoutTree(1, 560)` 和 `layoutTree(200, 320)` 不抛异常，木片都在木板里面。
  - `layoutTree(80, 390)` 的木片 `x` 都在 `[40, 350]` 里。
- [ ] **Step 2: 改 `tests/app.test.ts`**：`boot()` 默认停在树上；`enter(browser, n)` 改成点树上第 n 个木片再等 3 秒；原来默认进第 1 关的用例用 `boot({ enter: 1 })`。删掉选关面板的用例，换成：
  - 打开网站先看到树：`phase === 'tree'`，`tree` 没隐藏，`tally`、`tools` 隐藏，没有托盘（`stage.board.children` 为空），停手之后一帧都没画过。
  - 新玩家：80 个木片，只有第 1 个不是 `disabled`；通过前两关的：前三个能点，第 3 个带 `open`。
  - 点 `locked` 的木片什么都不发生；点第 1 个 → `{ level: 1, phase: 'playing' }`，树隐藏，步数亮出。
  - 通过的木片上有星和"N 步"；图被改过的关（存档里指纹对不上）算通过但没有星。
  - 关里点「选关」→ 回到树，再按方向键步数不变、不报错；再点同一关 → 从 0 步开始、`stainMatchesRules`。
  - 通关后点 `#btn-result-levels` → 回到树，下一关的木片变成 `open`。
  - 中间插了一关的关卡表（设计 6.4 的例子缩小版）→ 两个 `open` 的木片都能点。
  - 只有一关的关卡表、编号全是新的关卡表、第一关是 19×15 的关卡表 → 树照常，能进关，提示牌在（Review Focus 3）。
  - 回归（原"interrupting an animation"那组，改成树）：弹珠滚到一半回树再进同一关 / 另一关；庆祝到一半回树；托盘还在滑进来就回树——之后都能正常玩到通关，`phase` 不会在树上变成 `playing`。
  - 最后一步还在滚就回树 → 存档里有这一关，树上那个木片是 `done`。
  - 乱按测试：动作里的"选关面板"换成"树"（树开着时：点一个随机木片 / 按方向键 / 什么都不做）；停手后的检查在 `phase === 'tree'` 时只查"画面停了、没有排着的帧、存档和内存一致"，其余照旧。
- [ ] **Step 3:** `npx vitest run tests/tree.test.ts tests/app.test.ts` → 失败
- [ ] **Step 4: 实现**：`tree.ts`、`index.html`、`style.css`（删 `.levels*`、`.tile*`，加 `.tree*`、`.knot*`）、`hud.ts`、`input.ts`、`app.ts`、`view.ts` 的滑入；`fake-browser.ts` 补上树用到的那一点 DOM。
- [ ] **Step 5:** 同一条命令 → 全过；`npx tsc --noEmit` 无错
- [ ] **Step 6: 截图调样子**：`npm run build && npx vite preview`，puppeteer 在 390×844（触屏）和 1440×900 各截：新玩家的树底、通过了 30 关的树中段、全通的树顶；从树进关、通关面板三个按钮、回树。自己看图，不满意就改到满意。

---

### Task 9: 全量验证、README、截图

- [ ] **Step 1:** `npm test` 全过（把结果里通过/失败的数字记下来）；`npx tsc --noEmit`；`npm run build`。
- [ ] **Step 2: 真浏览器整条线**（`vite preview` + 假接口）：配置页发布一份改过的关卡表（改第 3 关的图、在第 5 位插一关）→ 游戏页刷新 → 树上是新的关卡表，新插的关和原来轮到的关都亮着 → 进关、通关、回树；断网（把 `/api/levels` 拦掉）后刷新 → 用的是缓存那份；清掉缓存再断网 → 内置 80 关。有 v1 存档的浏览器打开 → 星和步数都在。
- [ ] **Step 3: 帧率对照**：旧版（`git worktree` 取 `HEAD`）和新版各 `vite preview`，同一关（第 51 关，1440×900@2x）交替各测 6 轮，确认新版没有变慢。
- [ ] **Step 4: 字体**：界面上有没有新出现的汉字（`tools/subset-font.mjs` 收的是 `index.html`、`src/ui/`、`app.ts`、`main.ts`、`tray.ts`；配置页不用这套字体）。有就重新生成子集。
- [ ] **Step 5: README**：玩法里的「选关」改成树；加"关卡配置"一节（`/config`、口令、发布、KV、本地开发的假接口和 `dev-token`）；目录里加新文件；"纯前端，没有任何网络请求"那句改掉；依赖一节说明 `highs` 现在只进配置页。`docs/shot-levels.jpg` 换成树的截图，另加一张配置页的截图。
- [ ] **Step 6: 请一位没看过实现的审查者把整个改动过一遍**（superpowers:requesting-code-review），按 receiving-code-review 处理它提的问题。
- [ ] **Step 7: 写一页本地的结果报告** `docs/report-2026-11-18.html`（树和配置页的截图、验证了什么、没验证什么），给用户看。

---

### Task 10: 上线（**先停下来**：给用户看报告，等用户自己设口令）

- [ ] **Step 1:** `WRANGLER_SEND_METRICS=false npx wrangler kv namespace create coloring-maze-levels`，把 id 写进 `wrangler.jsonc`（绑定名仍是 `LEVELS_KV`）。**不要**用账号里已有的那个标题叫 `LEVELS_KV` 的命名空间（id `64a9ca73…`）：那是 demon 项目的，里面是它的关卡。
- [ ] **Step 2:** 用户自己输入 `! npx wrangler secret put LEVEL_ADMIN_TOKEN`。
- [ ] **Step 3:** `npm run deploy`。
- [ ] **Step 4: 上线后核对**（`curl --noproxy '*' --ssl-no-revoke`）：`/` 和 `dist/index.html` 的 sha256 一致；`/config` 是配置页；`GET /api/levels` 404；`POST /api/levels` 带错口令 401；无头浏览器打开首页是树、能进第 1 关。用户在配置页发布一次之后 `GET` 变 200。
