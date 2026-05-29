/**
 * src/renderer/utils/__tests__/logger-guard.test.ts
 *
 * Plan runtime-logging-electron-log-20260529 §Step 3.5.1.5 (Round 2 fix R2-9 修订).
 *
 * 守门纯函数 `shouldCaptureRendererConsole(mode)` 测试 — 函数本身在 Step 3.0.3 已抽出
 * (Round 2 fix R2-9: 不再二改 logger.ts), 本步骤只新增测试覆盖 D5 守门 regression.
 *
 * **范围**: 4 个 mode case 验证守门返回布尔正确; 守门写错 (如 `MODE === 'test'` 反向逻辑) 会
 * 立即被这 4 个 assert 拦住.
 *
 * **环境**: vitest 默认 node env (renderer 测试不 jsdom 也能跑纯函数), 不需 vite plugin react.
 * vitest.config.ts §define 显式注入 `import.meta.env.MODE = 'test'` 让 logger.ts top-level
 * 守门跑 false 不接管 console (D5 + §不变量 2 vi.spyOn 兼容); test side effect import 安全.
 */
import { describe, expect, it } from 'vitest';
import { shouldCaptureRendererConsole } from '../logger';

describe('shouldCaptureRendererConsole — D5 console capture 守门 (Plan §Step 3.5.1.5)', () => {
  it("'test' → false (保 vi.spyOn(console) 兼容, §不变量 2)", () => {
    expect(shouldCaptureRendererConsole('test')).toBe(false);
  });

  it("'development' → true (dev 终端 / DevTools 接管)", () => {
    expect(shouldCaptureRendererConsole('development')).toBe(true);
  });

  it("'production' → true (生产 .app 接管落盘 — plan §不变量 1 根本目标)", () => {
    expect(shouldCaptureRendererConsole('production')).toBe(true);
  });

  it('undefined → true (vite env 未注入兜底默认接管)', () => {
    expect(shouldCaptureRendererConsole(undefined)).toBe(true);
  });
});
