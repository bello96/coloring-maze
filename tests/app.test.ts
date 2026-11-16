// 把真正的 App 和 GameView 放进假浏览器里跑（只有碰 WebGL 的舞台是替身），一帧一帧地推进，
// 检查规则、画面、界面、存档之间在各种操作顺序下是不是始终对得上。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Level } from '../src/game/level.ts';
import { LEVELS } from '../src/game/levels.ts';
import type { Progress } from '../src/game/progress.ts';
import { isDone, steps, type Game } from '../src/game/rules.ts';
import { FakeBrowser } from './helpers/fake-browser.ts';
import { seeded } from './helpers/random.ts';

vi.mock('../src/view/stage.ts', () => import('./helpers/fake-stage.ts'));

const SAVE = 'coloring-maze.v1';
type Dir = 'U' | 'R' | 'D' | 'L';

/** 检查时要看的那些内部状态 */
interface Inner {
  readonly view: {
    readonly board: {
      readonly tray: {
        readonly level: Level;
        readonly cell: number;
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
    readonly stage: { readonly board: { readonly children: unknown[] }; renders: number; shadowRenders: number };
    enter(...args: unknown[]): Promise<void>;
  };
  readonly game: Game;
  readonly level: Level;
  readonly index: number;
  readonly phase: string;
  readonly queue: unknown[];
  readonly pumping: boolean;
  readonly progress: Progress;
  readonly sound: { rolling(speed: number): void };
  snapshot(): { level: number; steps: number; phase: string; idle: boolean; settled: boolean };
}

async function boot(saved?: object): Promise<{ browser: FakeBrowser; app: Inner }> {
  const browser = new FakeBrowser();
  browser.install();
  if (saved) browser.storage.set(SAVE, JSON.stringify(saved));
  const { App } = await import('../src/app.ts');
  const app = new App(browser.el('stage') as never, 'serif');
  app.start();
  await browser.seconds(2);
  return { browser, app: app as unknown as Inner };
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
    expect(JSON.parse(browser.storage.get(SAVE)!).best[0]).toBe(3);
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
    const { app, browser } = await boot({ best: [3], last: 1, muted: false });
    await browser.key('U');
    await browser.key('L');
    await browser.key('D');
    await browser.key('L');
    await browser.seconds(4);
    expect(app.snapshot().steps).toBe(3);
    expect(stainMatchesRules(app)).toBe(true);
  });

  it('gives fewer stars for more steps and keeps the best result', async () => {
    const { browser } = await boot({ best: [3], last: 0, muted: false });
    // 多绕两步再通关：上、下（滚回起点）、上、左、下，共 5 步
    await play(browser, 'UDULD');
    await browser.seconds(2);
    expect(browser.el('result-title').textContent).toBe('5 步通关');
    expect(browser.el('result-detail').textContent).toBe('最少 3 步，最好 3 步');
    expect(wonStars(browser, 'result-stars')).toBe(2);
    expect(JSON.parse(browser.storage.get(SAVE)!).best[0]).toBe(3);
  });
});

describe('saving', () => {
  it('keeps what another tab saved in the meantime', async () => {
    const { browser } = await boot();
    // 另一个标签页里通过了第 1、2 关，存了档
    browser.storage.set(SAVE, JSON.stringify({ best: [4, 6], last: 1, muted: false }));
    await play(browser, 'ULD');
    await browser.seconds(2);
    const saved = JSON.parse(browser.storage.get(SAVE)!) as { best: number[]; last: number };
    expect(saved.best.slice(0, 3)).toEqual([3, 6, 0]);
    expect(saved.last).toBe(0);
  });

  it('remembers that the sound was switched off', async () => {
    const { browser } = await boot();
    expect(browser.el('btn-sound').getAttribute('aria-pressed')).toBe('true');
    await browser.click('btn-sound');
    expect(browser.el('btn-sound').getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(browser.storage.get(SAVE)!).muted).toBe(true);
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
    expect(JSON.parse(browser.storage.get(SAVE)!).last).toBe(1);
  });

  it('opens only the levels up to the first one not yet finished', async () => {
    const { browser } = await boot({ best: [3, 5], last: 0, muted: false });
    await browser.click('btn-levels');
    const open = browser.tiles().map((tile) => !tile.disabled);
    expect(open.slice(0, 4)).toEqual([true, true, true, false]);
    expect(open.filter(Boolean)).toHaveLength(3);
  });

  it('ignores the arrow keys while the level panel is open', async () => {
    const { app, browser } = await boot();
    await browser.click('btn-levels');
    await browser.key('U');
    await browser.seconds(1);
    expect(app.snapshot().steps).toBe(0);
  });

  it('comes back to the level that was being played', async () => {
    const { app } = await boot({ best: [3, 5, 6], last: 2, muted: false });
    expect(app.snapshot().level).toBe(3);
  });

  it('has no "next level" after the last one', async () => {
    const all = new Array<number>(LEVELS.length).fill(99);
    const { browser } = await boot({ best: all, last: LEVELS.length - 1, muted: false });
    await play(browser, LEVELS[LEVELS.length - 1].solution);
    await browser.seconds(2);
    expect(browser.el('result').hidden).toBe(false);
    expect(browser.el('btn-next').hidden).toBe(true);
  });
});

describe('interrupting an animation', () => {
  it('stays playable when the same level is picked again while the marble is still rolling', async () => {
    // 回归：这样做之后曾经再也操作不了
    const { app, browser } = await boot({ best: [3, 5, 6], last: 0, muted: false });
    await browser.key('U');
    await browser.click('btn-levels');
    await browser.click(browser.tiles()[0]);
    await browser.seconds(3);
    expect(app.snapshot()).toMatchObject({ level: 1, steps: 0, phase: 'playing', idle: true });
    expect(stainMatchesRules(app)).toBe(true);
    await play(browser, 'ULD');
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('stays playable when another level is picked while the marble is still rolling', async () => {
    const { app, browser } = await boot({ best: [3, 5, 6], last: 0, muted: false });
    await browser.key('U');
    await browser.click('btn-levels');
    await browser.click(browser.tiles()[1]);
    await browser.seconds(4);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing', idle: true });
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('stays playable when another level is picked during the celebration', async () => {
    const { app, browser } = await boot({ best: [3, 5, 6], last: 0, muted: false });
    await play(browser, 'UL');
    await browser.key('D');
    await browser.seconds(0.6);
    expect(app.snapshot().phase).toBe('done');
    await browser.click('btn-levels');
    await browser.click(browser.tiles()[1]);
    await browser.seconds(4);
    expect(app.snapshot()).toMatchObject({ level: 2, steps: 0, phase: 'playing', idle: true });
    expect(browser.el('result').hidden).toBe(true);
    await play(browser, LEVELS[1].solution);
    await browser.seconds(2);
    expect(app.snapshot().phase).toBe('done');
  });

  it('shows the stars just earned if the level panel was opened during the last roll', async () => {
    const { browser } = await boot();
    await play(browser, 'UL');
    await browser.key('D');
    await browser.click('btn-levels');
    await browser.seconds(3);
    const tiles = browser.tiles();
    expect(tiles[0].children.some((kid) => kid.className.includes('stars'))).toBe(true);
    expect(tiles[1].disabled).toBe(false);
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
    const stage = app.view.stage as unknown as { resizes: Array<{ width: number; height: number }> };
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
  // 乱按一气：方向键、滑动、撤销、重玩、选关、下一关、再来一次、改窗口大小，中间夹着长短不一的停顿。
  // 每隔一阵停手等画面静下来，这时规则、画面、界面、存档必须全都对得上。
  it.each([1, 2, 3, 4, 5, 6])('everything still agrees once things settle (seed %i)', async (seed) => {
    const { app, browser } = await boot({ best: [9, 9, 9, 9, 9, 9], last: 0, muted: false });
    const rand = seeded(seed);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
    const DIRS: readonly Dir[] = ['U', 'R', 'D', 'L'];
    const levelsOpen = (): boolean => !browser.el('levels').hidden;

    const act = async (): Promise<void> => {
      const r = rand();
      if (levelsOpen()) {
        if (r < 0.2) await browser.click('btn-close-levels');
        else if (r < 0.75) await browser.click(browser.tiles()[rand() < 0.45 ? app.index : Math.floor(rand() * 4)]);
        else if (r < 0.9) await browser.key(pick(DIRS));
        return;
      }
      if (!browser.el('result').hidden && r < 0.5) {
        await browser.click(r < 0.25 ? 'btn-next' : 'btn-again');
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
      expect(browser.el('tools').hidden, where).toBe(app.phase === 'done');
      expect(isDone(app.game), where).toBe(app.phase === 'done');
      if (app.phase === 'done') {
        const best = app.progress.best[app.index];
        expect(best > 0 && best <= steps(app.game), `${where}：通关了但最好成绩是 ${best}`).toBe(true);
      }
      expect(app.progress.last, where).toBe(app.index);
      const saved = JSON.parse(browser.storage.get(SAVE)!) as { best: number[]; last: number };
      expect(saved.best, where).toEqual([...app.progress.best]);
      expect(saved.last, where).toBe(app.progress.last);
      expect(Math.max(...browser.perFrame.slice(-600)), `${where}：一帧里画了不止一次`).toBeLessThanOrEqual(1);
    }
  });
});
