import './style.css';
import { App } from './app.ts';

const FONT = '"Noto Serif SC", "Songti SC", "STSong", "SimSun", serif';

async function boot(): Promise<void> {
  // 托盘上刻的字要用这套字体画，所以等它到了再开始；一秒半还没到就先用系统里的宋体
  await Promise.race([
    document.fonts.load('700 40px "Noto Serif SC"', '染色迷宫第关0123456789').catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  const app = new App(document.getElementById('stage') as HTMLCanvasElement, FONT);
  app.start();
  // 给自动化检查留的口子：在控制台里输入 __maze() 能看到当前的局面
  Object.assign(window, { __maze: () => app.snapshot() });
  // 开发时再多留一个：整个程序对象，方便在控制台里摆弄
  if (import.meta.env.DEV) Object.assign(window, { __app: app });
}

boot().catch((err: unknown) => {
  // 画面起不来（多半是浏览器太旧、不支持 WebGL2）：至少说一声，别只留一片黑
  console.error(err);
  const note = document.createElement('p');
  note.className = 'broken';
  note.textContent = '这个浏览器显示不了游戏画面，换一个新一些的浏览器试试。';
  document.body.append(note);
});
