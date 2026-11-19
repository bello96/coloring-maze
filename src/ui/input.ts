import type { Dir } from '../game/level.ts';
import { swipeDir } from './swipe.ts';

const KEYS: Readonly<Record<string, Dir>> = { ArrowUp: 'U', ArrowRight: 'R', ArrowDown: 'D', ArrowLeft: 'L' };
/** 手指滑出这么多像素才算数 */
const SWIPE_PX = 22;

/**
 * 两种操作：电脑上按方向键，触屏上用手指滑。
 * 一次滑动只算一个方向，要再动得抬起手指重新滑。
 * @param onDir 收到一个方向。返回这一下用掉了没有（没用掉的方向键留给浏览器）
 */
export function listen(surface: HTMLElement, onDir: (dir: Dir) => boolean): void {
  window.addEventListener('keydown', (e) => {
    const dir = KEYS[e.key];
    if (!dir || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    // 这一下游戏用掉了，就别让浏览器再拿它去滚动页面（焦点在按钮上时会）；
    // 没用掉——正在选关树上——就留给浏览器，方向键照常滚动那棵树
    if (onDir(dir)) e.preventDefault();
  });

  let finger = -1;
  let startX = 0;
  let startY = 0;
  surface.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    finger = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  });
  surface.addEventListener('pointermove', (e) => {
    if (e.pointerId !== finger) return;
    const dir = swipeDir(e.clientX - startX, e.clientY - startY, SWIPE_PX);
    if (!dir) return;
    finger = -1;
    onDir(dir);
  });
  const lift = (e: PointerEvent): void => {
    if (e.pointerId === finger) finger = -1;
  };
  surface.addEventListener('pointerup', lift);
  surface.addEventListener('pointercancel', lift);
  // 微信等内置浏览器里，往下滑会把整个网页拽下来；在游戏画面上不要这个效果
  surface.addEventListener(
    'touchmove',
    (e) => {
      // 浏览器已经开始自己处理这次触摸时拦不住，硬拦只会在控制台里报一条错
      if (e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
  // iPhone 上双指一捏会把整个页面放大（它不理会页面里"禁止缩放"的声明），放大后在游戏画面上又捏不回去
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}
