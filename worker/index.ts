// Worker 的入口。线上的每个请求先由 Cloudflare 按 wrangler.jsonc 里的规则分一次：
// /api/* 直接到这里；别的路径先找 dist/ 里的静态文件，找不到的才到这里——那就交还给静态资源，由它回 404。
import { handle, type Env } from './api.ts';

/** 静态资源（dist/ 里的那些文件）在 Worker 里的样子：把请求交给它，它回文件 */
interface Assets {
  fetch(request: Request): Promise<Response>;
}

export default {
  fetch(request: Request, env: Env & { readonly ASSETS: Assets }): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) return handle(request, env);
    return env.ASSETS.fetch(request);
  },
};
