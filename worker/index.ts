// Worker 的入口。线上的每个请求先由 Cloudflare 按 wrangler.jsonc 里的规则分一次：
// /api/* 直接到这里；别的路径先找 dist/ 里的静态文件，找到了直接回，找不到的才到这里。
// 找不到的里面有一种是我们自己的：关卡的地址（/12 是第 12 关）。没有 /12 这么个文件，回的是游戏那一页，
// 由它自己看地址栏里写的是第几关（见 src/app.ts）。其余的交还给静态资源，由它回 404。
import { levelOfPath } from '../src/game/route.ts';
import { handle, type Env } from './api.ts';

/** 静态资源（dist/ 里的那些文件）在 Worker 里的样子：把请求交给它，它回文件 */
interface Assets {
  fetch(request: Request): Promise<Response>;
}

export default {
  fetch(request: Request, env: Env & { readonly ASSETS: Assets }): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handle(request, env);
    // 关卡的地址：向静态资源要网站的根地址，那里就是游戏那一页。地址栏里还是 /12，页面自己会看
    if ((request.method === 'GET' || request.method === 'HEAD') && levelOfPath(pathname) > 0) {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
