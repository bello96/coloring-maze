/**
 * 管理"等一段动画演到某个时刻"的那些等待。
 *
 * 动画可能还没演到就被别的动画顶掉（弹珠还在滚，玩家就换了关）。
 * 那样的话，等着的一方也得被放行，否则它会永远等下去、后面的操作全都卡住。
 */
export class Waits {
  private readonly open = new Set<() => void>();

  /**
   * 开始一段动画并等它。begin 立刻被调用，拿到一个 finish；动画演到了就调用 finish。
   * 返回的承诺在 finish 被调用、或者 releaseAll 被调用时兑现，先到的算数。
   */
  wait(begin: (finish: () => void) => void): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.open.delete(finish)) resolve();
      };
      this.open.add(finish);
      begin(finish);
    });
  }

  /** 放行所有还在等的：它们等的动画不会演完了 */
  releaseAll(): void {
    for (const finish of [...this.open]) finish();
  }
}
