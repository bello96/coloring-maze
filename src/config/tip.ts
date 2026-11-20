// 托盘上方一闪而过的一句话：用快捷键换了画笔，亮出"画笔已切换到「墙」"，过一会儿自己淡掉。
// 这句话一直在页面里，只是平时看不见；换字的时候读屏软件会念出来（它是一个 role="status" 的元素）。

/** 亮多久（毫秒），然后淡掉 */
const SHOWN_MS = 1400;

export class Tip {
  private readonly node: HTMLElement;
  private timer = 0;

  constructor(node: HTMLElement) {
    this.node = node;
  }

  /** 亮出这句话。上一句还没淡掉的话直接换成这一句，从头再亮这么久 */
  say(text: string): void {
    this.node.textContent = text;
    this.node.classList.add('shown');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.node.classList.remove('shown'), SHOWN_MS);
  }
}
