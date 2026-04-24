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
    // Electron 包不能在测试里被 import（会拉起 native 模块）；遇到再加 mock。
    // 当前 payload-truncate 是纯函数，无依赖。
  },
});
