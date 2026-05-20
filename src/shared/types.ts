/**
 * **shared/** category: **contract**（跨进程数据 schema barrel — 主 + renderer + preload
 * 三端共用的核心 type 定义入口）。
 *
 * 跨进程共享的核心类型 — barrel re-export。
 *
 * 实际定义按 domain 拆到 `./types/{agent,session,team,permission,file,summary,task,settings}.ts`。
 * 所有外部调用方继续 `from '@shared/types'`，等价命中本 barrel；不要去 import 子路径。
 *
 * 约束：所有定义在这里的类型必须只依赖标准库 / TS 自带能力，
 * 不能引入 Electron / Node 特有 API。
 *
 * **shared/ 边界约定**（R37 P3-J Step 4.7 — 详 ipc-channels.ts 顶部）：本文件属 **contract**。
 */

export * from './types/agent';
export * from './types/session';
export * from './types/team';
export * from './types/agent-deck-team';
export * from './types/permission';
export * from './types/file';
export * from './types/summary';
export * from './types/task';
export * from './types/settings';
export * from './types/assets';
export * from './types/attachment';
