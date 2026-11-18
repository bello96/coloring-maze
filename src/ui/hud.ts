import { bestOf, isUnlocked, type Progress } from '../game/progress.ts';
import { starsFor } from '../game/stars.ts';
import type { Insets } from '../view/stage.ts';

export interface HudHandlers {
  undo(): void;
  restart(): void;
  openLevels(): void;
  closeLevels(): void;
  toggleSound(): void;
  next(): void;
  again(): void;
  pick(level: number): void;
}

/** 通关面板上要显示的内容 */
export interface ResultInfo {
  readonly steps: number;
  readonly par: number;
  readonly best: number;
  readonly hasNext: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';
const STAR_PATH = 'M12 2.6l2.8 6 6.5.8-4.8 4.5 1.3 6.5L12 17.2 6.2 20.4l1.3-6.5L2.7 9.4l6.5-.8z';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 一排三颗星，前 won 颗是得到的 */
function starRow(won: number): HTMLElement {
  const row = document.createElement('span');
  row.className = 'stars';
  for (let i = 0; i < 3; i++) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (i < won) svg.classList.add('won');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', STAR_PATH);
    svg.append(path);
    row.append(svg);
  }
  return row;
}

/** 盖在游戏画面上的界面：步数、按钮、通关面板、选关面板。只管显示和把点击转告出去。 */
export class Hud {
  private readonly tally = el('tally');
  private readonly tools = el('tools');
  private readonly guide = el('guide');
  private readonly steps = el('steps');
  private readonly par = el('par');
  private readonly undo = el<HTMLButtonElement>('btn-undo');
  private readonly restart = el<HTMLButtonElement>('btn-restart');
  private readonly sound = el<HTMLButtonElement>('btn-sound');
  private readonly result = el('result');
  private readonly resultStars = el('result-stars');
  private readonly resultTitle = el('result-title');
  private readonly resultDetail = el('result-detail');
  private readonly next = el<HTMLButtonElement>('btn-next');
  private readonly levels = el('levels');
  private readonly grid = el('levels-grid');
  private readonly handlers: HudHandlers;

  constructor(handlers: HudHandlers) {
    this.handlers = handlers;
    this.undo.addEventListener('click', handlers.undo);
    this.restart.addEventListener('click', handlers.restart);
    this.sound.addEventListener('click', handlers.toggleSound);
    el('btn-levels').addEventListener('click', handlers.openLevels);
    el('btn-close-levels').addEventListener('click', handlers.closeLevels);
    el('btn-again').addEventListener('click', handlers.again);
    this.next.addEventListener('click', handlers.next);
    // 点面板外面的暗处也关掉
    this.levels.addEventListener('click', (e) => {
      if (e.target === this.levels) handlers.closeLevels();
    });
  }

  /** 木纹画好了，把界面亮出来 */
  show(woodDark: string, woodLight: string): void {
    const root = document.documentElement.style;
    root.setProperty('--wood-dark', `url(${woodDark})`);
    root.setProperty('--wood-light', `url(${woodLight})`);
    this.tally.hidden = false;
    this.tools.hidden = false;
  }

  /** 换了一关：最少步数和染料颜色 */
  setLevel(par: number, dye: string): void {
    this.par.textContent = `最少 ${par} 步`;
    document.documentElement.style.setProperty('--dye', dye);
  }

  setSteps(steps: number): void {
    this.steps.textContent = String(steps);
    // 一步没走时，没什么可撤销、可重玩的
    this.undo.disabled = this.restart.disabled = steps === 0;
  }

  setSound(on: boolean): void {
    this.sound.setAttribute('aria-pressed', String(on));
  }

  /** 左下角的新手提示牌：亮出来或者收起来 */
  setGuide(shown: boolean): void {
    this.guide.hidden = !shown;
  }

  showResult(info: ResultInfo): void {
    const stars = starsFor(info.steps, info.par);
    this.resultStars.replaceChildren(...starRow(stars).children);
    this.resultStars.setAttribute('aria-label', `${stars} 颗星`);
    this.resultTitle.textContent = `${info.steps} 步通关`;
    this.resultDetail.textContent =
      info.best < info.steps ? `最少 ${info.par} 步，最好 ${info.best} 步` : `最少 ${info.par} 步`;
    this.next.hidden = !info.hasNext;
    this.tools.hidden = true;
    this.result.hidden = false;
    // 选关面板正盖在上面的话，焦点留在面板里，不要落到被盖住的按钮上
    if (this.levels.hidden) (info.hasNext ? this.next : el('btn-again')).focus({ preventScroll: true });
  }

  hideResult(): void {
    if (this.result.hidden) return;
    this.result.hidden = true;
    this.tools.hidden = false;
  }

  get levelsOpen(): boolean {
    return !this.levels.hidden;
  }

  /**
   * 打开选关面板。
   * @param pars 每一关的最少步数
   * @param dyes 每一关染料的颜色
   */
  openLevels(pars: readonly number[], dyes: readonly string[], progress: Progress, current: number): void {
    const tiles = pars.map((par, i) => {
      const item = document.createElement('li');
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.style.setProperty('--star', dyes[i]);
      tile.append(String(i + 1));
      const best = bestOf(progress, i);
      if (best > 0) {
        const stars = starsFor(best, par);
        tile.append(starRow(stars));
        const small = document.createElement('small');
        small.textContent = `${best} 步`;
        tile.append(small);
        tile.setAttribute('aria-label', `第 ${i + 1} 关，最好 ${best} 步，${stars} 颗星`);
      } else {
        tile.setAttribute('aria-label', `第 ${i + 1} 关`);
      }
      tile.disabled = !isUnlocked(progress, i);
      if (i === current) tile.setAttribute('aria-current', 'true');
      tile.addEventListener('click', () => this.handlers.pick(i));
      item.append(tile);
      return item;
    });
    this.grid.replaceChildren(...tiles);
    this.levels.hidden = false;
    this.grid.querySelector<HTMLButtonElement>('[aria-current]')?.focus({ preventScroll: true });
  }

  closeLevels(): void {
    this.levels.hidden = true;
  }

  /** 界面在画面四边各占了多少地方，托盘要让开 */
  insets(): Insets {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // 用排版位置来量（offset…），不用屏幕上的实际位置：面板滑进来的动画还没演完时，后者是偏的
    const tally = this.tally;
    const bottom = this.result.hidden ? this.tools : this.result;
    const tallyRight = tally.offsetLeft + tally.offsetWidth;
    const guide = this.guide.hidden ? null : this.guide;
    // 手机横屏时步数在左、按钮在右（见样式表），其余时候步数在上、按钮在下
    if (tallyRight < w / 2) {
      // 提示牌也在左边，在步数的下面：哪个宽就让开哪个
      const left = Math.max(tallyRight, guide ? guide.offsetLeft + guide.offsetWidth : 0);
      return { left: left + 14, right: w - bottom.offsetLeft + 14, top: 10, bottom: 10 };
    }
    const safe: Insets = { left: 10, right: 10, top: tally.offsetTop + tally.offsetHeight + 8, bottom: h - bottom.offsetTop + 12 };
    if (!guide) return safe;

    // 提示牌在左下角。托盘（有提示牌的只有第 1 关，是正方形的）在留出的那一块里居中、尽量大——碰不到提示牌就不用让
    const safeW = w - safe.left - safe.right;
    const safeH = h - safe.top - safe.bottom;
    const side = Math.min(safeW, safeH);
    const guideRight = guide.offsetLeft + guide.offsetWidth + 14;
    const guideTop = guide.offsetTop - 12;
    if (safe.left + (safeW - side) / 2 >= guideRight || safe.top + (safeH + side) / 2 <= guideTop) return safe;
    // 碰得到：托盘要么往上让（下面留出提示牌那么高），要么往右让，哪样托盘更大就用哪样
    const lifted = Math.min(safeW, guideTop - safe.top);
    const shifted = Math.min(w - safe.right - guideRight, safeH);
    return lifted >= shifted ? { ...safe, bottom: h - guideTop } : { ...safe, left: guideRight };
  }
}
