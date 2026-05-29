import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest 独立配置（不与 electron.vite.config.ts 共享：electron-vite 是给 main/preload/renderer
 * 三段编译的，Vitest 只跑 node 环境单测，不需要 plugin react / electron build chain）。
 *
 * Alias 与 electron.vite.config.ts 保持一致，让测试文件可以用 `@main` / `@shared` / `@renderer` 引用。
 *
 * Plan runtime-logging-electron-log-20260529 §Step 3.5.1.5 新增 `@renderer` alias 给
 * `src/renderer/utils/__tests__/logger-guard.test.ts` 类 renderer 端测试用 (虽然现有 renderer
 * 测试都用相对路径未撞过, 加上 alias 与 electron.vite.config.ts 一致避免后续踩坑).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 全局 mock electron + electron-log/main + electron-store + electron-log/renderer
    // —— Plan runtime-logging-electron-log-20260529 §D15 + §Step 3.0.2.5 + §Step 3.5.1.5 实证扩展.
    // 详 vitest-setup.ts 头注.
    setupFiles: ['./vitest-setup.ts'],
  },
});
