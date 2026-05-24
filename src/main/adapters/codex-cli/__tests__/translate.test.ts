/**
 * codex-cli/translate 单测（CHANGELOG_<X> A8）。
 *
 * 覆盖 translateCodexEvent 把 ThreadEvent / ThreadItem 翻译为 AgentEvent 的各种类型，
 * 重点 regression case：
 * - A1：item.updated 工具类增量打开（command_execution / mcp_tool_call 重发 tool-use-start
 *   带 aggregatedOutput / status / exitCode；其它 item 类型 update 跳过）
 * - 既有事件映射不破（item.completed agent_message / reasoning / file_change /
 *   web_search / todo_list / error / command_execution / mcp_tool_call 全覆盖）
 * - turn.failed / 流级 error / turn.completed
 *
 * 不覆盖：thread.started（由 sdk-bridge 单独处理，不走 translate）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { translateCodexEvent } from '../translate';

function collect() {
  const events: { kind: string; payload: unknown }[] = [];
  return {
    emit: (kind: string, payload: unknown) => events.push({ kind, payload }),
    events,
  };
}

describe('translateCodexEvent', () => {
  describe('skipped events', () => {
    it('skips thread.started', () => {
      const { emit, events } = collect();
      translateCodexEvent({ type: 'thread.started', thread_id: 'tid' } as ThreadEvent, emit);
      expect(events).toEqual([]);
    });

    it('skips turn.started', () => {
      const { emit, events } = collect();
      translateCodexEvent({ type: 'turn.started' } as ThreadEvent, emit);
      expect(events).toEqual([]);
    });
  });

  describe('turn lifecycle', () => {
    it('turn.completed → finished(ok:true) with usage', () => {
      const { emit, events } = collect();
      const usage = { input_tokens: 100, output_tokens: 50 };
      translateCodexEvent(
        { type: 'turn.completed', usage } as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'finished',
        payload: { ok: true, subtype: 'success', usage },
      });
    });

    it('turn.failed → message(error) + finished(ok:false,failed)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'turn.failed',
          error: { message: 'API quota exceeded' },
        } as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'message',
        payload: { error: true },
      });
      expect((events[0].payload as { text: string }).text).toMatch(/API quota exceeded/);
      expect(events[1]).toEqual({
        kind: 'finished',
        payload: { ok: false, subtype: 'failed' },
      });
    });

    it('error (fatal stream-level, e.g. JSON parse failed) → message(error) + finished(ok:false,error)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        { type: 'error', message: 'JSON parse failed' } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(2);
      expect((events[0].payload as { text: string }).text).toMatch(/JSON parse failed/);
      expect(events[1].payload).toEqual({ ok: false, subtype: 'error' });
    });

    // plan codex-stream-error-classify-20260521 §D4 + REVIEW HIGH-1/HIGH-2/HIGH-3
    // + MED-2/MED-3 修法：codex CLI 5 次内置重连透中间态走 ThreadErrorEvent，应用层
    // 不能盲 emit finished:error 让 UI 状态机以为 turn 结束。以下 case 锁住三态分类
    // 契约（white-list / 启发式 / fatal 保守）+ HIGH-1 真 fatal regression（避免
    // retrieving / disconnect 系列被启发式吞 transient）。
    describe('error (transient — codex CLI internal reconnect)', () => {
      it('C1: bare "Reconnecting... " → 1 message no error, no finished', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          { type: 'error', message: 'Reconnecting... ' } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('message');
        expect((events[0].payload as { text: string; error?: boolean }).text).toContain('正在重连');
        // 关键：transient 路径不带 error: true，不 emit finished
        expect((events[0].payload as { error?: boolean }).error).toBeUndefined();
      });

      it('C2: with N/M progress → extracted into label', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message:
              'Reconnecting... 1/5 (stream disconnected before completion: ' +
              'The system is currently experiencing high demand...)',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(1);
        expect((events[0].payload as { text: string }).text).toContain('1/5');
        expect((events[0].payload as { error?: boolean }).error).toBeUndefined();
      });

      it('C3: "stream disconnected - retrying sampling request" → transient', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message:
              'stream disconnected - retrying sampling request (responseStreamDisconnected)',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('message');
        expect((events[0].payload as { error?: boolean }).error).toBeUndefined();
      });

      it('C4: heuristic fallback — no white-list match but word-boundary "retry" hit → transient + console.warn', () => {
        // REVIEW MED-1 修法：plan §D1 设计要求启发式命中 console.warn 留诊断信号。
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const { emit, events } = collect();
          translateCodexEvent(
            {
              type: 'error',
              // 不含白名单字面但含完整词形 retry — 启发式命中 word-boundary
              message: 'Some random retry attempt notice from future codex version',
            } as unknown as ThreadEvent,
            emit,
          );
          expect(events).toHaveLength(1);
          expect((events[0].payload as { error?: boolean }).error).toBeUndefined();
          // 启发式命中必须 console.warn（plan §D1 设计要求）
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy.mock.calls[0][0]).toContain('heuristic-only transient match');
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('C13: date prefix "[2026/05/21 14:32:25] Reconnecting... 1/5 (...)" → extracts 1/5 not 2026/05', () => {
        // REVIEW HIGH-3 修法 regression：extractRetryProgress 加 transient 关键词锚点后
        // 应该提取 Reconnecting... 后的 1/5，不是日期前缀的 2026/05
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message:
              '[2026/05/21 14:32:25] Reconnecting... 1/5 (stream disconnected before completion: ...)',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(1);
        const text = (events[0].payload as { text: string }).text;
        expect(text).toContain('1/5');
        expect(text).not.toContain('2026/05'); // 不能误抓日期
      });
    });

    describe('error (fatal — true terminal failures)', () => {
      it('C6: "max retry times reached" → message(error) + finished(error) (overrides transient white-list co-occurrence)', () => {
        const { emit, events } = collect();
        // 故意构造同时含 disconnect 词 + max retry 字面（codex CLI 重试用尽时同条 message 常见）
        translateCodexEvent(
          {
            type: 'error',
            message: 'stream disconnected before completion, max retry times reached',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(2);
        expect((events[0].payload as { error?: boolean }).error).toBe(true);
        expect(events[1].kind).toBe('finished');
        expect(events[1].payload).toEqual({ ok: false, subtype: 'error' });
      });

      it('C7: heuristic miss (no retry/reconnect/disconnect word) → conservative fatal (no console.warn)', () => {
        // REVIEW HIGH-1 修法：word-boundary 严格词形,「lost / falling」类词不命中启发式
        // → 走保守 fatal,不变量 1 不吞真错。同时验证不撞 console.warn（防 regression）
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const { emit, events } = collect();
          translateCodexEvent(
            {
              type: 'error',
              message: 'connection lost - falling back to local mode',
            } as unknown as ThreadEvent,
            emit,
          );
          expect(events).toHaveLength(2);
          expect((events[0].payload as { error?: boolean }).error).toBe(true);
          expect(events[1].kind).toBe('finished');
          // fatal 路径不走启发式 console.warn 分支
          expect(warnSpy).not.toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
        }
      });

      // C8-C12: REVIEW HIGH-1 真 fatal regression — 修前 word-root `retr/disconnect`
      // 启发式吞这些字面成 transient 让 UI 永远 working / turn stuck。修后 word-boundary
      // 词形匹配 + fatal 白名单优先识别。codex binary `strings` 真字面铁证。
      it('C8: "Unexpected error retrieving API key: ..." → fatal (real auth error)', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message: 'Unexpected error retrieving API key: 401 Unauthorized',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(2);
        expect((events[0].payload as { error?: boolean }).error).toBe(true);
        expect(events[1].kind).toBe('finished');
      });

      it('C9: "exec-server connection disconnected: pipe broken" → fatal (real ipc error)', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message: 'exec-server connection disconnected: pipe broken',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(2);
        expect((events[0].payload as { error?: boolean }).error).toBe(true);
        expect(events[1].kind).toBe('finished');
      });

      it('C10: "exceeded retry limit, last status: 503" → fatal (real terminal not transient)', () => {
        // REVIEW HIGH-2 regression：codex CLI 真终态字面，与 max retry times reached 同源但
        // 旧 fatal regex /(max\s+retr|...)/  不匹配 → 修前会被启发式吞 transient
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message: 'exceeded retry limit, last status: 503',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(2);
        expect((events[0].payload as { error?: boolean }).error).toBe(true);
        expect(events[1].kind).toBe('finished');
      });

      it('C11: "failed to retrieve local addr from established conn" → fatal (real network error)', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message:
              "failed to retrieve local addr from established conn, use default '0.0.0.0:0'",
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(2);
        expect((events[0].payload as { error?: boolean }).error).toBe(true);
        expect(events[1].kind).toBe('finished');
      });

      it('C12: "Convert it to UTF-8 and retry" → fatal (real config-fix-required error)', () => {
        const { emit, events } = collect();
        translateCodexEvent(
          {
            type: 'error',
            message: 'Convert it to UTF-8 and retry.',
          } as unknown as ThreadEvent,
          emit,
        );
        expect(events).toHaveLength(2);
        expect((events[0].payload as { error?: boolean }).error).toBe(true);
        expect(events[1].kind).toBe('finished');
      });
    });
  });

  describe('item.started (only command_execution / mcp_tool_call get tool-use-start)', () => {
    it('command_execution → tool-use-start with toolName=Bash', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.started',
          item: {
            id: 'ce-1',
            type: 'command_execution',
            command: 'npm test',
            aggregated_output: '',
            status: 'in_progress',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([
        {
          kind: 'tool-use-start',
          payload: {
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolUseId: 'ce-1',
          },
        },
      ]);
    });

    it('mcp_tool_call → tool-use-start with mcp__server__tool name', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.started',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'agent-deck',
            tool: 'task_create',
            arguments: { subject: 'X' },
            status: 'in_progress',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'tool-use-start',
        payload: {
          toolName: 'mcp__agent-deck__task_create',
          toolInput: { subject: 'X' },
          toolUseId: 'mcp-1',
        },
      });
    });

    it('agent_message at item.started → no event (wait for completed)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.started',
          item: { id: 'a-1', type: 'agent_message', text: 'partial' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([]);
    });
  });

  describe('item.updated (CHANGELOG A1: 仅工具类增量重发 tool-use-start)', () => {
    it('command_execution updated → tool-use-start with aggregatedOutput / status', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.updated',
          item: {
            id: 'ce-1',
            type: 'command_execution',
            command: 'npm test',
            aggregated_output: 'PASS test/foo.spec.ts\n',
            status: 'in_progress',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'tool-use-start',
        payload: {
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
          toolUseId: 'ce-1',
          aggregatedOutput: 'PASS test/foo.spec.ts\n',
          status: 'in_progress',
        },
      });
    });

    it('command_execution updated with exit_code → tool-use-start includes exitCode', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.updated',
          item: {
            id: 'ce-2',
            type: 'command_execution',
            command: 'false',
            aggregated_output: '',
            exit_code: 1,
            status: 'completed',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events[0].payload).toMatchObject({
        toolUseId: 'ce-2',
        status: 'completed',
        exitCode: 1,
      });
    });

    it('mcp_tool_call updated → tool-use-start with status', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.updated',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'agent-deck',
            tool: 'spawn_session',
            arguments: { adapter: 'claude-code' },
            status: 'in_progress',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        toolName: 'mcp__agent-deck__spawn_session',
        toolUseId: 'mcp-1',
        status: 'in_progress',
      });
    });

    it('agent_message updated → no event (text 增量去重复杂，跳过)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.updated',
          item: { id: 'a-1', type: 'agent_message', text: 'partial text' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([]);
    });

    it('reasoning updated → no event', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.updated',
          item: { id: 'r-1', type: 'reasoning', text: 'thinking...' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([]);
    });

    it('file_change updated → no event (终态 item.completed 已 cover)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.updated',
          item: {
            id: 'f-1',
            type: 'file_change',
            changes: [{ path: '/x.ts', kind: 'add' }],
            status: 'in_progress',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([]);
    });
  });

  describe('item.completed', () => {
    it('agent_message → message(role:assistant)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: { id: 'a-1', type: 'agent_message', text: 'Hello' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([
        { kind: 'message', payload: { text: 'Hello', role: 'assistant' } },
      ]);
    });

    it('reasoning → thinking', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: { id: 'r-1', type: 'reasoning', text: 'considered X' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([{ kind: 'thinking', payload: { text: 'considered X' } }]);
    });

    it('command_execution → tool-use-end with status / exitCode', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 'ce-1',
            type: 'command_execution',
            command: 'echo hi',
            aggregated_output: 'hi\n',
            exit_code: 0,
            status: 'completed',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toEqual([
        {
          kind: 'tool-use-end',
          payload: {
            toolUseId: 'ce-1',
            toolName: 'Bash',
            toolResult: 'hi\n',
            exitCode: 0,
            status: 'completed',
          },
        },
      ]);
    });

    it('file_change → file-changed × N (codex 不带 before/after，都 null)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 'f-1',
            type: 'file_change',
            changes: [
              { path: '/a.ts', kind: 'add' },
              { path: '/b.ts', kind: 'update' },
            ],
            status: 'completed',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'file-changed',
        payload: {
          filePath: '/a.ts',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: 'add',
            patchStatus: 'completed',
          },
          toolCallId: 'f-1',
        },
      });
      expect((events[1].payload as { filePath: string }).filePath).toBe('/b.ts');
    });

    it('mcp_tool_call → tool-use-end with mcp__server__tool name + result', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'agent-deck',
            tool: 'task_list',
            arguments: {},
            result: { content: [{ type: 'text', text: '[]' }] },
            status: 'completed',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        toolUseId: 'mcp-1',
        toolName: 'mcp__agent-deck__task_list',
        status: 'completed',
      });
    });

    it('mcp_tool_call failed → tool-use-end with error.message', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 'mcp-2',
            type: 'mcp_tool_call',
            server: 'agent-deck',
            tool: 'task_create',
            arguments: {},
            error: { message: 'subject required' },
            status: 'failed',
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events[0].payload).toMatchObject({
        status: 'failed',
        error: 'subject required',
      });
    });

    it('web_search → tool-use-start + tool-use-end pair (no started event)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: { id: 'ws-1', type: 'web_search', query: 'codex SDK docs' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: 'tool-use-start',
        payload: { toolName: 'WebSearch', toolUseId: 'ws-1' },
      });
      expect(events[1]).toMatchObject({
        kind: 'tool-use-end',
        payload: { toolName: 'WebSearch', toolUseId: 'ws-1', status: 'completed' },
      });
    });

    it('todo_list → message with todoList payload', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 't-1',
            type: 'todo_list',
            items: [
              { text: 'A', completed: true },
              { text: 'B', completed: false },
            ],
          },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        role: 'assistant',
        todoList: [
          { text: 'A', completed: true },
          { text: 'B', completed: false },
        ],
      });
      expect((events[0].payload as { text: string }).text).toMatch(/\[x\] A/);
      expect((events[0].payload as { text: string }).text).toMatch(/\[ \] B/);
    });

    it('error item → message(error)', () => {
      const { emit, events } = collect();
      translateCodexEvent(
        {
          type: 'item.completed',
          item: { id: 'e-1', type: 'error', message: 'Network timeout' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ error: true });
      expect((events[0].payload as { text: string }).text).toMatch(/Network timeout/);
    });
  });

  describe('emit closure isolation', () => {
    it('does not call emit when no event is produced', () => {
      const emit = vi.fn();
      translateCodexEvent({ type: 'thread.started', thread_id: 'tid' } as ThreadEvent, emit);
      translateCodexEvent({ type: 'turn.started' } as ThreadEvent, emit);
      translateCodexEvent(
        {
          type: 'item.updated',
          item: { id: 'a', type: 'agent_message', text: 'partial' },
        } as unknown as ThreadEvent,
        emit,
      );
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
