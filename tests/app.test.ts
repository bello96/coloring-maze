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
  readonly sound: { rolling(speed: number): void; impact(strength: number): void };
  snapshot(): { level: number; id: string; steps: number; phase: string; idle: boolean; settled: boolean; solution: string };
}

interface BootOptions {
  /** 存档：按内置关卡的顺序，每关的最好步数（0 = 没通过） */
  readonly bests?: readonly number[];
  readonly screen?: { readonly width: number; readonly height: number };
  /** 用哪份关卡表，不给就是内置的 80 关 */
  readonly set?: LevelSet;
  /** 进第几关（从 1 数起）。不给就进轮到的那一关（玩家打得最远的地方）；null 是停在树上不进关 */
  readonly enter?: number | null;
  /** 启动之前对假浏览器再做点手脚（比如放一份旧存档、让存储坏掉） */
  readonly before?: (browser: FakeBrowser) => void;
}

async function boot(options: BootOptions = {}): Promise<{ browser: FakeBrowser; app: Inner }> {
  const browser = new FakeBrowser();
  if (options.screen) Object.assign(browser, options.screen);
  browser.install();
  if (options.bests) browser.storage.set(SAVE, JSON.stringify(saveOf(options.bests)));
  options.before?.(browser);
  const { App } = await import('../src/app.ts');
  const app = new App(browser.el('stage') as never, 'serif');
  app.start(options.set ?? BUILTIN);
  await browser.seconds(1);
  if (options.enter !== null) {
    const kinds = browser.knots().map(kind);
    const turn = kinds.lastIndexOf('open');
    await enter(browser, options.enter ?? (turn >= 0 ? turn + 1 : kinds.length));
  }
  return { browser, app: app as unknown as Inner };
}

/** 树上第 n 关（从 1 数起）的木片 */
const knot = (browser: FakeBrowser, n: number): FakeEl => browser.knots()[n - 1];
/** 木片是哪一种：done（通过了）、open（轮到了）、locked（没轮到） */
const kind = (el: FakeEl): string => el.className.replace('knot', '').trim();
/** 木片旁边刻的字：几颗星、多少步；没刻就是 null */
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

  it('opens its first level to someone whose save has never seen that level', async () => {
    const { app, browser } = await boot({ set: custom, bests: [3, 5, 6, 7] });
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'x1' });
    await browser.click('btn-levels');
    expect(browser.knots().map((el) => !el.disabled)).toEqual([true, true]);
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

describe('the tree of levels', () => {
  it('is what the game opens on: no level, no tray, nothing drawn', async () => {
    const { app, browser } = await boot({ enter: null });
    expect(app.snapshot()).toMatchObject({ level: 0, id: '', phase: 'tree' });
    expect(browser.el('tree').hidden).toBe(false);
    expect(browser.el('tally').hidden).toBe(true);
    expect(browser.el('tools').hidden).toBe(true);
    expect(browser.el('guide').hidden).toBe(true);
    expect(app.view.stage.board.children).toHaveLength(0);
    await browser.seconds(3);
    expect(app.view.stage.renders).toBe(0);
    expect(browser.queued).toHaveLength(0);
  });

  it('has a disc for every level, and a new player can press only the first', async () => {
    const { browser } = await boot({ enter: null });
    const knots = browser.knots();
    expect(knots).toHaveLength(80);
    expect(knots.map((el) => el.getAttribute('data-level'))).toEqual(Array.from({ length: 80 }, (_, i) => String(i + 1)));
    expect(kind(knots[0])).toBe('open');
    expect(knots[0].disabled).toBe(false);
    expect(knots.slice(1).every((el) => kind(el) === 'locked' && el.disabled)).toBe(true);
    expect(knots[0].children[0].textContent).toBe('1');
    expect(knots[79].children[0].textContent).toBe('80');
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
    // 焦点放在那块木片上：这样方向键、翻页键才滚得动这棵树，回车就能进去
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

  it('goes into a level when its disc is pressed', async () => {
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

  it('has the first tray slide in from the side rather than just be there', async () => {
    const { app, browser } = await boot({ enter: null });
    await browser.click(knot(browser, 1));
    await browser.frame();
    await browser.frame();
    expect(app.view.board.tray.group.position.x).toBeGreaterThan(20);
    await browser.seconds(3);
    expect(app.view.board.tray.group.position.x).toBe(0);
    expect(app.view.leaving).toBeNull();
  });

  it('does not let a level be entered whose turn has not come, however it is pressed', async () => {
    const { app, browser } = await boot({ enter: null });
    const locked = knot(browser, 6);
    expect(await browser.click(locked)).toBe(false);
    // 就算绕过了按钮的禁用（比如用脚本直接触发点击），也进不去
    for (const fn of locked.listeners.click ?? []) fn({ target: locked } as never);
    await browser.seconds(1);
    expect(app.snapshot().phase).toBe('tree');
    expect(browser.el('tree').hidden).toBe(false);
    expect(app.view.stage.board.children).toHaveLength(0);
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

  it('has two levels in turn after a level was put into the middle of the set', async () => {
    // 通过了 b01、b02 的人；b01 后面插进一关 x1
    const set: LevelSet = { version: 1, levels: [BUILTIN.levels[0], { ...BUILTIN.levels[3], id: 'x1' }, BUILTIN.levels[1], BUILTIN.levels[2]] };
    const { app, browser } = await boot({ set, bests: [3, 5], enter: null });
    expect(browser.knots().map(kind)).toEqual(['done', 'open', 'done', 'open']);
    // 打开时停在位置最靠后的那个
    expect(browser.el('tree').scrollTop).toBe(scrolledTo(4, 4));
    await enter(browser, 2);
    expect(app.snapshot()).toMatchObject({ level: 2, id: 'x1', phase: 'playing' });
    await enter(browser, 4);
    expect(app.snapshot()).toMatchObject({ level: 4, id: 'b03', phase: 'playing' });
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
    const board = browser.el('tree-board');
    expect(board.style.width).toBe('390px');
    browser.resize(1280, 720);
    expect(board.style.width).toBe('560px');
    expect(browser.knots()).toHaveLength(80);
    expect(browser.el('tree').scrollTop).toBe(scrolledTo(1, 80, 560, 720));
    await browser.seconds(1);
    expect(app.view.stage.resizes).toHaveLength(0);
    expect(app.view.stage.renders).toBe(0);
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

describe('a first level that is a big rectangle', () => {
  // 排第一的不一定是 5×5 的小方图：配置页可以把任何一关排到第一位。提示牌只在排第一的那一关里有
  const set: LevelSet = { version: 1, levels: [{ ...BUILTIN.levels[50], id: 'big' }, BUILTIN.levels[0]] };

  it('gets the guide, and the tall tray moves up so that the guide does not lie on it', async () => {
    const { app, browser } = await boot({ set });
    expect(app.snapshot()).toMatchObject({ level: 1, id: 'big', phase: 'playing' });
    expect([app.level.rows, app.level.cols]).toEqual([19, 15]);
    expect(browser.el('guide').hidden).toBe(false);
    // 竖屏 390×844：留给托盘的地方宽 370、高 677，竖着的托盘（高是宽的 1.2 倍）会伸到提示牌上沿（630）下面，所以让到它上面
    expect(app.view.stage.resizes.at(-1)!.safe).toEqual({ left: 10, right: 10, top: 94, bottom: 844 - 630 });
  });

  it('gives the room back once the guide is gone', async () => {
    const { app, browser } = await boot({ set, enter: 1, before: (b) => b.storage.set(SAVE, JSON.stringify({ done: { big: { best: 99, sig: 'x' } }, muted: false })) });
    expect(browser.el('guide').hidden).toBe(true);
    expect(app.view.stage.resizes.at(-1)!.safe).toEqual({ left: 10, right: 10, top: 94, bottom: 73 });
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

describe('the guide for first-time players', () => {
  it('is on the screen until the first level has been finished, and never comes back', async () => {
    const { app, browser } = await boot();
    expect(browser.el('guide').hidden).toBe(false);
    await play(browser, 'UL');
    expect(browser.el('guide').hidden).toBe(false);
    await browser.key('D');
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
    expect(browser.el('guide').hidden).toBe(true);
    // 再玩一次第 1 关，或者去别的关再回来，都不再出现
    await browser.click('btn-again');
    await browser.seconds(2);
    expect(browser.el('guide').hidden).toBe(true);
    await enter(browser, 2);
    await enter(browser, 1);
    expect(app.snapshot()).toMatchObject({ level: 1, phase: 'playing' });
    expect(browser.el('guide').hidden).toBe(true);
  });

  it('never shows to someone who finished the first level on an earlier visit', async () => {
    const { browser } = await boot({ bests: [3], enter: 1 });
    expect(browser.el('guide').hidden).toBe(true);
  });

  it('leaves the tray where it is on a tall screen, where there is room for both', async () => {
    const { app } = await boot();
    // 竖屏 390×844：按钮那一排上沿在 783，托盘的下沿到不了提示牌那里
    expect(app.view.stage.resizes.at(-1)!.safe).toEqual({ left: 10, right: 10, top: 94, bottom: 73 });
  });

  it('makes the tray move up out of its way on a short screen, and gives the room back afterwards', async () => {
    const { app, browser } = await boot({ screen: { width: 375, height: 667 } });
    const stage = app.view.stage;
    // 提示牌的上沿在 667 − 78 − 124 = 465，再留 12 的空
    expect(stage.resizes.at(-1)!.safe.bottom).toBe(667 - 453);
    await play(browser, 'ULD');
    await browser.seconds(3);
    // 通关面板出来、提示牌收起：让的是通关面板
    expect(stage.resizes.at(-1)!.safe.bottom).toBe(220 + 12);
    await browser.click('btn-next');
    await browser.seconds(3);
    expect(stage.resizes.at(-1)!.safe.bottom).toBe(61 + 12);
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
  // 乱按一气：方向键、滑动、撤销、重玩、回树、从树上进关、下一关、再来一次、改窗口大小，中间夹着长短不一的停顿。
  // 每隔一阵停手等画面静下来，这时规则、画面、界面、存档必须全都对得上。
  it.each([1, 2, 3, 4, 5, 6])('everything still agrees once things settle (seed %i)', async (seed) => {
    const { app, browser } = await boot({ bests: [9, 9, 9, 9, 9, 9], enter: 1 });
    const rand = seeded(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const DIRS: readonly Dir[] = ['U', 'R', 'D', 'L'];
    const onTree = (): boolean => !browser.el('tree').hidden;

    const act = async (): Promise<void> => {
      const r = rand();
      if (onTree()) {
        // 在树上：多半是点一个木片进关（常常就是刚才那一关），有时按方向键、改窗口大小，有时什么都不做
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
      await browser.seconds(9);

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
      expect(Math.max(...browser.perFrame.slice(-600)), `${where}：一帧里画了不止一次`).toBeLessThanOrEqual(1);
    }
  });
});
