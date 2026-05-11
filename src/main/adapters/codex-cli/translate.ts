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
 * - item.completed{reasoning}        → thinking（GPT-5 reasoning 与 Claude extended thinking 共用 ThinkingBubble，CHANGELOG_43）
 * - item.completed{file_change}      → file-changed × N（codex 不带 before/after，都填 null）
 * - item.started{mcp_tool_call}      → tool-use-start
 * - item.completed{mcp_tool_call}    → tool-use-end
 * - item.completed{web_search}       → tool-use-start + tool-use-end（一对，web_search 没有 started 事件）
 * - item.completed{todo_list}        → message(role:assistant, todoList)
 * - item.completed{error}            → message(error)
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

export type EmitFn = (kind: AgentEventKind, payload: unknown) => void;

/**
 * 把一条 ThreadEvent 翻译为 0~N 条 AgentEvent，通过 emit 回调发出。
 *
 * 不在这里处理 thread.started（sessionId 同步在 sdk-bridge 控制）。
 */
export function translateCodexEvent(event: ThreadEvent, emit: EmitFn): void {
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
      return;
    }

    case 'turn.failed': {
      emit('message', { text: `⚠ Codex 错误：${event.error.message}`, error: true });
      emit('finished', { ok: false, subtype: 'failed' });
      return;
    }

    case 'error': {
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
      // GPT-5 reasoning 摘要 → 'thinking' event，与 Claude extended thinking 走同一渲染通道
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
      // 非致命的 ErrorItem（codex CLI 内部捕获到的错误，但 turn 仍能继续）
      emit('message', { text: `⚠ ${item.message}`, error: true });
      return;
    }
  }
}
