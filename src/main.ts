import './style.css';
import { App } from './app.ts';
import { loadLevelSet } from './game/remote.ts';
import { showBroken } from './ui/broken.ts';

async function boot(): Promise<void> {
  // 线上发布的关卡表：一开头就去拿，和下面等字体、画木纹同时进行。拿不到会自己退回上次留的那份或内置的 80 关
  const levels = loadLevelSet();
  // 步数、新手指引上的字用这套字体，等它到了再亮出来，免得先闪一下系统里的字体；一秒半还没到就先用系统里的宋体。
  // 字体在下载的同时，先把木纹画好、把舞台搭起来（这要花零点几秒到一两秒），两件事不必一前一后。
  const font = Promise.race([
    document.fonts.load('700 40px "Noto Serif SC"', '染色迷宫第关0123456789').catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  const app = new App(document.getElementById('stage') as HTMLCanvasElement);
  await font;
  app.start((await levels).set);
  // 给自动化检查留的口子：在控制台里输入 __maze() 能看到当前的局面
  Object.assign(window, { __maze: () => app.snapshot() });
  // 开发时再多留一个：整个程序对象，方便在控制台里摆弄
  if (import.meta.env.DEV) Object.assign(window, { __app: app });
}

boot().catch(showBroken);
