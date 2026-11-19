// 开发服务器（vite）和预览服务器（vite preview）里的假接口：让 /api/levels 在本机也能用，不必装、不必开 wrangler dev。
// 接口的逻辑不是另写的一份——用的就是线上那个处理函数（worker/api.ts 的 handle），
// 只是 KV 换成本机的一个 JSON 文件，口令固定是 dev-token。
// 另外把 /config 这个地址对到 config.html：线上是 Cloudflare 的静态资源替我们做的这件事（见 wrangler.jsonc）。
// 关卡的地址（/12 是第 12 关）这里不用管：Vite 对找不到文件的地址本来就回 index.html；线上是 Worker 做的（见 worker/index.ts）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { handle, type KV } from '../worker/api.ts';

/** 本机的口令。线上的口令是 Worker 的密钥，和它没有关系 */
const DEV_TOKEN = 'dev-token';
/** KV 文件默认放在这里（从项目目录算起）；想换地方就设环境变量 MAZE_DEV_KV */
const DEFAULT_FILE = 'node_modules/.cache/coloring-maze/dev-kv.json';

/** 拿一个 JSON 文件当 KV：文件里是一个对象，键就是 KV 的键，值是存进去的那段文字 */
function fileKV(file: string): KV {
  // 每次都重新读文件，不在内存里留一份：开发服务器和预览服务器可以同时开着、共用这一个文件。
  // 文件还没有就当它是空的；文件坏了（不是 JSON）会在这里出错，由处理函数回 500，不去动它
  const read = (): Record<string, string> => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {});
  return {
    async get(key) {
      return read()[key] ?? null;
    },
    async put(key, value) {
      const all = read();
      all[key] = value;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(all));
    },
  };
}

/** 把 Node 收到的请求交给处理函数，再把它的响应原样写回去 */
async function relay(req: IncomingMessage, res: ServerResponse, kv: KV): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  // GET 和 HEAD 不许带请求体；别的方法把请求体整个收下来再交出去（本机用，不怕它大）
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  const request = new Request(`http://localhost${req.url}`, { method, headers, body });
  const response = await handle(request, { LEVELS_KV: kv, LEVEL_ADMIN_TOKEN: DEV_TOKEN });
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Vite 插件：vite 和 vite preview 里都生效 */
export function devApi(): Plugin {
  // 两种服务器挂的是同一个中间件。这两个钩子都在 Vite 装它自己的中间件之前调用，所以这里排在最前面
  const attach = (server: { readonly config: { readonly root: string }; readonly middlewares: Connect.Server }): void => {
    const kv = fileKV(resolve(server.config.root, process.env.MAZE_DEV_KV || DEFAULT_FILE));
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '/';
      const path = url.split('?')[0];
      if (path === '/config') {
        // 只改地址，页面还是交给 Vite 去出（开发时它要往页面里插自己的脚本）
        req.url = `/config.html${url.slice(path.length)}`;
        next();
      } else if (path.startsWith('/api/')) {
        relay(req, res, kv).catch(next);
      } else {
        next();
      }
    });
  };
  return { name: 'coloring-maze:dev-api', configureServer: attach, configurePreviewServer: attach };
}
