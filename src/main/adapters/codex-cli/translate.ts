/**
 * Codex SDK 事件 → agent-deck AgentEvent 翻译。
 *
 * 设计：纯翻译函数，调用方（sdk-bridge）传入 emit closure（已绑定 sessionId / agentId / source / ts）。
 *
 * 事件映射表（CHANGELOG_<X> A1：打开 item.updated 工具类增量）：
 * - thread.started        → 不在这里发（sdk-bridge.createSession 拿到 thread_id 后单独发 session-start）
 * - turn.started          → 不发（噪音）
 * - turn.completed        → finished(ok:true, usage)
 * - turn.failed           → message(error) + finished(ok:false)
 * - error（流级别）       → message(error) + finished(ok:false)
 * - item.started{command_execution} → tool-use-start
 * - item.completed{command_execution} → tool-use-end
 * - item.completed{agent_message}    → message(role:assistant)
 * - item.completed{reasoning}        → thinking（Codex reasoning 与 Claude extended thinking 共用 ThinkingBubble，CHANGELOG_43）
 * - item.completed{file_change}      → file-changed × N（codex 不带 before/after，都填 null）
 * - item.started{mcp_tool_call}      → tool-use-start
 * - item.completed{mcp_tool_call}    → tool-use-end
 * - item.completed{web_search}       → tool-use-start + tool-use-end（一对，web_search 没有 started 事件）
 * - item.completed{todo_list}        → message(role:assistant, todoList)
 * - item.completed{error}            → message(error)（loader warning 子类含 'Ignoring malformed'
 *                                       走 console.warn 不 emit，详 translateItemCompleted error case）
 * - item.updated{command_execution}  → tool-use-start（同 toolUseId 重发，store dedup 替换 → UI 实时显示 aggregated_output 增长）
 * - item.updated{mcp_tool_call}      → tool-use-start（同上）
 * - item.updated{其他类型}           → 不发（agent_message / reasoning 文本增量去重复杂；file_change / web_search / todo_list 无 update 价值；error 终态 item.completed 已 cover）
 *
 * **store dedup 假设**（与 session-store.pushEvent 协同）：
 * 同 toolUseId 的多条 tool-use-start 在 renderer store 会按 toolUseId 替换，
 * 不会撑爆 RECENT_LIMIT（30）。本翻译函数不做节流，一切由 store 收口。
 */
import type {
  ThreadEvent,
  ThreadItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
} from '@openai/codex-sdk';
import type { AgentEventKind } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('codex-translate');

export type EmitFn = (kind: AgentEventKind, payload: unknown) => void;

/**
 * 中间态白名单 — codex CLI binary `strings` 抓出来的字面集合（plan
 * codex-stream-error-classify-20260521 §D1）。codex CLI 内置 5 次自动重连，每次
 * 重试通过 ThreadErrorEvent (`type: "error"`) 通知应用层「我断了」，但 codex CLI
 * **内部仍在恢复**。SDK d.ts 注释说 ThreadErrorEvent 是 unrecoverable，但 codex CLI
 * 实际行为是用它通知 recoverable 中间态，协议契约 vs 实际行为不一致 → 应用层必须识别区分。
 *
 * 不变量 1（plan §不变量）：未命中本白名单也未命中 STREAM_ERROR_HEURISTIC_RE 的事件
 * 走 fatal 路径不吞真错。
 */
const TRANSIENT_STREAM_ERROR_PHRASES = [
  'Reconnecting...',
  'stream disconnected before completion',
  'stream disconnected - retrying sampling request',
  'reconnecting:',
  'app-server event stream disconnected',
  'TCP Connection with remote is closed, trying to reconnect',
] as const;

/**
 * 启发式 regex — 白名单未命中时兜底（plan §D1 + REVIEW HIGH-1 修法）。
 *
 * **REVIEW HIGH-1 修法**（reviewer-claude/codex 双方独立 + 现场验证）: 修前
 * `/(retr|reconnect|disconnect)/i` 词根级匹配 `retrieving / retransmit / retrograde`
 * 等无关词,导致 codex binary ≥ 13 条真 fatal 字面（`Error retrieving credentials...`
 * / `failed to retrieve local addr` / `exec-server transport disconnected` / `Convert
 * it to UTF-8 and retry` / `Too many retransmissions` 等）被错归 transient → 不变量 1
 * 「不吞真错误」违反。
 *
 * 修后用 word-boundary 限定完整词形 `\b(retry|retrying|retried|reconnect|reconnecting|
 * reconnected|disconnect|disconnected|disconnecting)\b`,只匹配 transient 真正语义。
 * 仍漏匹配的 transient 字面（codex 升级换形）走 fatal 兜底，配 console.warn 留诊断信号。
 *
 * 不变量 5（plan §不变量）：协议向前兼容 — 即使 codex SDK / CLI 升级后字面变化，
 * 启发式层仍能兜底，**只要 transient 词形不变**。codex 改用「Connection failed
 * gracefully」类 transient 不含三词形 → 走保守 fatal（用户看到错误总比 turn stuck 好）。
 */
const STREAM_ERROR_HEURISTIC_RE =
  /\b(retry|retrying|retried|reconnect|reconnecting|reconnected|disconnect|disconnected|disconnecting)\b/i;

/**
 * 终态白名单 — codex CLI binary `strings` 抓出来的「真 fatal」字面集合（plan §D1
 * + REVIEW HIGH-1/HIGH-2 修法）。命中即 fatal,优先于 transient 白名单 + 启发式。
 *
 * **REVIEW HIGH-1 修法** (reviewer-claude/codex 双方独立 + grep ≥ 13 条真错样本):
 * 修前仅 `'max retry times reached'` 一条,把现实 codex binary 里的 `Error retrieving
 * credentials` / `failed to retrieve local addr` / `exec-server connection disconnected`
 * / `Convert it to UTF-8 and retry` 等 fatal 字面留给启发式吞 transient。修后扩到 12
 * 条覆盖 codex binary 实测 fatal 字面（凭证 / API key / 网络层 / exec-server / 配置 /
 * 编码 / 重传 / 重试用尽 全场景）。
 *
 * **REVIEW HIGH-2 修法**: `'exceeded retry limit'` 是 codex `codex-rs/codex-client/src/
 * retry.rs` 真终态字面,与 `, max retry times reached` 同等地位但旧 fatal regex
 * `/(max\s+retr|exhaust|gave\s+up)/i` 不匹配（`exceeded retry` 不含 `max`）→ 修前会被
 * 启发式吞 transient → fatal 漏抓。修后加进白名单 + 启发式 regex 加 `exceeded\s+retr`。
 *
 * 启发式 regex `STREAM_ERROR_FATAL_RE` 兜底 codex 升级换字面场景。
 */
const FATAL_STREAM_ERROR_PHRASES = [
  'max retry times reached',
  'exceeded retry limit',
  'Error retrieving',
  'could not retrieve',
  'Could not retrieve',
  'failed to retrieve',
  'Failed to retrieve',
  'exec-server connection disconnected',
  'exec-server transport disconnected',
  'disconnecting slow connection',
  'dropping message for disconnected',
  'Convert it to UTF-8',
  'Fix the config',
  'Too many retransmissions',
] as const;
const STREAM_ERROR_FATAL_RE =
  /(max\s+retr|exceeded\s+retr|exhaust|gave\s+up|maximum\s+retr)/i;

/**
 * 把 codex SDK ThreadErrorEvent.message 分类为 transient（中间态重连）或 fatal（真错误）。
 *
 * 决策树（plan §D1 + REVIEW HIGH-1/HIGH-2 修法）：
 * 1. 命中 FATAL_STREAM_ERROR_PHRASES 任一字面 / STREAM_ERROR_FATAL_RE → fatal（终态优先）
 * 2. 命中 TRANSIENT_STREAM_ERROR_PHRASES 任一字面 → transient（白名单严格匹配）
 * 3. 命中 STREAM_ERROR_HEURISTIC_RE → transient（启发式兜底 + console.warn 诊断信号）
 * 4. 都不命中 → fatal（不变量 1：保守走终态，不吞真错）
 *
 * 步骤 1 优先识别 fatal 防止 fatal 报文含 transient 词根（如 `exceeded retry limit`
 * 含 `retry` 词根但是终态）被错归 transient。**步骤 1 之后 transient 路径就只剩
 * 白名单/启发式 word-boundary 严格词形匹配**,不再撞 retrieving / retransmission 类
 * 假阳性（HIGH-1 修法的 word-boundary 直接根治）。
 *
 * 启发式命中（步骤 3）console.warn 是 plan §D1 设计要求 + REVIEW MED-1 修法
 * 落地：让 codex 升级换字面进入启发式时主进程日志可见,方便后续补白名单。
 *
 * 出参 `'transient' | 'fatal'`：
 * - transient → emit message no error + 不 emit finished（让 turn 继续等）
 * - fatal → emit message error + finished(ok:false, error)（原行为）
 */
export function classifyStreamErrorEvent(message: string): 'transient' | 'fatal' {
  if (FATAL_STREAM_ERROR_PHRASES.some((p) => message.includes(p))) return 'fatal';
  if (STREAM_ERROR_FATAL_RE.test(message)) return 'fatal';
  if (TRANSIENT_STREAM_ERROR_PHRASES.some((p) => message.includes(p))) return 'transient';
  if (STREAM_ERROR_HEURISTIC_RE.test(message)) {
    logger.warn(
      `[codex-cli/translate] heuristic-only transient match (consider adding to white-list): ${message}`,
    );
    return 'transient';
  }
  return 'fatal';
}

/**
 * 从 ThreadErrorEvent.message 里 best-effort 提取重连进度数字（如 `1/5`）。
 *
 * **REVIEW HIGH-3 修法** (reviewer-claude HIGH UX + reviewer-codex LOW): 修前
 * regex `/(\d+)\s*\/\s*(\d+)/` 无上下文锚点,会误抓任意「数字/数字」结构（日期前缀
 * `2026/05/21` / HTTP 序列 `503/502` / 路径段 `123/456` / IP 子网 `192.168.1.0/24`）
 * → 用户在 UI 看到「重连尝试 2026/05」之类乱码。
 *
 * 修后要求 `N/M` 紧邻 transient 关键词（`Reconnecting...` / `attempt` / `retry`）才
 * 提取,没匹配上返空字符串（caller 仍 emit「Codex 正在重连...」基础提示）。
 *
 * codex CLI 的格式样例（实测 user log）：
 *   `Reconnecting... 1/5 (stream disconnected before completion: ...)`
 */
export function extractRetryProgress(message: string): string {
  const m = message.match(/(?:Reconnecting\.\.\.|attempt|retry)\s+(\d+)\s*\/\s*(\d+)/i);
  if (!m) return '';
  return ` 重连尝试 ${m[1]}/${m[2]}`;
}

/**
 * 把一条 ThreadEvent 翻译为 0~N 条 AgentEvent，通过 emit 回调发出。
 *
 * 不在这里处理 thread.started（sessionId 同步在 sdk-bridge 控制）。
 *
 * @param opts.model plan model-token-stats §Phase 1 A4b：turn.completed 采集 token-usage 时
 *   写入的 model（codex event 不带 model，由 caller 从 sessions.model 取传入；null → 归一走 unknown）。
 */
export function translateCodexEvent(
  event: ThreadEvent,
  emit: EmitFn,
  opts?: { model?: string | null },
): void {
  switch (event.type) {
    case 'thread.started':
    case 'turn.started':
      // 噪音 / 由 sdk-bridge 单独处理 → 跳过
      return;

    case 'item.updated': {
      // CHANGELOG_<X> A1：仅转发有 toolUseId 的工具类（command_execution / mcp_tool_call）
      // 增量。同 toolUseId 重发 tool-use-start 让 renderer store 按 toolUseId dedup 替换，
      // UI 实时显示 aggregated_output / status 变化（典型场景：codex 跑 `npm test` 30 秒，
      // 用户能看到 stdout 一行一行涨）。其它 item 类型增量价值低 / 去重复杂 → 跳过。
      translateItemUpdated(event.item, emit);
      return;
    }

    case 'turn.completed': {
      emit('finished', { ok: true, subtype: 'success', usage: event.usage });
      // plan model-token-stats §Phase 1 A4：turn.completed 的 usage 是 per-turn 增量，独立 emit
      // token-usage（与 finished 解耦，§不变量 7）。codex Usage：input_tokens / cached_input_tokens /
      // output_tokens / reasoning_output_tokens；无 cache_creation（填 0）；reasoning 归入 output；
      // cacheRead = cached_input。model 由 caller 传（codex event 不带）。
      const u = event.usage;
      if (u) {
        emit('token-usage', {
          messageId: null, // codex 无 message id；每 turn 独立 INSERT（不参与 partial UNIQUE）
          model: opts?.model ?? null,
          inputTokens: u.input_tokens ?? 0,
          outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
          cacheReadTokens: u.cached_input_tokens ?? 0,
          cacheCreationTokens: 0,
        });
      }
      return;
    }

    case 'turn.failed': {
      emit('message', { text: `⚠ Codex 错误：${event.error.message}`, error: true });
      emit('finished', { ok: false, subtype: 'failed' });
      return;
    }

    case 'error': {
      // plan codex-stream-error-classify-20260521：codex CLI 5 次内置重连透中间态
      // 走 ThreadErrorEvent，应用层不能盲 emit finished:error 让 UI 状态机以为 turn 结束。
      // classifyStreamErrorEvent 三态分流：
      // - transient (中间重连态) → 1 条 message 不带 error，不 emit finished，让 turn 继续等
      // - fatal (真终态/重试用尽) → 原行为：1 条 message error + 1 条 finished(error)
      const classification = classifyStreamErrorEvent(event.message);
      if (classification === 'transient') {
        const progress = extractRetryProgress(event.message);
        emit('message', { text: `🔄 Codex 正在重连...${progress}` });
        return;
      }
      emit('message', { text: `⚠ Codex 流级错误：${event.message}`, error: true });
      emit('finished', { ok: false, subtype: 'error' });
      return;
    }

    case 'item.started': {
      translateItemStarted(event.item, emit);
      return;
    }

    case 'item.completed': {
      translateItemCompleted(event.item, emit);
      return;
    }
  }
}

function translateItemStarted(item: ThreadItem, emit: EmitFn): void {
  // 只对「过程式」工具发 tool-use-start，让活动流提前显示「正在执行 X」
  if (item.type === 'command_execution') {
    const i = item as CommandExecutionItem;
    emit('tool-use-start', {
      toolName: 'Bash',
      toolInput: { command: i.command },
      toolUseId: i.id,
    });
  } else if (item.type === 'mcp_tool_call') {
    const i = item as McpToolCallItem;
    emit('tool-use-start', {
      toolName: `mcp__${i.server}__${i.tool}`,
      toolInput: i.arguments,
      toolUseId: i.id,
    });
  }
  // agent_message / reasoning / file_change / web_search / todo_list / error
  // 等 item.completed 拿终态再发（避免 in-progress 状态下 UI 反复闪烁）
}

/**
 * item.updated 工具类增量翻译（CHANGELOG_<X> A1）。
 *
 * codex SDK 在 command 跑完前会推 N 条 item.updated（aggregated_output 渐进涨），
 * 我们重发 tool-use-start 同 toolUseId，让 store dedup 替换为最新一条。
 *
 * 与 translateItemStarted 区别：item.started 阶段 aggregated_output 通常空 / 仅刚启动；
 * item.updated 阶段 aggregated_output 已有部分输出。两阶段 emit 同形态 payload，
 * 但前者是新开槽位，后者是覆盖。
 *
 * payload 中带 `aggregatedOutput` / `exitCode` / `status` 字段（可选），让 UI 可显示运行进度。
 * 不带 toolInput.command —— item.started 已带，store 替换会覆盖丢失，
 * 但 UI 端用 toolStartByUseId Map 取「同 toolUseId 最早一条」（实际取最新，但 command 不变）即可。
 *
 * 实际 store 替换后 UI 拿到的 payload 形如：
 *   { toolName: 'Bash', toolInput: {command}, toolUseId, aggregatedOutput: 'foo\nbar\n', status: 'in_progress' }
 */
function translateItemUpdated(item: ThreadItem, emit: EmitFn): void {
  if (item.type === 'command_execution') {
    const i = item as CommandExecutionItem;
    emit('tool-use-start', {
      toolName: 'Bash',
      toolInput: { command: i.command },
      toolUseId: i.id,
      aggregatedOutput: i.aggregated_output,
      status: i.status,
      ...(i.exit_code != null ? { exitCode: i.exit_code } : {}),
    });
  } else if (item.type === 'mcp_tool_call') {
    const i = item as McpToolCallItem;
    emit('tool-use-start', {
      toolName: `mcp__${i.server}__${i.tool}`,
      toolInput: i.arguments,
      toolUseId: i.id,
      status: i.status,
    });
  }
  // 其他 item 类型增量不发：
  // - agent_message / reasoning：文本增量去重复杂（无 toolUseId 锚点）
  // - file_change / web_search / todo_list：item.completed 拿终态足够
  // - error：item.completed 已 cover
}

function translateItemCompleted(item: ThreadItem, emit: EmitFn): void {
  switch (item.type) {
    case 'agent_message': {
      emit('message', { text: item.text, role: 'assistant' });
      return;
    }

    case 'reasoning': {
      // Codex reasoning 摘要 → 'thinking' event，与 Claude extended thinking 走同一渲染通道
      // （ThinkingBubble 弱化样式 + 头部 thinking 标签）。CHANGELOG_43 统一约定。
      emit('thinking', { text: item.text });
      return;
    }

    case 'command_execution': {
      const i = item as CommandExecutionItem;
      emit('tool-use-end', {
        toolUseId: i.id,
        toolName: 'Bash',
        toolResult: i.aggregated_output,
        exitCode: i.exit_code,
        status: i.status,
      });
      return;
    }

    case 'file_change': {
      // codex 的 file_change.changes 不含 before/after 文本，只告诉「这些路径动了 / 怎么动」
      // before/after 都填 null，UI 的 DiffViewer 会兜底显示「文件已修改」+ changeKind
      const i = item as FileChangeItem;
      for (const change of i.changes) {
        emit('file-changed', {
          filePath: change.path,
          kind: 'text',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: change.kind, // 'add' | 'delete' | 'update'
            patchStatus: i.status, // 'completed' | 'failed'
          },
          toolCallId: i.id,
        });
      }
      return;
    }

    case 'mcp_tool_call': {
      const i = item as McpToolCallItem;
      emit('tool-use-end', {
        toolUseId: i.id,
        toolName: `mcp__${i.server}__${i.tool}`,
        toolResult: i.result?.content,
        error: i.error?.message,
        status: i.status,
      });
      return;
    }

    case 'web_search': {
      // codex 的 web_search 只在 item.completed 时一次性出，没有 started 事件
      // 补一对 start/end，让活动流时间线完整（toolName 用 'WebSearch' 与 claude code 对齐）
      emit('tool-use-start', {
        toolName: 'WebSearch',
        toolInput: { query: item.query },
        toolUseId: item.id,
      });
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'WebSearch',
        toolResult: { query: item.query },
        status: 'completed',
      });
      return;
    }

    case 'todo_list': {
      // 不是 plan mode，是 codex 内部 to-do 进度的展示。把当前清单作为一条 assistant message 发
      // UI 兜底渲染 text；后续可识别 todoList 字段做更漂亮的清单卡片
      const lines = item.items.map((t) => `- [${t.completed ? 'x' : ' '}] ${t.text}`);
      emit('message', {
        text: `📋 任务清单：\n${lines.join('\n')}`,
        role: 'assistant',
        todoList: item.items,
      });
      return;
    }

    case 'error': {
      // REVIEW_60 R2 MED-Lead-1 修法 (lead 现场发现 + codex SDK ErrorItem 类型铁证):
      // codex SDK 0.131 ErrorItem (index.d.ts:83-87 "Describes a non-fatal error surfaced as an item")
      // 包含两类:
      //   ① codex CLI 启动期间 loader warning (典型: 用户 ~/.codex/agents/*.toml schema 不对
      //      "Ignoring malformed agent role definition: failed to deserialize ... invalid type:
      //      map, expected a string" — 完全是用户配置问题,与应用层 / sdk-bridge / 当前 review
      //      scope 无关,且 codex CLI 每次 turn 可能反复扫 agents dir 重 emit 同款噪声)
      //   ② 真 turn-level error (codex CLI 跑工具 / agent 时捕获的中间错误,turn 仍能继续)
      // 旧实现把两类无差别 emit `error: true` 红 bubble: 用户实测截图 spawn reviewer-codex 时
      // codex CLI 反复扫 .codex/agents/ 目录 emit 15 条 loader warning 红 bubble (5 文件 × 3 turn),
      // 严重污染 SessionDetail UI + 误导用户以为 reviewer / 应用出问题。
      // 修法: 关键词 filter 类 ① 走 console.warn 应用日志保留诊断 + 不污染 UI;类 ② 维持原 emit
      // 行为给用户看到真 turn-level 错误。pattern 取代表性短语 — 与 codex CLI loader 错误前缀对齐
      // (源自 codex-rs core/src/agent_role/ 加载逻辑实测前缀)。
      // **REVIEW_80 LOW 修法（reviewer-codex + reviewer-claude 双方独立同向）**:
      // 修前 LOADER_WARNING_PATTERNS 用 `.some(includes)` OR 任一命中 → `'failed to deserialize'`
      // 是 serde 通用短语（codex 跑工具拿到畸形 JSON / MCP tool result 反序列化失败等**真
      // turn-level 错误**也含此短语）单独命中即被静默吞掉,用户看不到真错。
      // 真实 loader warning 形如 "Ignoring malformed agent role definition: failed to deserialize
      // ... invalid type: map" — `'Ignoring malformed'` 前缀是 loader 专属锚点（agent-role
      // 加载逻辑 codex-rs core/src/agent_role/ 输出),且与 `failed to deserialize` 同句共现。
      // 修后要求 loader 专属锚点 `'Ignoring malformed'` 命中才 suppress UI emit;只含
      // `failed to deserialize` 不含 loader 锚点的真 turn-level error 走下方 emit error 给用户看。
      const isLoaderWarning = item.message.includes('Ignoring malformed');
      if (isLoaderWarning) {
        // 5 天 264 次同 8 个 .codex/agents/*.toml (user 另一项目 hilo-agent-opencode),
        // codex CLI loader 反复扫目录重复 emit, warn 级别把磁盘日志灌成无诊断价值噪声。
        // UI emit 已 REVIEW_80 修过(前缀 'Ignoring malformed' 命中即不 emit), 留 logger 仅
        // 为 dev 终端 console 留痕 → 降 debug(file transport 默认 info 不收)。
        // 日志内容(message + 完整文本)保留不动, 不缩成前缀, debug 下 dev 端仍可看全句。
        logger.debug(
          '[codex-translate] codex CLI loader warning skipped UI emit:',
          item.message,
        );
        return;
      }
      // 真 turn-level 非致命 ErrorItem (codex CLI 内部捕获到的错误,但 turn 仍能继续)
      emit('message', { text: `⚠ ${item.message}`, error: true });
      return;
    }
  }
}
