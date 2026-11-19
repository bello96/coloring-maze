import { defineConfig } from 'vitest/config';
import { devApi } from './tools/dev-api.ts';

export default defineConfig({
  // 开发和预览服务器里的假接口（/api/levels），以及 /config 这个地址：见 tools/dev-api.ts
  plugins: [devApi()],
  server: { port: 5193 },
  preview: { port: 5194 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rolldownOptions: {
      // 两个页面：游戏（index.html）和关卡配置页（config.html，线上的地址是 /config）
      input: { main: 'index.html', config: 'config.html' },
      // three.js 单独成一个文件：它几乎不变，游戏更新后浏览器还能接着用缓存里的那份
      output: {
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 关卡测试要把每一关的最少步数重新算一遍，电脑忙的时候会超过默认的 5 秒
    testTimeout: 60_000,
  },
});
