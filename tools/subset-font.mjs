// 生成界面字体的子集：只保留游戏里实际用到的字，十几 KB 就够，不必让玩家下载 12 MB 的整套字体。
//
// 字体：思源宋体（Noto Serif SC）粗体，SIL OFL 1.1 授权，可自由再分发（授权全文在 public/fonts/OFL.txt）。
// 原始字体：https://github.com/notofonts/noto-cjk/tree/main/Serif/SubsetOTF/SC 里的 NotoSerifSC-Bold.otf
//
// 用法：node tools/subset-font.mjs <NotoSerifSC-Bold.otf 的路径>
// 界面文案（index.html、src/ 下的源码）有增减之后重新跑一遍即可。
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import subsetFont from 'subset-font';

const source = process.argv[2];
if (!source) {
  console.error('请给出原始字体的路径：node tools/subset-font.mjs <NotoSerifSC-Bold.otf>');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** 去掉注释：注释里的汉字不会显示在界面上，不必收进字体 */
function stripComments(code) {
  return code
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// 只看游戏那一页会把字显示出来的地方：页面本身、界面、主控制器（src/ 下的 app.ts、main.ts），以及在托盘上刻字的那个文件。
// 规则和求解器里的汉字都是给开发者看的报错，不用收；配置页（src/config/）不用这套字体，它的字也不收。
const shown = (f) => /\.ts$/.test(f) && (/[\\/]ui[\\/]/.test(f) || /^src[\\/](app|main)\.ts$/.test(f) || /[\\/]view[\\/]tray\.ts$/.test(f));
const files = ['index.html', ...walk('src').filter(shown)];
const chars = new Set('0123456789 ，');
for (const file of files) {
  for (const ch of stripComments(readFileSync(file, 'utf8'))) {
    if (/[一-鿿]/.test(ch)) chars.add(ch);
  }
}

const text = [...chars].join('');
const subset = await subsetFont(readFileSync(source), text, { targetFormat: 'woff2' });
mkdirSync('src/assets/fonts', { recursive: true });
writeFileSync('src/assets/fonts/noto-serif-sc-subset.woff2', subset);
console.log(`收录 ${chars.size} 个字符：${text}`);
console.log(`输出 ${(subset.length / 1024).toFixed(1)} KB -> src/assets/fonts/noto-serif-sc-subset.woff2`);
