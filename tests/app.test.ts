// 把真正的 App 和 GameView 放进假浏览器里跑（只有碰 WebGL 的舞台是替身），一帧一帧地推进，
// 检查规则、画面、界面、存档之间在各种操作顺序下是不是始终对得上。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Level } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import { BUILTIN, sigOf, type LevelSet } from '../src/game/levelset.ts';
import { keysOf, type Progress } from '../src/game/progress.ts';
import { isDone, steps, type Game } from '../src/game/rules.ts';
import { layoutTree } from '../src/ui/tree.ts';
import { FakeBrowser, type FakeEl } from './helpers/fake-browser.ts';
import { seeded } from './helpers/random.ts';

vi.mock('../src/view/stage.ts', () => import('./helpers/fake-stage.ts'));

const SAVE = 'coloring-maze.v2';
const OLD_SAVE = 'coloring-maze.v1';
/** "玩到第几关"存在这一项里，就是一个数字 */
const LEVEL = 'coloring-maze.level';
const K = keysOf(BUILTIN);
/** 按内置关卡的顺序给出每关的最好步数（0 = 没通过），拼成一份存档 */
const saveOf = (bests: readonly number[], muted = false): { done: Record<string, { best: number; sig: string }>; muted: boolean } => ({
  done: Object.fromEntries(bests.flatMap((best, i) => (best > 0 ? [[K[i].id, { best, sig: K[i].sig }]] : []))),
  muted,
});
/** 存档里记着的每一关的最好步数 */
const savedBests = (browser: FakeBrowser): Record<string, number> => {
  const saved = JSON.parse(browser.storage.get(SAVE)!) as { done: Record<string, { best: number }> };
  return Object.fromEntries(Object.entries(saved.done).map(([id, done]) => [id, done.best]));
};
type Dir = 'U' | 'R' | 'D' | 'L';

/** 检查时要看的那些内部状态 */
interface Inner {
  readonly view: {
    readonly board: {
      readonly tray: {
        readonly level: Level;
        readonly cell: number;
        readonly width: number;
        readonly depth: number;
        readonly stain: { isDyed(cell: number): boolean };
        cellCenter(cell: number): { x: number; z: number };
        readonly group: { readonly position: { x: number; y: number; z: number } };
      };
      readonly marble: { readonly radius: number; readonly group: { visible: boolean; readonly position: { x: number; y: number; z: number } } };
      readonly tilt: { x: number; z: number };
    };
    readonly leaving: unknown;
    readonly ball: unknown;
    readonly extras: unknown[];
    readonly timers: unknown[];
    readonly stage: {
      readonly board: { readonly children: unknown[] };
      renders: number;
      shadowRenders: number;
      readonly resizes: Array<{
        width: number;
        height: number;
        safe: { left: number; right: number; top: number; bottom: number };
        box: { halfWidth: number; halfDepth: number };
      }>;
    };
    enter(...args: unknown[]): Promise<void>;
  };
  readonly game: Game;
  readonly level: Level;
  readonly index: number;
  readonly phase: string;
  readonly queue: unknown[];
  readonly pumping: boolean;
  readonly progress: Progress;
  readonly reached: number;
  readonly sound: { rolling(speed: number): void; impact(strength: number): void };
  snapshot(): { level: number; id: string; steps: number; phase: string; guide: boolean; idle: boolean; settled: boolean; solution: string };
}

interface BootOptions {
  /** 按关记的成绩：按内置关卡的顺序，每关的最好步数（0 = 没通过） */
  readonly bests?: readonly number[];
  /** 存着的"玩到第几关"。不给的话：有 bests 的是只有老存档的人（数字由它算出来），没有 bests 的是第一次来的人 */
  readonly reached?: number;
  readonly screen?: { readonly width: number; readonly height: number };
  /** 用哪份关卡表，不给就是内置的 80 关 */
  readonly set?: LevelSet;
  /** 打开网站时地址栏里的地址，不给就是 / */
  readonly path?: string;
  /** 进第几关（从 1 数起）。不给就留在打开网站时进的那一关；null 是去选关树上待着 */
  readonly enter?: number | null;
  /** 第一次来的人先看到新手指引。默认替他一路点完；'stay' 是留着不点 */
  readonly guide?: 'stay';
  /** false：start 之后一帧也不等，托盘还没滑进来就交出去 */
  readonly settle?: false;
  /** 启动之前对假浏览器再做点手脚（比如放一份旧存档、让存储坏掉） */
  readonly before?: (browser: FakeBrowser) => void;
}

async function boot(options: BootOptions = {}): Promise<{ browser: FakeBrowser; app: Inner }> {
  const browser = new FakeBrowser();
  if (options.screen) Object.assign(browser, options.screen);
  if (options.path) browser.entries[0] = options.path;
  browser.install();
  if (options.bests) browser.storage.set(SAVE, JSON.stringify(saveOf(options.bests)));
  if (options.reached !== undefined) browser.storage.set(LEVEL, String(options.reached));
  options.before?.(browser);
  const { App } = await import('../src/app.ts');
  const made = new App(browser.el('stage') as never, 'serif');
  const app = made as unknown as Inner;
  made.start(options.set ?? BUILTIN);
  if (options.guide !== 'stay') await skipGuide(browser);
  if (options.settle === false) return { browser, app };
  await browser.seconds(3);
  if (options.enter === null) await browser.click('btn-levels');
  else if (options.enter !== undefined && options.enter !== app.index + 1) await enter(browser, options.enter);
  return { browser, app };
}

/** 新手指引亮着的话，一路点到它收起来 */
async function skipGuide(browser: FakeBrowser): Promise<void> {
  for (let i = 0; i < 6 && !browser.el('guide').hidden; i++) await browser.click('btn-guide-next');
}

/** 树上第 n 关（从 1 数起）的叶片 */
const knot = (browser: FakeBrowser, n: number): FakeEl => browser.knots()[n - 1];
/** 叶片是哪一种：done（通过了）、open（轮到了）、free（没轮到，但全部关卡开放着）、locked（没轮到） */
const kind = (el: FakeEl): string => el.className.replace('knot', '').trim();
/** 叶片上刻的序号 */
const numberOn = (el: FakeEl): string => el.children.find((kid) => kid.className === 'knot-num')!.textContent;
/** 叶片下面刻的字：几颗星、多少步；没刻就是 null */
function noteOf(el: FakeEl): { stars: number; text: string } | null {
  const note = el.children.find((kid) => kid.className === 'knot-note');
  if (!note) return null;
  const [stars, small] = note.children;
  return { stars: stars.children.filter((star) => star.className.includes('won')).length, text: small.textContent };
}
/** 树滚到第 n 关（从 1 数起）在屏幕中间时，滚动条在哪 */
const scrolledTo = (n: number, count = 80, width = 390, height = 844): number => Math.max(0, layoutTree(count, width).spots[n - 1].y - height / 2);

/** 从树上进第 n 关（从 1 数起），等它摆好。正在关里的话先回到树上 */
async function enter(browser: FakeBrowser, n: number): Promise<void> {
  if (browser.el('tree').hidden) await browser.click(browser.el('result').hidden ? 'btn-levels' : 'btn-result-levels');
  await browser.click(knot(browser, n));
  await browser.seconds(3);
}

/** 照着一串方向走，每一步都等弹珠停稳 */
async function play(browser: FakeBrowser, moves: string): Promise<void> {
  for (const ch of moves) {
    await browser.key(ch as Dir);
    await browser.seconds(0.8);
  }
}

/** 画面上染着色的格子，是不是正好就是规则里染了的那些 */
function stainMatchesRules(app: Inner): boolean {
  const { tray } = app.view.board;
  for (let cell = 0; cell < app.level.floor.length; cell++) {
    if (app.level.floor[cell] && tray.stain.isDyed(cell) !== (app.game.dyed[cell] === 1)) return false;
  }
  return true;
}

/** 弹珠离它该在的那一格的正中有多远（以格为单位） */
function marbleOffCentre(app: Inner): number {
  const { tray, marble } = app.view.board;
  const want = tray.cellCenter(app.game.pos);
  return Math.hypot(marble.group.position.x - want.x, marble.group.position.z - want.z) / tray.cell;
}

const wonStars = (browser: FakeBrowser, id: string): number => browser.el(id).children.filter((s) => s.className.includes('won')).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'innerWidth');
  Reflect.deleteProperty(globalThis, 'innerHeight');
});

describe('playing a level', () => {
  it('starts on the first level with the marble on its start and nothing else dyed', async () => {
    const { app, browser } = await boot();
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing' });
    expect(browser.el('steps').textContent).toBe('0');
    expect(browser.el('par').textContent).toBe('最少 3 步');
    expect(browser.el('tally').hidden).toBe(false);
    expect(stainMatchesRules(app)).toBe(true);
    expect(marbleOffCentre(app)).toBeLessThan(1e-9);
  });

  it('finishes when the last cell is dyed, shows the result and saves it', async () => {
    const { app, browser } = await boot();
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 3, phase: 'done' });
    expect(browser.el('result').hidden).toBe(false);
    expect(browser.el('tools').hidden).toBe(true);
    expect(browser.el('result-title').textContent).toBe('3 步通关');
    expect(browser.el('result-detail').textContent).toBe('最少 3 步');
    expect(wonStars(browser, 'result-stars')).toBe(3);
    expect(savedBests(browser).b01).toBe(3);
  });

  it('moves with a swipe as well as with the arrow keys', async () => {
    const { app, browser } = await boot();
    await browser.swipe('U');
    await browser.seconds(1);
    expect(app.snapshot().steps).toBe(1);
    expect(app.game.pos).toBe(4);
  });

  it('does not count a push straight into a wall', async () => {
    const { app, browser } = await boot();
    await browser.key('D');
    await browser.seconds(1);
    expect(app.snapshot().steps).toBe(0);
    expect(browser.el('steps').textContent).toBe('0');
    expect(marbleOffCentre(app)).toBeLessThan(1e-6);
  });

  it('remembers up to two more moves while the marble is still rolling, and drops the rest', async () => {
    // 第 2 关的走法是 上左下左上。一口气按四下：第一下马上走，后两下排队，第四下不收
    const { app, browser } = await boot({ bests: [3] });
    await browser.key('U');
    await browser.key('L');
    await browser.key('D');
    await browser.key('L');
    await browser.seconds(4);
    expect(app.snapshot().steps).toBe(3);
    expect(stainMatchesRules(app)).toBe(true);
  });

  it('gives fewer stars for more steps and keeps the best result', async () => {
    const { browser } = await boot({ bests: [3], enter: 1 });
    // 多绕两步再通关：上、下（滚回起点）、上、左、下，共 5 步
    await play(browser, 'UDULD');
    await browser.seconds(2);
    expect(browser.el('result-title').textContent).toBe('5 步通关');
    expect(browser.el('result-detail').textContent).toBe('最少 3 步，最好 3 步');
    expect(wonStars(browser, 'result-stars')).toBe(2);
    expect(savedBests(browser).b01).toBe(3);
  });
});

describe('saving', () => {
  it('keeps what another tab saved in the meantime', async () => {
    const { browser } = await boot();
    // 另一个标签页里通过了第 1、2 关，存了档
    browser.storage.set(SAVE, JSON.stringify(saveOf([4, 6])));
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(savedBests(browser)).toEqual({ b01: 3, b02: 6 });
  });

  it('reads a save from before levels could be configured, and writes the new one next to it', async () => {
    const old = JSON.stringify({ best: [3, 5], last: 1, muted: true });
    const { app, browser } = await boot({ before: (b) => b.storage.set(OLD_SAVE, old) });
    // 通过了前两关的人，轮到第 3 关；声音是关着的
    expect(app.snapshot()).toMatchObject({ level: 3, id: 'b03' });
    expect(browser.el('btn-sound').getAttribute('aria-pressed')).toBe('false');
    await play(browser, LEVELS[2].solution);
    await browser.seconds(2);
    expect(savedBests(browser)).toEqual({ b01: 3, b02: 5, b03: LEVELS[2].par });
    expect(JSON.parse(browser.storage.get(SAVE)!).muted).toBe(true);
    expect(browser.storage.get(OLD_SAVE)).toBe(old);
  });

  it('still starts and can be played to the end when the browser refuses to store anything', async () => {
    const refuse = (): never => {
      throw new Error('storage is off');
    };
    const { app, browser } = await boot({ before: () => vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse }) });
    expect(app.snapshot()).toMatchObject({ level: 1, phase: 'playing' });
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
    expect(browser.el('result').hidden).toBe(false);
    await browser.click('btn-sound');
    expect(browser.el('btn-sound').getAttribute('aria-pressed')).toBe('false');
  });

  it('remembers that the sound was switched off', async () => {
    const { browser } = await boot();
    expect(browser.el('btn-sound').getAttribute('aria-pressed')).toBe('true');
    await browser.click('btn-sound');
    expect(browser.el('btn-sound').getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(browser.storage.get(SAVE)!).muted).toBe(true);
  });
});

describe('a level set other than the built-in one', () => {
  const custom: LevelSet = {
    version: 1,
    levels: [{ ...BUILTIN.levels[2], id: 'x1', dye: '#123456' }, BUILTIN.levels[0]],
  };

  it('is played level by level, each in its own dye, and saved under the ids of its levels', async () => {
    const { GameView } = await import('../src/view/view.ts');
    const entered = vi.spyOn(GameView.prototype, 'enter');
    const { app, browser } = await boot({ set: custom });
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'x1', phase: 'playing' });
    expect(browser.el('par').textContent).toBe('最少 6 步');
    expect(entered.mock.calls[0][2]).toBe(0x123456);
    expect(browser.document.documentElement.style.props['--dye']).toBe('#123456');
    await play(browser, custom.levels[0].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
    expect(JSON.parse(browser.storage.get(SAVE)!).done).toEqual({ x1: { best: 6, sig: sigOf(custom.levels[0].rows) } });
    await browser.click('btn-next');
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 2, id: 'b01', phase: 'playing' });
    expect(entered.mock.calls[1][2]).toBe(0x2646b8);
    expect(browser.document.documentElement.style.props['--dye']).toBe('#2646b8');
    // 一共只有两关：第 2 关后面没有"下一关"
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(browser.el('result').hidden).toBe(false);
    expect(browser.el('btn-next').hidden).toBe(true);
  });

  it('lets someone whose older save has its last level play the levels before it too, though one of them is new', async () => {
    // 老存档里通过了 b01，它在这份关卡表里排第 2（也是最后一关）：算下来是全通了，打开停在最后一关，前面那关也能玩
    const { app, browser } = await boot({ set: custom, bests: [3, 5, 6, 7] });
    expect(app.snapshot()).toMatchObject({ level: 2, id: 'b01' });
    await browser.click('btn-levels');
    expect(browser.knots().map((el) => !el.disabled)).toEqual([true, true]);
    await enter(browser, 1);
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'x1', phase: 'playing' });
  });
});

describe('undo and restart', () => {
  it('undo takes back one step and cleans the cells that step dyed', async () => {
    const { app, browser } = await boot();
    await play(browser, 'UL');
    await browser.click('btn-undo');
    await browser.seconds(2);
    expect(app.snapshot().steps).toBe(1);
    expect(app.game.pos).toBe(4);
    expect(browser.el('steps').textContent).toBe('1');
    expect(stainMatchesRules(app)).toBe(true);
    expect(marbleOffCentre(app)).toBeLessThan(1e-6);
  });

  it('restart goes back to the beginning of the level', async () => {
    const { app, browser } = await boot();
    await play(browser, 'UL');
    await browser.click('btn-restart');
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ steps: 0, phase: 'playing' });
    expect(app.game.pos).toBe(app.level.start);
    expect(stainMatchesRules(app)).toBe(true);
    expect(marbleOffCentre(app)).toBeLessThan(1e-6);
    expect(browser.el('btn-undo').disabled).toBe(true);
  });

  it('has nothing to undo or restart before the first step', async () => {
    const { browser } = await boot();
    expect(browser.el('btn-undo').disabled).toBe(true);
    expect(browser.el('btn-restart').disabled).toBe(true);
  });
});

describe('moving between levels', () => {
  it('goes on to the next level from the result', async () => {
    const { app, browser } = await boot();
    await play(browser, 'ULD');
    await browser.seconds(2);
    await browser.click('btn-next');
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing' });
    expect(browser.el('result').hidden).toBe(true);
    expect(browser.el('par').textContent).toBe('最少 5 步');
    expect(app.view.stage.board.children).toHaveLength(1);
    expect(app.view.board.tray.level).toBe(app.level);
  });

  it('has no "next level" after the last one', async () => {
    const all = new Array<number>(LEVELS.length).fill(99);
    const { browser } = await boot({ bests: all });
    await play(browser, LEVELS[LEVELS.length - 1].solution);
    await browser.seconds(2);
    expect(browser.el('result').hidden).toBe(false);
    expect(browser.el('btn-next').hidden).toBe(true);
  });
});

describe('the tree of levels, behind the "levels" button', () => {
  it('is not what the game opens on: it comes up when "levels" is pressed', async () => {
    const { app, browser } = await boot();
    expect(browser.el('tree').hidden).toBe(true);
    expect(app.snapshot().phase).toBe('playing');
    await browser.click('btn-levels');
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'b01', phase: 'tree' });
    expect(browser.el('tree').hidden).toBe(false);
    expect(browser.el('tally').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(true);
  });

  it('has a leaf for every level, and a new player can press only the first', async () => {
    const { browser } = await boot({ enter: null });
    const knots = browser.knots();
    expect(knots).toHaveLength(80);
    expect(knots.map((el) => el.getAttribute('data-level'))).toEqual(Array.from({ length: 80 }, (_, i) => String(i + 1)));
    expect(kind(knots[0])).toBe('open');
    expect(knots[0].disabled).toBe(false);
    expect(knots.slice(1).every((el) => kind(el) === 'locked' && el.disabled)).toBe(true);
    expect(numberOn(knots[0])).toBe('1');
    expect(numberOn(knots[79])).toBe('80');
  });

  it('grows the leaves on alternating sides of the trunk, tips up, each with its shadow under it', async () => {
    const { browser } = await boot({ enter: null });
    const knots = browser.knots();
    knots.slice(0, 6).forEach((el, i) => {
      // 叶片本来是叶尖朝右画的：单数关长在左边，先左右翻过来；转的方向也跟着反过来
      expect(el.style.props['--flip'], `第 ${i + 1} 关`).toBe(i % 2 === 0 ? '-1' : undefined);
      const turn = parseFloat(el.style.props['--turn']);
      expect(el.style.props['--turn'], `第 ${i + 1} 关`).toMatch(/^-?[0-9.]+deg$/);
      expect(Math.sign(turn), `第 ${i + 1} 关`).toBe(i % 2 === 0 ? 1 : -1);
      expect(Math.abs(turn), `第 ${i + 1} 关`).toBeGreaterThan(12);
      expect(Math.abs(turn), `第 ${i + 1} 关`).toBeLessThan(27);
      expect(el.children.slice(0, 3).map((kid) => kid.className), `第 ${i + 1} 关`).toEqual(['knot-shade', 'knot-leaf', 'knot-num']);
    });
    // 木板上记着叶片多大、什么形状
    const board = browser.el('tree-board');
    expect(board.style.props['--ll']).toBe('80px');
    expect(board.style.props['--lh']).toBe('26px');
    expect(board.style.props['--leaf-clip'].startsWith("path('M0 26C")).toBe(true);
    expect(board.style.props['--leaf-clip'].endsWith("Z')")).toBe(true);
    expect(board.style.props['--leaf-veins'].startsWith('url("data:image/svg+xml,%3Csvg')).toBe(true);
  });

  it('dyes the leaf of a level that was passed, and letters it pale or dark to suit the dye', async () => {
    // 第 1 关的染料是靛蓝（深），第 4 关是藤黄（浅）
    const { browser } = await boot({ bests: [3, 5, 6, 7], enter: null });
    expect(knot(browser, 1).style.props['--tint']).toBe('#516bc6');
    expect(knot(browser, 1).getAttribute('data-ink')).toBe('light');
    expect(knot(browser, 4).style.props['--tint']).toBe('#e4a540');
    expect(knot(browser, 4).getAttribute('data-ink')).toBe('dark');
    // 轮到的、没轮到的不染
    for (const n of [5, 6]) {
      expect(knot(browser, n).style.props['--tint'], `第 ${n} 关`).toBeUndefined();
      expect(knot(browser, n).getAttribute('data-ink'), `第 ${n} 关`).toBeNull();
    }
  });

  it('lets someone who passed two levels press those two and the one after', async () => {
    const { browser } = await boot({ bests: [3, 5], enter: null });
    const knots = browser.knots();
    expect(knots.slice(0, 4).map(kind)).toEqual(['done', 'done', 'open', 'locked']);
    expect(knots.filter((el) => !el.disabled)).toHaveLength(3);
  });

  it('writes the stars and the best number of steps beside a level that was passed', async () => {
    // 第 1 关最少 3 步，第 2 关 5 步，第 3 关 6 步
    const { browser } = await boot({ bests: [3, 6, 9], enter: null });
    expect(noteOf(knot(browser, 1))).toEqual({ stars: 3, text: '3 步' });
    expect(noteOf(knot(browser, 2))).toEqual({ stars: 2, text: '6 步' });
    expect(noteOf(knot(browser, 3))).toEqual({ stars: 1, text: '9 步' });
    expect(noteOf(knot(browser, 4))).toBeNull();
    expect(knot(browser, 1).getAttribute('aria-label')).toBe('第 1 关，最好 3 步，3 颗星');
    expect(knot(browser, 4).getAttribute('aria-label')).toBe('第 4 关');
  });

  it('counts a level as passed after its map was changed, but shows no stars until it is played again', async () => {
    const save = saveOf([3, 5]);
    save.done.b01 = { best: 3, sig: 'an older map' };
    const { browser } = await boot({ enter: null, before: (b) => b.storage.set(SAVE, JSON.stringify(save)) });
    expect(browser.knots().slice(0, 3).map(kind)).toEqual(['done', 'done', 'open']);
    expect(noteOf(knot(browser, 1))).toBeNull();
    expect(noteOf(knot(browser, 2))).toEqual({ stars: 3, text: '5 步' });
  });

  it('opens with the furthest level whose turn it is in the middle of the screen', async () => {
    const { browser } = await boot({ bests: new Array<number>(30).fill(99), enter: null });
    expect(browser.el('tree').scrollTop).toBe(scrolledTo(31));
    expect(browser.el('tree').scrollTop).toBeGreaterThan(1000);
    // 焦点放在那片叶片上：这样方向键、翻页键才滚得动这棵树，回车就能进去
    expect(browser.document.activeElement).toBe(knot(browser, 31));
    // 但还没按过键的时候不给它画键盘焦点的那一圈——会被看成"轮到了"。按过任何一个键之后才画
    expect(browser.el('tree').className).toContain('unkeyed');
    await browser.key('U');
    expect(browser.el('tree').className).not.toContain('unkeyed');
  });

  it('opens at the very top for someone who has passed everything', async () => {
    const { browser } = await boot({ bests: new Array<number>(80).fill(99), enter: null });
    expect(browser.el('tree').scrollTop).toBe(0);
  });

  it('goes into a level when its leaf is pressed', async () => {
    const { app, browser } = await boot({ enter: null });
    await browser.click(knot(browser, 1));
    expect(browser.el('tree').hidden).toBe(true);
    expect(browser.el('tally').hidden).toBe(false);
    expect(browser.el('tools').hidden).toBe(false);
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'b01', phase: 'entering' });
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing' });
    expect(stainMatchesRules(app)).toBe(true);
    expect(marbleOffCentre(app)).toBeLessThan(1e-9);
  });

  it('does not let a level be entered whose turn has not come, however it is pressed', async () => {
    const { app, browser } = await boot({ enter: null });
    const locked = knot(browser, 6);
    expect(await browser.click(locked)).toBe(false);
    // 就算绕过了按钮的禁用（比如用脚本直接触发点击），也进不去
    for (const fn of locked.listeners.click ?? []) fn({ target: locked } as never);
    await browser.seconds(1);
    expect(app.snapshot()).toMatchObject({ level: 1, phase: 'tree' });
    expect(browser.el('tree').hidden).toBe(false);
    expect(browser.path).toBe('/1');
  });

  it('comes back from a level when "levels" is pressed, dropping the game that was going on', async () => {
    const { app, browser } = await boot();
    await play(browser, 'UL');
    await browser.click('btn-levels');
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('tree').hidden).toBe(false);
    expect(browser.el('tally').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(true);
    // 树停在刚才那一关
    expect(browser.el('tree').scrollTop).toBe(scrolledTo(1));
    expect(browser.document.activeElement).toBe(knot(browser, 1));
    // 没通关，什么都没存
    expect(browser.storage.has(SAVE)).toBe(false);
    await enter(browser, 1);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing' });
    expect(browser.el('steps').textContent).toBe('0');
    expect(stainMatchesRules(app)).toBe(true);
    expect(app.view.stage.board.children).toHaveLength(1);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('leaves the arrow keys to the browser while the tree is showing, so that they scroll it', async () => {
    const { app, browser } = await boot();
    // 关里：方向键归游戏
    expect(await browser.key('U')).toBe(true);
    await browser.seconds(1);
    await browser.click('btn-levels');
    // 树上：不拦，也不走棋
    expect(await browser.key('L')).toBe(false);
    await browser.seconds(1);
    expect(app.snapshot()).toMatchObject({ steps: 1, phase: 'tree' });
  });

  it('shows the level after the one just passed as next in turn when the player comes back from the result', async () => {
    const { app, browser } = await boot();
    await play(browser, 'ULD');
    await browser.seconds(2);
    await browser.click('btn-result-levels');
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('result').hidden).toBe(true);
    expect(browser.knots().slice(0, 3).map(kind)).toEqual(['done', 'open', 'locked']);
    expect(noteOf(knot(browser, 1))).toEqual({ stars: 3, text: '3 步' });
    await enter(browser, 2);
    expect(app.snapshot()).toMatchObject({ level: 2, phase: 'playing' });
    expect(browser.el('guide').hidden).toBe(true);
  });

  it('keeps the place of someone with an older save when a level was put into the middle of the set', async () => {
    // 老存档里通过了 b01、b02 的人；b01 后面插进一关 x1。他通过的关里最靠后的 b02 现在排第 3，所以玩到第 4 关
    const set: LevelSet = { version: 1, levels: [BUILTIN.levels[0], { ...BUILTIN.levels[3], id: 'x1' }, BUILTIN.levels[1], BUILTIN.levels[2]] };
    const { app, browser } = await boot({ set, bests: [3, 5] });
    expect(app.snapshot()).toMatchObject({ level: 4, id: 'b03', phase: 'playing' });
    await browser.click('btn-levels');
    expect(browser.knots().map(kind)).toEqual(['done', 'done', 'done', 'open']);
    expect(browser.el('tree').scrollTop).toBe(scrolledTo(4, 4));
    // 新插进来的那一关他没玩过：没有星星，但进得去
    expect(noteOf(knot(browser, 1))).toEqual({ stars: 3, text: '3 步' });
    expect(noteOf(knot(browser, 2))).toBeNull();
    await enter(browser, 2);
    expect(app.snapshot()).toMatchObject({ level: 2, id: 'x1', phase: 'playing' });
  });

  it.each<readonly [string, LevelSet]>([
    ['only one level', { version: 1, levels: [{ ...BUILTIN.levels[4], id: 'solo' }] }],
    ['only levels the save has never seen', { version: 1, levels: [{ ...BUILTIN.levels[9], id: 'n1' }, { ...BUILTIN.levels[10], id: 'n2' }] }],
    ['fewer levels than the save has records', { version: 1, levels: [BUILTIN.levels[2], { ...BUILTIN.levels[5], id: 'n3' }] }],
  ])('works with a set that has %s', async (_name, set) => {
    const { app, browser } = await boot({ set, bests: [3, 5, 6, 7, 8], enter: null });
    expect(browser.knots()).toHaveLength(set.levels.length);
    const turn = browser.knots().map(kind).indexOf('open') + 1;
    expect(turn).toBeGreaterThan(0);
    await enter(browser, turn);
    expect(app.snapshot()).toMatchObject({ level: turn, id: set.levels[turn - 1].id, phase: 'playing' });
    await play(browser, app.snapshot().solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
    expect(browser.el('btn-next').hidden).toBe(turn === set.levels.length);
  });

  it('lays the tree out again when the window changes size, and leaves the 3D picture alone', async () => {
    const { app, browser } = await boot({ enter: null });
    // 树盖着的时候，底下那一关的画面等动画演完就不再动了
    await browser.seconds(9);
    const { resizes, renders } = { resizes: app.view.stage.resizes.length, renders: app.view.stage.renders };
    const board = browser.el('tree-board');
    expect(board.style.width).toBe('390px');
    browser.resize(1280, 720);
    expect(board.style.width).toBe('560px');
    expect(browser.knots()).toHaveLength(80);
    expect(browser.el('tree').scrollTop).toBe(scrolledTo(1, 80, 560, 720));
    await browser.seconds(1);
    expect(app.view.stage.resizes).toHaveLength(resizes);
    expect(app.view.stage.renders).toBe(renders);
    expect(browser.queued).toHaveLength(0);
  });

  it('stays where the player scrolled to when only the height of the window changes', async () => {
    // 手机浏览器的地址栏一收一放，窗口的高度就变一次：这时不能把树拽回原来那一关
    const { browser } = await boot({ bests: new Array<number>(30).fill(99), enter: null });
    browser.el('tree').scrollTop = 1234;
    browser.resize(390, 780);
    expect(browser.el('tree').scrollTop).toBe(1234);
    browser.resize(390, 844);
    expect(browser.el('tree').scrollTop).toBe(1234);
  });

  it('frames the tray for the window as it is now when a level is entered after the window changed on the tree', async () => {
    const { app, browser } = await boot();
    await browser.click('btn-levels');
    browser.resize(1280, 720);
    await enter(browser, 1);
    expect(app.view.stage.resizes.at(-1)).toMatchObject({ width: 1280, height: 720 });
  });
});

describe('leaving for the tree in the middle of things', () => {
  it('stays playable when the same level is entered again while the marble is still rolling', async () => {
    // 回归：这样做之后曾经再也操作不了
    const { app, browser } = await boot({ bests: [3, 5, 6], enter: 1 });
    await browser.key('U');
    await enter(browser, 1);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing', idle: true });
    expect(stainMatchesRules(app)).toBe(true);
    expect(app.view.stage.board.children).toHaveLength(1);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('stays playable when another level is entered while the marble is still rolling', async () => {
    const { app, browser } = await boot({ bests: [3, 5, 6], enter: 1 });
    await browser.key('U');
    await enter(browser, 2);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing', idle: true });
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('shows no result and stays on the tree when the player leaves during the celebration', async () => {
    const { app, browser } = await boot({ bests: [3, 5, 6], enter: 1 });
    await play(browser, 'UL');
    await browser.key('D');
    await browser.seconds(0.6);
    expect(app.snapshot().phase).toBe('done');
    await browser.click('btn-levels');
    await browser.seconds(4);
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('result').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(true);
    await enter(browser, 2);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing', idle: true });
    expect(browser.el('result').hidden).toBe(true);
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('stops drawing the 3D picture the moment the tree comes up, and still plays the roll out underneath', async () => {
    const { app, browser } = await boot();
    const stage = app.view.stage;
    await browser.key('U');
    await browser.frame();
    await browser.frame();
    await browser.click('btn-levels');
    const drawn = stage.renders;
    // 弹珠还没滚到头：动画在树底下接着演（规则那边等着它），但一帧也不画
    expect(app.view.ball).not.toBeNull();
    await browser.seconds(1.5);
    expect(stage.renders).toBe(drawn);
    expect(app.view.ball).toBeNull();
    expect(stainMatchesRules(app)).toBe(true);
    expect(marbleOffCentre(app)).toBeLessThan(1e-6);
    // 演完就停，不像在关里那样再多画几秒等染料变干
    expect(browser.queued).toHaveLength(0);
    await enter(browser, 1);
    expect(stage.renders).toBeGreaterThan(drawn);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing' });
  });

  it('does not keep measuring the frame rate while the tree covers the picture', async () => {
    const { app, browser } = await boot();
    await browser.seconds(1);
    const sizes = app.view.stage.resizes.length;
    await browser.key('U');
    await browser.click('btn-levels');
    // 树亮着的时候来了一串很慢的帧（滚动木板时会这样）：不能因此把游戏画面的清晰度降下去
    for (let i = 0; i < 90; i++) await browser.frame(120);
    expect(app.view.stage.resizes).toHaveLength(sizes);
  });

  it('makes no sound from under the tree', async () => {
    const { app, browser } = await boot();
    const impact = vi.spyOn(app.sound, 'impact');
    const rolling = vi.spyOn(app.sound, 'rolling');
    await browser.key('U');
    await browser.frame();
    await browser.click('btn-levels');
    impact.mockClear();
    rolling.mockClear();
    // 弹珠在树底下滚到头、撞了墙：听不到
    await browser.seconds(2);
    expect(impact).not.toHaveBeenCalled();
    expect(rolling.mock.calls.every(([speed]) => speed === 0)).toBe(true);
  });

  it('counts the win, and shows its stars on the tree, when the player leaves while the last roll is still going', async () => {
    const { app, browser } = await boot();
    await play(browser, 'UL');
    await browser.key('D');
    await browser.click('btn-levels');
    expect(app.snapshot().phase).toBe('tree');
    expect(noteOf(knot(browser, 1))).toEqual({ stars: 3, text: '3 步' });
    expect(kind(knot(browser, 2))).toBe('open');
    expect(savedBests(browser)).toEqual({ b01: 3 });
    // 已经回了树：通关面板和庆祝都不再冒出来
    await browser.seconds(4);
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('result').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(true);
  });

  it('counts the win even when the player is already in another level before the last roll has ended', async () => {
    const { app, browser } = await boot({ bests: [9, 9], enter: 1 });
    await play(browser, 'UL');
    await browser.key('D');
    await browser.click('btn-levels');
    await browser.click(knot(browser, 2));
    await browser.seconds(4);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing', idle: true });
    expect(savedBests(browser).b01).toBe(3);
    expect(browser.el('result').hidden).toBe(true);
    expect(stainMatchesRules(app)).toBe(true);
  });

  it('goes back to the tree as soon as the tray has arrived when "levels" was pressed while it was still sliding in', async () => {
    const { app, browser } = await boot({ enter: null });
    await browser.click(knot(browser, 1));
    await browser.seconds(0.3);
    await browser.click('btn-levels');
    // 托盘还在滑：先不动（两次换托盘不能叠在一起），但这一下记着
    expect(app.snapshot().phase).toBe('entering');
    expect(browser.el('tree').hidden).toBe(true);
    await browser.seconds(3);
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('tree').hidden).toBe(false);
    expect(browser.el('tools').hidden).toBe(true);
    expect(app.view.leaving).toBeNull();
    // 再进去照常能玩，而且不会因为上次记着的那一下又被送回树上
    await enter(browser, 1);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing' });
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('does the same when "levels" is pressed while the marble is hopping back for "again"', async () => {
    const { app, browser } = await boot();
    await play(browser, 'ULD');
    await browser.seconds(2);
    await browser.click('btn-again');
    expect(app.snapshot().phase).toBe('entering');
    await browser.click('btn-levels');
    expect(app.snapshot().phase).toBe('entering');
    await browser.seconds(3);
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('result').hidden).toBe(true);
  });
});

describe('the picture', () => {
  it('leaves the marble in the middle of its cell after the celebration', async () => {
    const { app, browser } = await boot();
    await play(browser, 'ULD');
    await browser.seconds(3);
    expect(marbleOffCentre(app)).toBeLessThan(1e-6);
    expect(app.view.board.marble.group.position.y).toBeCloseTo(app.view.board.marble.radius, 9);
  });

  it('draws each frame only once, however often the level is restarted or finished', async () => {
    // 回归：每次"重玩"或通关都会多出一条永不停下的画面回调，越玩每帧画得越多
    const { browser } = await boot();
    for (let i = 0; i < 4; i++) {
      await browser.key('U');
      await browser.seconds(1);
      await browser.click('btn-restart');
      await browser.seconds(1.5);
    }
    await play(browser, 'ULD');
    await browser.seconds(1);
    expect(Math.max(...browser.perFrame.slice(-40))).toBe(1);
  });

  it('stops drawing once nothing has moved for a while, and starts again on the next move', async () => {
    const { app, browser } = await boot();
    await browser.seconds(8);
    expect(browser.queued).toHaveLength(0);
    const before = app.view.stage.renders;
    await browser.seconds(2);
    expect(app.view.stage.renders).toBe(before);
    await browser.key('U');
    await browser.seconds(0.5);
    expect(app.view.stage.renders).toBeGreaterThan(before);
  });

  it('redraws the shadows only on frames where the tray moved', async () => {
    const { app, browser } = await boot();
    await browser.seconds(1);
    const stage = app.view.stage;
    const before = { renders: stage.renders, shadows: stage.shadowRenders };
    // 朝墙推一下：弹珠磕一下，托盘不动
    await browser.key('D');
    await browser.seconds(1);
    expect(stage.renders).toBeGreaterThan(before.renders);
    expect(stage.shadowRenders).toBe(before.shadows);
    // 真的滚起来：托盘会倾斜、被撞得一晃
    await browser.key('U');
    await browser.seconds(1);
    expect(stage.shadowRenders).toBeGreaterThan(before.shadows);
  });

  it('frames the tray again when the window changes size', async () => {
    const { app, browser } = await boot();
    const stage = app.view.stage;
    browser.resize(844, 390);
    await browser.frame();
    expect(stage.resizes.at(-1)).toMatchObject({ width: 844, height: 390 });
  });

  it('tells the sound that the marble stopped when the tab is hidden in the middle of a roll', async () => {
    const { app, browser } = await boot();
    const rolling = vi.spyOn(app.sound, 'rolling');
    await browser.key('U');
    await browser.frame();
    await browser.frame();
    expect(rolling.mock.lastCall?.[0]).toBeGreaterThan(0);
    browser.setHidden(true);
    expect(rolling.mock.lastCall?.[0]).toBe(0);
  });
});

describe('the address of the page', () => {
  it('opens the level in turn when the site is opened at its root, and writes that level into the address', async () => {
    const { app, browser } = await boot({ reached: 12 });
    expect(app.snapshot()).toMatchObject({ level: 12, id: 'b12', steps: 0, phase: 'playing', guide: false });
    expect(browser.el('tree').hidden).toBe(true);
    expect(browser.el('tally').hidden).toBe(false);
    expect(stainMatchesRules(app)).toBe(true);
    // 是把原来的地址换掉，不是往历史里添一项：这时按后退是离开网站，而不是回到 /
    expect(browser.entries).toEqual(['/12']);
  });

  it('has the first tray slide in from the side rather than just be there', async () => {
    const { app, browser } = await boot({ reached: 1, settle: false });
    expect(app.snapshot().phase).toBe('entering');
    await browser.frame();
    await browser.frame();
    expect(app.view.board.tray.group.position.x).toBeGreaterThan(20);
    await browser.seconds(3);
    expect(app.view.board.tray.group.position.x).toBe(0);
    expect(app.view.leaving).toBeNull();
    expect(app.snapshot().phase).toBe('playing');
  });

  it('opens the level in the address when the player has got that far', async () => {
    const earlier = await boot({ reached: 12, path: '/5' });
    expect(earlier.app.snapshot()).toMatchObject({ level: 5, id: 'b05', phase: 'playing' });
    expect(earlier.browser.entries).toEqual(['/5']);
    const inTurn = await boot({ reached: 12, path: '/12' });
    expect(inTurn.app.snapshot()).toMatchObject({ level: 12, phase: 'playing' });
    expect(inTurn.browser.entries).toEqual(['/12']);
  });

  it.each(['/13', '/80', '/200'])('goes to the level in turn instead when the address is %s, which the player has not reached', async (path) => {
    const { app, browser } = await boot({ reached: 12, path });
    expect(app.snapshot()).toMatchObject({ level: 12, id: 'b12', phase: 'playing' });
    expect(browser.entries).toEqual(['/12']);
  });

  it.each(['/abc', '/0', '/12/3', '/index.html'])('goes to the level in turn when the address is %s, which is no level', async (path) => {
    const { app, browser } = await boot({ reached: 12, path });
    expect(app.snapshot()).toMatchObject({ level: 12, phase: 'playing' });
    expect(browser.entries).toEqual(['/12']);
  });

  it('writes an address that means a level the usual way', async () => {
    const { app, browser } = await boot({ reached: 12, path: '/05/' });
    expect(app.snapshot()).toMatchObject({ level: 5, phase: 'playing' });
    expect(browser.entries).toEqual(['/5']);
  });

  it('opens on the last level for someone who has passed them all', async () => {
    const { app, browser } = await boot({ reached: 81 });
    expect(app.snapshot()).toMatchObject({ level: 80, id: 'b80', phase: 'playing' });
    expect(browser.entries).toEqual(['/80']);
  });

  it('follows the player on to the next level, as a new entry in the history', async () => {
    const { app, browser } = await boot({ reached: 1 });
    await play(browser, 'ULD');
    await browser.seconds(2);
    // 通关面板亮着的时候还在这一关
    expect(browser.entries).toEqual(['/1']);
    await browser.click('btn-next');
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 2, phase: 'playing' });
    expect(browser.entries).toEqual(['/1', '/2']);
    expect(browser.path).toBe('/2');
  });

  it('keeps the address of the level the player came from while the tree is showing, and changes it when another level is picked', async () => {
    const { browser } = await boot({ reached: 6, path: '/4' });
    await browser.click('btn-levels');
    expect(browser.entries).toEqual(['/4']);
    await enter(browser, 2);
    expect(browser.entries).toEqual(['/4', '/2']);
    // 回到树上又进了同一关：地址没变，历史里不多一项
    await enter(browser, 2);
    expect(browser.entries).toEqual(['/4', '/2']);
    // "再来一次"也不动地址
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    await browser.click('btn-again');
    await browser.seconds(3);
    expect(browser.entries).toEqual(['/4', '/2']);
  });

  it('goes back and forth with the buttons of the browser', async () => {
    const { app, browser } = await boot({ reached: 6, path: '/4' });
    await enter(browser, 2);
    expect(await browser.travel(-1)).toBe(true);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 4, id: 'b04', steps: 0, phase: 'playing', idle: true });
    expect(browser.entries).toEqual(['/4', '/2']);
    expect(browser.path).toBe('/4');
    expect(app.view.stage.board.children).toHaveLength(1);
    expect(app.view.board.tray.level).toBe(app.level);
    await browser.travel(1);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing' });
    // 回来的这一关照常能玩到底
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('goes back from the tree into the level before', async () => {
    const { app, browser } = await boot({ reached: 6, path: '/4' });
    await enter(browser, 2);
    await browser.click('btn-levels');
    expect(app.snapshot().phase).toBe('tree');
    await browser.travel(-1);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 4, phase: 'playing' });
    expect(browser.el('tree').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(false);
  });

  it('goes back from the result of a level, and the result goes away', async () => {
    const { app, browser } = await boot({ reached: 6, path: '/4' });
    await enter(browser, 1);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(browser.el('result').hidden).toBe(false);
    await browser.travel(-1);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 4, steps: 0, phase: 'playing' });
    expect(browser.el('result').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(false);
  });

  it('changes level under a marble that is still rolling when the back button is pressed', async () => {
    const { app, browser } = await boot({ reached: 6, path: '/4' });
    await enter(browser, 2);
    await browser.key('U');
    await browser.frame();
    await browser.travel(-1);
    await browser.seconds(4);
    expect(app.snapshot()).toMatchObject({ level: 4, steps: 0, phase: 'playing', idle: true });
    expect(stainMatchesRules(app)).toBe(true);
    expect(app.view.ball).toBeNull();
    expect(app.view.stage.board.children).toHaveLength(1);
    await play(browser, LEVELS[3].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('lets the tray that is sliding in arrive first when the back button is pressed in the middle of it', async () => {
    const { app, browser } = await boot({ reached: 6, path: '/4' });
    await browser.click('btn-levels');
    await browser.click(knot(browser, 2));
    await browser.seconds(0.3);
    expect(browser.entries).toEqual(['/4', '/2']);
    await browser.travel(-1);
    // 两次换托盘不能叠在一起：第 2 关的托盘先摆好
    expect(app.snapshot()).toMatchObject({ level: 2, phase: 'entering' });
    await browser.seconds(6);
    expect(app.snapshot()).toMatchObject({ level: 4, steps: 0, phase: 'playing', idle: true });
    expect(app.view.leaving).toBeNull();
    expect(app.view.stage.board.children).toHaveLength(1);
    expect(browser.path).toBe('/4');
  });

  it('lets a number changed by hand decide where the game opens and what can be played', async () => {
    // 老存档里只通过了前两关的人，把那个数字改成了 40
    const { app, browser } = await boot({ bests: [3, 5], reached: 40 });
    expect(app.snapshot()).toMatchObject({ level: 40, id: 'b40', phase: 'playing' });
    expect(browser.path).toBe('/40');
    await browser.click('btn-levels');
    const kinds = browser.knots().map(kind);
    expect(kinds.slice(0, 39).every((one) => one === 'done')).toBe(true);
    expect(kinds.slice(39, 42)).toEqual(['open', 'locked', 'locked']);
    // 真玩过的关星星还在，跳过去的那些没有
    expect(noteOf(knot(browser, 1))).toEqual({ stars: 3, text: '3 步' });
    expect(noteOf(knot(browser, 39))).toBeNull();
    await enter(browser, 39);
    expect(app.snapshot()).toMatchObject({ level: 39, id: 'b39', phase: 'playing' });
  });

  it('writes the number down for a player who only has an older save', async () => {
    const { browser } = await boot({ bests: [3, 5] });
    expect(browser.storage.get(LEVEL)).toBe('3');
  });

  it('moves the number on when the level in turn is passed, and leaves it alone when an earlier level is played again', async () => {
    const { browser } = await boot({ reached: 2 });
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    expect(browser.storage.get(LEVEL)).toBe('3');
    await enter(browser, 1);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(browser.storage.get(LEVEL)).toBe('3');
  });

  it('goes by the number as it is stored now, not as it was when the page was opened', async () => {
    const { app, browser } = await boot({ reached: 2 });
    // 另一个标签页里已经玩到了第 9 关（或者是手改的）
    browser.storage.set(LEVEL, '9');
    await browser.click('btn-levels');
    expect(browser.knots().slice(7, 10).map(kind)).toEqual(['done', 'open', 'locked']);
    await enter(browser, 9);
    expect(app.snapshot()).toMatchObject({ level: 9, phase: 'playing' });
    // 这边再通过前面的关，不会把那个数改小
    await enter(browser, 1);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(browser.storage.get(LEVEL)).toBe('9');
  });

  it('does not put the number back when a level is passed here after another tab has gone further', async () => {
    const { browser } = await boot({ reached: 2, path: '/1' });
    // 这一页一直停在第 1 关里没动；另一个标签页这期间玩到了第 9 关
    browser.storage.set(LEVEL, '9');
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(browser.storage.get(LEVEL)).toBe('9');
    // 接着就能进第 9 关
    await enter(browser, 9);
    expect(browser.path).toBe('/9');
  });

  it('shows no result beside a level whose turn has not come, even one played before the number was turned back by hand', async () => {
    // 按关记的成绩里通过了前三关，那个数字却被改回了 2
    const { app, browser } = await boot({ bests: [3, 5, 6], reached: 2 });
    expect(app.snapshot()).toMatchObject({ level: 2, id: 'b02' });
    await browser.click('btn-levels');
    expect(browser.knots().slice(0, 4).map(kind)).toEqual(['done', 'open', 'locked', 'locked']);
    expect(noteOf(knot(browser, 1))).toEqual({ stars: 3, text: '3 步' });
    expect(noteOf(knot(browser, 2))).toEqual({ stars: 3, text: '5 步' });
    expect(noteOf(knot(browser, 3))).toBeNull();
    expect(knot(browser, 3).disabled).toBe(true);
  });

  it('still counts a win for someone whose browser refuses to store anything, for as long as the page stays open', async () => {
    const refuse = (): never => {
      throw new Error('storage is off');
    };
    const { app, browser } = await boot({ before: () => vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse }) });
    await play(browser, 'ULD');
    await browser.seconds(2);
    await browser.click('btn-next');
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 2, phase: 'playing' });
    await browser.click('btn-levels');
    expect(browser.knots().slice(0, 3).map(kind)).toEqual(['done', 'open', 'locked']);
  });
});

describe('with all levels open', () => {
  /** 内置的 80 关，配置页上的"开放全部关卡"开着 */
  const OPEN: LevelSet = { ...BUILTIN, openAll: true };

  it('lets a new player press every leaf on the tree', async () => {
    const { browser } = await boot({ set: OPEN, enter: null });
    const knots = browser.knots();
    expect(knots).toHaveLength(80);
    expect(kind(knots[0])).toBe('open');
    expect(knots.slice(1).every((el) => kind(el) === 'free')).toBe(true);
    expect(knots.every((el) => !el.disabled)).toBe(true);
  });

  it('keeps the levels not reached locked while the switch is off', async () => {
    const { browser } = await boot({ set: { version: 1, levels: BUILTIN.levels }, reached: 3, enter: null });
    expect(browser.knots().slice(0, 5).map(kind)).toEqual(['done', 'done', 'open', 'locked', 'locked']);
    expect(browser.knots().filter((el) => !el.disabled)).toHaveLength(3);
  });

  it('goes into a level far ahead when its leaf is pressed, and moves the player on to the level after it once it is passed', async () => {
    const { app, browser } = await boot({ set: OPEN, reached: 3 });
    await enter(browser, 12);
    expect(app.snapshot()).toMatchObject({ level: 12, id: 'b12', steps: 0, phase: 'playing' });
    expect(browser.path).toBe('/12');
    await play(browser, app.snapshot().solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
    // 玩到第 13 关了：中间跳过去的那些也算通过，只是没有星星
    expect(browser.storage.get(LEVEL)).toBe('13');
    await browser.click('btn-result-levels');
    const kinds = browser.knots().map(kind);
    expect(kinds.slice(0, 12).every((one) => one === 'done')).toBe(true);
    expect(kinds.slice(12, 15)).toEqual(['open', 'free', 'free']);
    expect(noteOf(knot(browser, 12))).toEqual({ stars: 3, text: `${LEVELS[11].par} 步` });
    expect(noteOf(knot(browser, 5))).toBeNull();
  });

  it('goes on to the next level from the result of a level played out of turn', async () => {
    const { app, browser } = await boot({ set: OPEN, reached: 2 });
    await enter(browser, 6);
    await play(browser, app.snapshot().solution);
    await browser.seconds(2);
    await browser.click('btn-next');
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 7, id: 'b07', phase: 'playing' });
    expect(browser.entries).toEqual(['/2', '/6', '/7']);
  });

  it.each(['/40', '/80'])('opens the level in the address %s although the player has not got that far', async (path) => {
    const { app, browser } = await boot({ set: OPEN, reached: 12, path });
    expect(app.snapshot()).toMatchObject({ level: Number(path.slice(1)), phase: 'playing' });
    expect(browser.entries).toEqual([path]);
    // 光是进去不算通过：那个数没动
    expect(browser.storage.get(LEVEL)).toBe('12');
  });

  it.each(['/81', '/200', '/0', '/abc'])('still goes to the level in turn when the address is %s, which is no level', async (path) => {
    const { app, browser } = await boot({ set: OPEN, reached: 12, path });
    expect(app.snapshot()).toMatchObject({ level: 12, id: 'b12', phase: 'playing' });
    expect(browser.entries).toEqual(['/12']);
  });

  it('opens on the level in turn at the root address, as it does when the switch is off', async () => {
    const { app, browser } = await boot({ set: OPEN, reached: 12 });
    expect(app.snapshot()).toMatchObject({ level: 12, phase: 'playing' });
    expect(browser.entries).toEqual(['/12']);
  });

  it('shows the guide to a first-time player over whichever level the address names', async () => {
    const { app, browser } = await boot({ set: OPEN, path: '/7', guide: 'stay' });
    expect(browser.el('guide').hidden).toBe(false);
    expect(app.snapshot()).toMatchObject({ level: 7, id: 'b07', guide: true });
    await skipGuide(browser);
    expect(app.snapshot()).toMatchObject({ level: 7, guide: false });
    // 看完指引算是玩过了，但第 7 关还没通过：轮到的还是第 1 关
    expect(browser.storage.get(LEVEL)).toBe('1');
  });

  it('goes back and forth between levels the player has not reached with the buttons of the browser', async () => {
    const { app, browser } = await boot({ set: OPEN, reached: 2, path: '/30' });
    await enter(browser, 20);
    expect(browser.entries).toEqual(['/30', '/20']);
    await browser.travel(-1);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 30, id: 'b30', steps: 0, phase: 'playing' });
    expect(browser.path).toBe('/30');
    await browser.travel(1);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 20, phase: 'playing' });
  });

  it('writes the result beside a level played out of turn before, but dyes only the leaves of levels that count as passed', async () => {
    // 存档里第 9 关有成绩，那个数却只到第 3 关（手改回去的）：全部关卡开放着，第 9 关进得去，成绩照写，叶片不染
    const bests = [3, 5, 0, 0, 0, 0, 0, 0, LEVELS[8].par];
    const { browser } = await boot({ set: OPEN, bests, reached: 3, enter: null });
    expect(kind(knot(browser, 9))).toBe('free');
    expect(noteOf(knot(browser, 9))).toEqual({ stars: 3, text: `${LEVELS[8].par} 步` });
    expect(knot(browser, 9).style.props['--tint']).toBeUndefined();
    expect(knot(browser, 1).style.props['--tint']).toBe('#516bc6');
  });
});

describe('the guide for first-time players', () => {
  /** 指引的三页各自亮没亮着 */
  const pages = (browser: FakeBrowser): boolean[] => [1, 2, 3].map((n) => !browser.el(`guide-page-${n}`).hidden);
  /** 指引底下那排点，哪一个是亮的 */
  const dots = (browser: FakeBrowser): string[] => [1, 2, 3].map((n) => browser.el(`guide-dot-${n}`).className);

  it('comes up over the first level for someone who has never played', async () => {
    const { app, browser } = await boot({ guide: 'stay' });
    expect(browser.el('guide').hidden).toBe(false);
    // 第 1 关已经摆在它后面了
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'b01', steps: 0, phase: 'playing', guide: true });
    expect(browser.entries).toEqual(['/1']);
    expect(browser.el('guide-count').textContent).toBe('第 1 步');
    expect(pages(browser)).toEqual([true, false, false]);
    expect(dots(browser)).toEqual(['on', '', '']);
    expect(browser.el('btn-guide-next').textContent).toBe('下一步');
    // 键盘的焦点在那个按钮上：按回车就是下一步
    expect(browser.document.activeElement).toBe(browser.el('btn-guide-next'));
  });

  it('takes a newcomer to the first level whatever address they arrive by', async () => {
    const { app, browser } = await boot({ guide: 'stay', path: '/30' });
    expect(app.snapshot()).toMatchObject({ level: 1, guide: true });
    expect(browser.entries).toEqual(['/1']);
  });

  it('comes up over the first level of the set, whichever level that is', async () => {
    const set: LevelSet = { version: 1, levels: [{ ...BUILTIN.levels[50], id: 'big' }, BUILTIN.levels[0]] };
    const { app, browser } = await boot({ set, guide: 'stay' });
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'big', guide: true });
    expect(browser.el('guide').hidden).toBe(false);
  });

  it('goes through its three steps one press at a time and then gets out of the way', async () => {
    const { app, browser } = await boot({ guide: 'stay' });
    await browser.click('btn-guide-next');
    expect(browser.el('guide-count').textContent).toBe('第 2 步');
    expect(pages(browser)).toEqual([false, true, false]);
    expect(dots(browser)).toEqual(['', 'on', '']);
    expect(browser.el('btn-guide-next').textContent).toBe('下一步');
    await browser.click('btn-guide-next');
    expect(browser.el('guide-count').textContent).toBe('第 3 步');
    expect(pages(browser)).toEqual([false, false, true]);
    expect(dots(browser)).toEqual(['', '', 'on']);
    expect(browser.el('btn-guide-next').textContent).toBe('开始');
    expect(browser.el('guide').hidden).toBe(false);
    await browser.click('btn-guide-next');
    expect(browser.el('guide').hidden).toBe(true);
    expect(app.snapshot()).toMatchObject({ level: 1, phase: 'playing', guide: false });
  });

  it('keeps the marble still while it is showing, and lets it roll afterwards', async () => {
    const { app, browser } = await boot({ guide: 'stay' });
    await browser.key('U');
    await browser.swipe('U');
    await browser.seconds(1);
    expect(app.snapshot()).toMatchObject({ steps: 0, phase: 'playing' });
    expect(app.game.pos).toBe(app.level.start);
    // 被它挡着的按钮也按不动
    await browser.click('btn-levels');
    expect(app.snapshot().phase).toBe('playing');
    expect(browser.el('tree').hidden).toBe(true);
    await skipGuide(browser);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot()).toMatchObject({ steps: 3, phase: 'done' });
  });

  it('does not come back once it has been gone through', async () => {
    const first = await boot();
    expect(first.browser.storage.get(LEVEL)).toBe('1');
    // 下次再来：同一个浏览器里存着的东西都还在
    const again = await boot({ guide: 'stay', before: (b) => first.browser.storage.forEach((value, key) => b.storage.set(key, value)) });
    expect(again.browser.el('guide').hidden).toBe(true);
    expect(again.app.snapshot()).toMatchObject({ level: 1, phase: 'playing', guide: false });
  });

  it('comes up again, from its first step, for someone who left before the end of it', async () => {
    const first = await boot({ guide: 'stay' });
    await first.browser.click('btn-guide-next');
    expect(first.browser.storage.has(LEVEL)).toBe(false);
    const again = await boot({ guide: 'stay', before: (b) => first.browser.storage.forEach((value, key) => b.storage.set(key, value)) });
    expect(again.browser.el('guide').hidden).toBe(false);
    expect(again.browser.el('guide-count').textContent).toBe('第 1 步');
  });

  it('is not shown to someone who has played before', async () => {
    // 只有老存档的人
    const veteran = await boot({ bests: [3], guide: 'stay' });
    expect(veteran.browser.el('guide').hidden).toBe(true);
    expect(veteran.app.snapshot()).toMatchObject({ level: 2, guide: false });
    // 存着数字的人，哪怕还停在第 1 关
    const beginner = await boot({ reached: 1, guide: 'stay' });
    expect(beginner.browser.el('guide').hidden).toBe(true);
  });

  it('does not take any room from the tray', async () => {
    // 以前是摆在左下角的一块提示牌，托盘要给它让地方；现在是盖在上面的弹层，托盘该多大还多大
    const withGuide = await boot({ guide: 'stay', screen: { width: 375, height: 667 } });
    const without = await boot({ reached: 1, screen: { width: 375, height: 667 } });
    expect(withGuide.app.view.stage.resizes.at(-1)!.safe).toEqual({ left: 10, right: 10, top: 94, bottom: 61 + 12 });
    expect(without.app.view.stage.resizes.at(-1)!.safe).toEqual(withGuide.app.view.stage.resizes.at(-1)!.safe);
  });
});

describe('a rectangular level', () => {
  // 第 51 关：存的是 19 行 × 15 列
  const upTo51 = { bests: new Array<number>(LEVELS.length).fill(999), enter: 51 };
  const WIDE = { width: 1280, height: 720 };

  it('stands upright on a tall screen', async () => {
    const { app } = await boot(upTo51);
    expect([app.level.rows, app.level.cols]).toEqual([19, 15]);
    const { tray } = app.view.board;
    expect(tray.depth).toBeCloseTo(12.5, 9);
    expect(tray.width).toBeCloseTo((15 * 10) / 19 + 2.5, 9);
    expect(app.snapshot().solution).toBe(LEVELS[50].solution);
  });

  it('lies on its side on a wide screen', async () => {
    const { app, browser } = await boot({ ...upTo51, screen: WIDE });
    expect([app.level.rows, app.level.cols]).toEqual([15, 19]);
    const { tray } = app.view.board;
    expect(tray.width).toBeCloseTo(12.5, 9);
    expect(tray.depth).toBeCloseTo((15 * 10) / 19 + 2.5, 9);
    // 还是同一关：地面一样多，最少步数一样
    expect(app.level.floorCount).toBe(LEVELS[50].rows.join('').replaceAll('#', '').length);
    expect(browser.el('par').textContent).toBe(`最少 ${LEVELS[50].par} 步`);
  });

  it('is framed by its own size, not by the size of a square tray', async () => {
    const { app } = await boot({ ...upTo51, screen: WIDE });
    const { tray } = app.view.board;
    const last = app.view.stage.resizes.at(-1)!;
    expect(last.box.halfWidth).toBeCloseTo(tray.width / 2, 9);
    expect(last.box.halfDepth).toBeCloseTo(tray.depth / 2, 9);
  });

  it('can be played to the end lying on its side, with the picture following every step', async () => {
    const { app, browser } = await boot({ ...upTo51, screen: WIDE });
    const route = app.snapshot().solution;
    await play(browser, route.slice(0, 20));
    expect(stainMatchesRules(app)).toBe(true);
    expect(marbleOffCentre(app)).toBeLessThan(1e-6);
    await play(browser, route.slice(20));
    await browser.seconds(2);
    expect(app.snapshot()).toMatchObject({ level: 51, steps: LEVELS[50].par, phase: 'done' });
    expect(browser.el('result-title').textContent).toBe(`${LEVELS[50].par} 步通关`);
    expect(wonStars(browser, 'result-stars')).toBe(3);
  });

  it('keeps the way it lies when the window changes shape in the middle of the level, and follows the screen from the next level on', async () => {
    const { app, browser } = await boot({ ...upTo51, screen: WIDE });
    await play(browser, app.snapshot().solution.slice(0, 3));
    browser.resize(390, 844);
    await browser.seconds(1);
    expect([app.level.rows, app.level.cols]).toEqual([15, 19]);
    expect(app.snapshot().steps).toBe(3);
    await browser.click('btn-restart');
    await browser.seconds(2);
    expect([app.level.rows, app.level.cols]).toEqual([15, 19]);
    await enter(browser, 52);
    expect(app.snapshot()).toMatchObject({ level: 52, phase: 'playing' });
    expect([app.level.rows, app.level.cols]).toEqual([19, 15]);
  });

  it('has the camera glide to fit while a tray of another shape slides in', async () => {
    const { app, browser } = await boot({ ...upTo51, enter: 50, screen: WIDE });
    const stage = app.view.stage;
    expect(stage.resizes.at(-1)!.box).toEqual({ halfWidth: 6.25, halfDepth: 6.25 });
    const before = stage.resizes.length;
    await enter(browser, 51);
    const depths = stage.resizes.slice(before).map((r) => r.box.halfDepth);
    const target = app.view.board.tray.depth / 2;
    expect(depths.at(-1)).toBeCloseTo(target, 9);
    // 不是一下子跳过去的：中间经过了好些大小
    expect(depths.filter((d) => d < 6.25 - 1e-6 && d > target + 1e-6).length).toBeGreaterThan(10);
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeLessThanOrEqual(depths[i - 1] + 1e-9);
  });
});

describe('when the picture cannot be built', () => {
  it('says so instead of silently ignoring every key from then on', async () => {
    const { app, browser } = await boot();
    await play(browser, 'ULD');
    await browser.seconds(2);
    vi.spyOn(app.view, 'enter').mockRejectedValueOnce(new Error('out of canvas memory'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await browser.click('btn-next');
    await browser.seconds(1);
    const notes = browser.document.body.children.filter((kid) => kid.className.includes('broken'));
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).not.toBe('');
  });
});

describe('whatever is pressed, in whatever order', () => {
  // 乱按一气：方向键、滑动、撤销、重玩、回树、从树上进关、下一关、再来一次、浏览器的后退和前进、改窗口大小，
  // 中间夹着长短不一的停顿。每隔一阵停手等画面静下来，这时规则、画面、界面、地址、存档必须全都对得上。
  it.each([1, 2, 3, 4, 5, 6])('everything still agrees once things settle (seed %i)', async (seed) => {
    const { app, browser } = await boot({ bests: [9, 9, 9, 9, 9, 9], enter: 1 });
    const rand = seeded(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const DIRS: readonly Dir[] = ['U', 'R', 'D', 'L'];
    const onTree = (): boolean => !browser.el('tree').hidden;

    const act = async (): Promise<void> => {
      const r = rand();
      // 不管在哪，偶尔按一下浏览器的后退或者前进（没有可去的那一项时等于没按）
      if (r >= 0.9 && r < 0.96) {
        await browser.travel(r < 0.94 ? -1 : 1);
        return;
      }
      if (onTree()) {
        // 在树上：多半是点一片叶片进关（常常就是刚才那一关），有时按方向键、改窗口大小，有时什么都不做
        if (r < 0.6) await browser.click(browser.knots()[rand() < 0.45 ? app.index : Math.floor(rand() * 4)]);
        else if (r < 0.8) await browser.key(pick(DIRS));
        else if (r < 0.85) browser.resize(320 + Math.floor(rand() * 600), 480 + Math.floor(rand() * 500));
        return;
      }
      if (!browser.el('result').hidden && r < 0.6) {
        await browser.click(r < 0.25 ? 'btn-next' : r < 0.5 ? 'btn-again' : 'btn-result-levels');
        return;
      }
      if (r < 0.4) await browser.key(pick(DIRS));
      else if (r < 0.5) await browser.swipe(pick(DIRS));
      else if (r < 0.64) await browser.click('btn-undo');
      else if (r < 0.72) await browser.click('btn-restart');
      else if (r < 0.82) await browser.click('btn-levels');
      else if (r < 0.85) await browser.click('btn-sound');
      else if (r < 0.88) browser.resize(320 + Math.floor(rand() * 600), 480 + Math.floor(rand() * 500));
    };

    for (let round = 0; round < 40; round++) {
      const burst = 3 + Math.floor(rand() * 25);
      for (let i = 0; i < burst; i++) {
        await act();
        expect(browser.el('steps').textContent).toBe(String(steps(app.game)));
        // 两次操作之间隔 0–40 帧，偶尔一帧特别长（切到别的标签页再回来）
        const gap = rand() < 0.3 ? Math.floor(rand() * 4) : Math.floor(rand() * 40);
        for (let f = 0; f < gap; f++) await browser.frame(rand() < 0.01 ? 4000 : 1000 / 60);
      }
      // 停手之后最久的情形：托盘正在换的时候按了后退或前进，摆好了还要再换一次（两次加起来三秒多），
      // 之后画面还要接着画六秒等染料变干
      await browser.seconds(12);

      const where = `种子 ${seed} 第 ${round} 轮`;
      const { board } = app.view;
      expect(app.phase, where).not.toBe('entering');
      expect(app.pumping, where).toBe(false);
      expect(app.queue, where).toHaveLength(0);
      expect(browser.queued, `${where}：画面该停下来了`).toHaveLength(0);
      expect(app.view.ball, where).toBeNull();
      expect(app.view.extras, where).toHaveLength(0);
      expect(app.view.timers, where).toHaveLength(0);
      expect(app.view.leaving, where).toBeNull();
      expect(app.view.stage.board.children, where).toHaveLength(1);
      expect(board.tray.level, where).toBe(app.level);
      expect(stainMatchesRules(app), `${where}：画面上的染色和规则对不上`).toBe(true);
      expect(marbleOffCentre(app), `${where}：弹珠不在它该在的格子正中`).toBeLessThan(1e-6);
      expect(board.marble.group.position.y, where).toBeCloseTo(board.marble.radius, 9);
      expect(board.marble.group.visible, where).toBe(true);
      expect(board.tilt, where).toMatchObject({ x: 0, z: 0 });
      expect(board.tray.group.position, where).toMatchObject({ x: 0, y: 0, z: 0 });
      expect(browser.el('btn-undo').disabled, where).toBe(steps(app.game) === 0);
      expect(browser.el('result').hidden, where).toBe(app.phase !== 'done');
      expect(browser.el('tools').hidden, where).toBe(app.phase === 'done' || app.phase === 'tree');
      expect(browser.el('tally').hidden, where).toBe(app.phase === 'tree');
      expect(browser.el('tree').hidden, where).toBe(app.phase !== 'tree');
      // 回到树上时那一局已经丢开了，通没通关都有可能
      if (app.phase !== 'tree') expect(isDone(app.game), where).toBe(app.phase === 'done');
      if (app.phase === 'done') {
        const best = app.progress.done[K[app.index].id]?.best ?? 0;
        expect(best > 0 && best <= steps(app.game), `${where}：通关了但最好成绩是 ${best}`).toBe(true);
      }
      const saved = JSON.parse(browser.storage.get(SAVE)!) as { done: object };
      expect(saved.done, where).toEqual(app.progress.done);
      // 地址栏里写的就是现在这一关（在树上时是刚才那一关）；存着的"玩到第几关"和程序里记的一样，而且这一关没超过它
      expect(browser.path, where).toBe(`/${app.index + 1}`);
      expect(browser.storage.get(LEVEL), where).toBe(String(app.reached));
      expect(app.index + 1, where).toBeLessThanOrEqual(app.reached);
      expect(browser.el('guide').hidden, where).toBe(true);
      expect(Math.max(...browser.perFrame.slice(-600)), `${where}：一帧里画了不止一次`).toBeLessThanOrEqual(1);
    }
  });
});
