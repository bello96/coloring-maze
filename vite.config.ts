import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5193 },
  preview: { port: 5194 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // three.js 单独成一个文件：它几乎不变，游戏更新后浏览器还能接着用缓存里的那份
    rolldownOptions: {
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
    // 关卡测试要把 50 关逐一求出最少步数，电脑忙的时候会超过默认的 5 秒
    testTimeout: 60_000,
  },
});
