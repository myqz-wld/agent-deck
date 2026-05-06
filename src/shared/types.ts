/**
 * 跨进程共享的核心类型 — barrel re-export。
 *
 * 实际定义按 domain 拆到 `./types/{agent,session,team,permission,file,summary,task,settings}.ts`。
 * 所有外部调用方继续 `from '@shared/types'`，等价命中本 barrel；不要去 import 子路径。
 *
 * 约束：所有定义在这里的类型必须只依赖标准库 / TS 自带能力，
 * 不能引入 Electron / Node 特有 API。
 */

export * from './types/agent';
export * from './types/session';
export * from './types/team';
export * from './types/permission';
export * from './types/file';
export * from './types/summary';
export * from './types/task';
export * from './types/settings';
export * from './types/assets';
