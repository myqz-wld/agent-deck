/**
 * 测试用 sdk-loader mock factory（R37 P2-F Step 3.1）。
 *
 * 6 个 test 文件（agent-deck-mcp / task-manager / sdk-bridge.recovery / consume-fork /
 * session/hand-off）都 mock `@main/adapters/claude-code/sdk-loader` 的 `loadSdk`。
 * 大部分用同一形态：`async () => ({ tool: factory function })`，把 SDK 的 `tool()` 替成
 * 透明返回 `{ name, description, inputSchema, handler, ...annotations? }` 的 fn 让测试直接拿
 * handler 调。少数（sdk-bridge.recovery）只用 `loadSdk: vi.fn()` 后续 mockResolvedValue。
 *
 * Factory 提供两 helper：
 * - `makeSdkLoaderMock()`：返完整 `{ loadSdk: async () => ({ tool: ... }) }` mock，适合
 *   agent-deck-mcp / task-manager / hand-off 路径
 * - `makeBareSdkLoaderMock()`：返 `{ loadSdk: vi.fn() }` 让 caller 自己 mockResolvedValue
 *   控制返回值（适合 sdk-bridge.recovery / consume-fork）
 */

import { vi } from 'vitest';

/** SDK tool() factory 的最小契约（透明返回，让 test 直接拿 handler 调） */
export interface SdkToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
  annotations?: Record<string, unknown>;
}

export type SdkToolFactory = (
  name: string,
  description: string,
  inputSchema: unknown,
  handler: (args: unknown, extra: unknown) => Promise<unknown>,
  extras?: { annotations?: Record<string, unknown> },
) => SdkToolDefinition;

export interface SdkLoaderMockOptions {
  /** 自定 tool() 实现（默认透明返回 SdkToolDefinition） */
  tool?: SdkToolFactory;
  /** SDK module 上的额外字段（如 query for sdk-bridge / summarizer 路径） */
  extra?: Record<string, unknown>;
}

/**
 * 标准 sdk-loader mock。返回 `{ loadSdk: async () => ({ tool, ...extra }) }`。
 *
 * 用法：
 *   vi.mock('@main/adapters/claude-code/sdk-loader', () => makeSdkLoaderMock());
 *   // 或带 query
 *   vi.mock('@main/adapters/claude-code/sdk-loader', () => makeSdkLoaderMock({
 *     extra: { query: vi.fn() }
 *   }));
 */
export function makeSdkLoaderMock(opts: SdkLoaderMockOptions = {}): {
  loadSdk: () => Promise<Record<string, unknown>>;
} {
  const tool: SdkToolFactory =
    opts.tool ??
    ((name, description, inputSchema, handler, extras) => ({
      name,
      description,
      inputSchema,
      handler,
      ...(extras?.annotations ? { annotations: extras.annotations } : {}),
    }));

  return {
    loadSdk: async () => ({
      tool,
      ...(opts.extra ?? {}),
    }),
  };
}

/**
 * Bare sdk-loader mock：`{ loadSdk: vi.fn() }`，caller 自己 mockResolvedValue 控制返回值。
 *
 * 用法（sdk-bridge.recovery / consume-fork 路径）：
 *   vi.mock('@main/adapters/claude-code/sdk-loader', () => makeBareSdkLoaderMock());
 *   const { loadSdk } = await import('@main/adapters/claude-code/sdk-loader');
 *   vi.mocked(loadSdk).mockResolvedValue({ ... });
 */
export function makeBareSdkLoaderMock(): { loadSdk: ReturnType<typeof vi.fn> } {
  return { loadSdk: vi.fn() };
}
