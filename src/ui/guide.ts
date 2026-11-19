// 新手指引：第一次来的人先看到的分步弹层，盖在第 1 关上面，一步一页，点「下一步」往后翻，最后一页点「开始」收起来。
// 每一页讲什么、配什么图示都写在页面里（index.html），电脑上讲方向键、触屏上讲滑动是样式表按设备分的；
// 这里只管翻页。

const STEPS = 3;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class Guide {
  private readonly root = el('guide');
  private readonly count = el('guide-count');
  private readonly pages = Array.from({ length: STEPS }, (_, i) => el(`guide-page-${i + 1}`));
  private readonly dots = Array.from({ length: STEPS }, (_, i) => el(`guide-dot-${i + 1}`));
  private readonly next = el<HTMLButtonElement>('btn-guide-next');
  /** 现在在第几页，从 0 数起 */
  private step = 0;
  /** 讲完了告诉谁 */
  private finished: (() => void) | null = null;

  constructor() {
    this.next.addEventListener('click', () => this.forward());
  }

  /** 正亮着 */
  get shown(): boolean {
    return !this.root.hidden;
  }

  /**
   * 亮出来，从第一步讲起。
   * @param finished 最后一步的「开始」点过了，指引收起来了
   */
  open(finished: () => void): void {
    this.finished = finished;
    this.root.hidden = false;
    this.show(0);
  }

  private show(step: number): void {
    this.step = step;
    this.pages.forEach((page, i) => (page.hidden = i !== step));
    this.dots.forEach((dot, i) => (dot.className = i === step ? 'on' : ''));
    this.count.textContent = `第 ${step + 1} 步`;
    this.next.textContent = step + 1 < STEPS ? '下一步' : '开始';
    // 键盘的焦点放在按钮上：按回车就是下一步
    this.next.focus({ preventScroll: true });
  }

  private forward(): void {
    if (!this.shown) return;
    if (this.step + 1 < STEPS) {
      this.show(this.step + 1);
      return;
    }
    this.root.hidden = true;
    const finished = this.finished;
    this.finished = null;
    finished?.();
  }
}
