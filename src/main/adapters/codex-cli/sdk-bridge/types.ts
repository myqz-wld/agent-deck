/**
 * 类型 — Codex SDK bridge（CHANGELOG_52 Step 4a / 第三轮大文件拆分）。
 *
 * 抽自 codex-cli/sdk-bridge.ts 顶部 interface 段。
 */
import type { Input, Thread } from '@openai/codex-sdk';
import type { AgentEvent } from '@shared/types';
import type { HookServer } from '@main/hook-server/server';

export interface CodexSessionHandle {
  sessionId: string;
}

export interface CodexBridgeOptions {
  emit: (e: AgentEvent) => void;
  /**
   * HookServer 实例引用（CHANGELOG_<X> R2 / B'4 + R1.A5 + R1.D7）。
   * lazy ref：bridge 构造时存指针，ensureCodex 调用时实时读 isRunning / mcpBearerToken /
   * listeningPort 计算 codex SDK config 字段（mcp_servers.agent-deck 自动注入）。
   *
   * Optional：null/undefined 时 codex 不挂 agent-deck MCP server（与 enableAgentDeckMcp
   * OFF 同语义）。便于单测注入 mock 或不挂场景。
   */
  hookServer?: HookServer;
}

export interface InternalSession {
  /** 真实 thread_id，第一次 thread.started 事件后写入。resume 路径在创建时就有。 */
  threadId: string | null;
  cwd: string;
  thread: Thread;
  /**
   * 待发送 user message 串行队列（同 thread 不能并发 turn）。
   *
   * 元素类型 `Input`（codex SDK 原生类型 = `string | UserInput[]`）：
   * - 纯文本消息：直接 push 字符串
   * - 带 attachments：push `[{type:'local_image', path}, ..., {type:'text', text}]`
   *   codex SDK 自己 fs 读 path（不像 Claude SDK 要主进程 readFile + base64 喂进队列），
   *   所以 codex 这边天然没有「base64 常驻队列内存」问题
   */
  pendingMessages: Input[];
  /** 当前正在跑的 turn 的 AbortController；中断时调用 abort() */
  currentTurn: AbortController | null;
  /** turn loop 是否在跑（避免 sendMessage 重复启动） */
  turnLoopRunning: boolean;
  /**
   * 已被外部关闭（closeSession / 30s timeout fallback）—— 进 abort 之前置 true。
   * runTurnLoop catch 看到此标记一律静默退出，**不**再 emit `finished/message`。
   * REVIEW_4 H1：旧版 closeSession 后 runTurnLoop catch 仍 emit finished:interrupted，
   * 该 finished `source='sdk'` 不被 dedup 跳过 → ensureRecord 把已删 session 复活成幽灵。
   * REVIEW_4 M5：30s timeout 路径也经历同一条 abort，旧版会先 emit finished:error
   * （resolveWithFallback 内）+ 再 emit finished:interrupted（runTurnLoop catch），双 finished。
   * 用户主动 interrupt（interruptSession）**不**置此标记 —— UI 仍要看到「已中断」反馈。
   */
  intentionallyClosed: boolean;
}

/**
 * 打包后 (.app) 内置 codex vendored 二进制的平台映射，照搬 @openai/codex-sdk
 * `PLATFORM_PACKAGE_BY_TARGET`（dist/index.js 145-150）。
 */
export interface BundledBinarySpec {
  /** @openai/ 下的子包目录名，与 PLATFORM_PACKAGE_BY_TARGET 的 value 去掉 '@openai/' 前缀对齐 */
  pkgDir: string;
  /** vendor 子目录的 target triple */
  triple: string;
  /** 二进制文件名（windows = codex.exe，其余 = codex） */
  binName: string;
}
