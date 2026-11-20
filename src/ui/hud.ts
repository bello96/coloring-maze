import { starsFor } from '../game/stars.ts';
import type { Insets, WoodUrls } from '../view/stage.ts';
import { starRow } from './star-row.ts';

export interface HudHandlers {
  undo(): void;
  restart(): void;
  /** 回到选关树（那排按钮里的「选关」和通关面板上的「选关」都是它） */
  levels(): void;
  toggleSound(): void;
  next(): void;
  again(): void;
}

/** 通关面板上要显示的内容 */
export interface ResultInfo {
  readonly steps: number;
  readonly par: number;
  readonly best: number;
  readonly hasNext: boolean;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 盖在游戏画面上的界面：步数、按钮、通关面板。只管显示和把点击转告出去。 */
export class Hud {
  private readonly tally = el('tally');
  private readonly tools = el('tools');
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

  constructor(handlers: HudHandlers) {
    this.undo.addEventListener('click', handlers.undo);
    this.restart.addEventListener('click', handlers.restart);
    this.sound.addEventListener('click', handlers.toggleSound);
    el('btn-levels').addEventListener('click', handlers.levels);
    el('btn-result-levels').addEventListener('click', handlers.levels);
    el('btn-again').addEventListener('click', handlers.again);
    this.next.addEventListener('click', handlers.next);
  }

  /** 木纹画好了：界面上的木片、木牌、选关树的那块长木板、那棵树和木板底下的桌面从此拿它当底纹 */
  setWood(wood: WoodUrls): void {
    const root = document.documentElement.style;
    root.setProperty('--wood-table', `url(${wood.table})`);
    root.setProperty('--wood-dark', `url(${wood.dark})`);
    root.setProperty('--wood-light', `url(${wood.light})`);
    root.setProperty('--wood-plank', `url(${wood.plank})`);
    root.setProperty('--wood-trunk', `url(${wood.trunk})`);
  }

  /** 进了一关：步数和那排按钮亮出来。回到选关树：全收起来，通关面板也一起收 */
  setPlaying(on: boolean): void {
    this.tally.hidden = this.tools.hidden = !on;
    if (!on) this.result.hidden = true;
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
    (info.hasNext ? this.next : el('btn-again')).focus({ preventScroll: true });
  }

  hideResult(): void {
    if (this.result.hidden) return;
    this.result.hidden = true;
    this.tools.hidden = false;
  }

  /** 界面在画面四边各占了多少地方，托盘要让开 */
  insets(): Insets {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // 用排版位置来量（offset…），不用屏幕上的实际位置：面板滑进来的动画还没演完时，后者是偏的
    const tally = this.tally;
    const bottom = this.result.hidden ? this.tools : this.result;
    const tallyRight = tally.offsetLeft + tally.offsetWidth;
    // 手机横屏时步数在左、按钮在右（见样式表），其余时候步数在上、按钮在下
    if (tallyRight < w / 2) return { left: tallyRight + 14, right: w - bottom.offsetLeft + 14, top: 10, bottom: 10 };
    return { left: 10, right: 10, top: tally.offsetTop + tally.offsetHeight + 8, bottom: h - bottom.offsetTop + 12 };
  }
}
