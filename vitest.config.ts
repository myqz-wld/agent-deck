import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest 独立配置（不与 electron.vite.config.ts 共享：electron-vite 是给 main/preload/renderer
 * 三段编译的，Vitest 只跑 node 环境单测，不需要 plugin react / electron build chain）。
 *
 * Alias 与 electron.vite.config.ts 保持一致，让测试文件可以用 `@main` / `@shared` 引用。
 *
 * 当前覆盖：
 * - src/main/store/payload-truncate.test.ts —— Phase 0 N1 截断行为
 * - 后续：src/main/session/__tests__/manager.test.ts —— Phase 2 ingest 五种时序
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 全局 mock electron + electron-log/main —— Plan runtime-logging-electron-log-20260529 §D15
    // 让所有 main 测试 import 'electron' / 'electron-log/main' 时拿 mock 不撞 native 安装错;
    // 详 vitest-setup.ts 头注 + plan §Step 3.0.2.5.
    setupFiles: ['./vitest-setup.ts'],
  },
});
