/**
 * Renderer 平台常量（CHANGELOG_57）。
 *
 * 来源：preload 同步暴露的 `window.api.platform`（`process.platform`）。常量值，启动后
 * 永不变 → 模块 top-level 求值即可，无需 hook / context / async fetch。
 *
 * 命名与 `src/main/platform.ts` 对齐（`IS_DARWIN/IS_WIN/IS_LINUX`），跨进程心智一致。
 *
 * 用途：UI 文案按平台分流（设置面板透明窗口描述 / 沙盒说明 / 敏感目录路径示例 / 快捷键格式
 * 等场景）。优先 `IS_DARWIN ? ... : ...` 原地条件渲染；不必抽集中文案表（4 处场景集中
 * 在 WindowSection.tsx + ExperimentalSection.tsx 两个新文件，跨文件抽表反而要跳读）。
 *
 * 防御性 fallback（CHANGELOG_57 R1·Q3）：`globalThis.api?.platform ?? 'darwin'` —— 未来加
 * vitest jsdom / Storybook 等不带 preload 的渲染环境时，import 即崩；fallback 返回 'darwin'
 * 让 UI 渲染至少能跑（具体 platform 行为可在 test setup 里 mock window.api 覆盖）。
 */

export const PLATFORM: NodeJS.Platform =
  (globalThis as { api?: { platform?: NodeJS.Platform } }).api?.platform ?? 'darwin';
export const IS_DARWIN = PLATFORM === 'darwin';
export const IS_WIN = PLATFORM === 'win32';
export const IS_LINUX = PLATFORM === 'linux';
