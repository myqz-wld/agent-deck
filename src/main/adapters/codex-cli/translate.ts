/**
 * Codex SDK 事件 → agent-deck AgentEvent 翻译。
 *
 * 设计：纯翻译函数，调用方（sdk-bridge）传入 emit closure（已绑定 sessionId / agentId / source / ts）。
 *
 * 事件映射表（与 plan 一致）：
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
 * - item.updated{*}                  → 不发（避免增量噪音；用 item.completed 拿终态）
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
    case 'item.updated':
      // 噪音 / 由 sdk-bridge 单独处理 → 跳过
      return;

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
