import { useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  DiffPayload,
  ExitPlanModeRequest,
  ImageSource,
  PermissionRequest,
} from '@shared/types';
import { isImageTool } from '@shared/mcp-tools';
import { DiffViewer } from '../diff/DiffViewer';
import { MarkdownText } from '../MarkdownText';

/**
 * 三个待处理「行」组件 + 一个 toolInput → DiffPayload 转换 helper，
 * 同时被 ActivityFeed（活动流时间线）与 PendingTab（集中待处理面板）复用。
 *
 * 历史：原本三个 Row 与 toolInputToDiff 都是 ActivityFeed.tsx 的内部函数。
 * 增加 PendingTab 之后需要跨文件复用，搬到此处统一 export，逻辑零改动。
 *
 * 三个 Row 的接口均以 (event, payload, sessionId, agentId, isSdk, stillPending,
 * wasCancelled, onResolved) 为入参；event 仅用于显示时间戳（event.ts）。
 * stillPending=true 表示此 row 仍可响应，false 时按钮区域降级为「已响应 / 已取消」状态。
 * wasCancelled=true 区分「SDK 主动取消」与「用户已响应」，用于灰度文案与样式。
 *
 * onResolved 由调用方提供：通常是 store 的 resolveX(sessionId, requestId)，
 * Row 内部调 window.api.respondX 完成响应后调用，让 store 同步删掉 pending 列表里这条。
 */

// ───────────────────────── 权限请求行（内嵌按钮 + diff）

export function PermissionRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: PermissionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const diff = toolInputToDiff(payload.toolName, payload.toolInput);

  const respond = async (decision: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (!isSdk || !stillPending) return;
    setBusy(true);
    try {
      await window.api.respondPermission(agentId, sessionId, payload.requestId, {
        decision,
        message: decision === 'deny' ? '用户拒绝' : undefined,
        updatedInput: decision === 'allow' ? payload.toolInput : undefined,
        updatedPermissions: alwaysAllow ? payload.suggestions : undefined,
      });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  // 三态：等待中 / 已被 SDK 取消 / 已响应（用户主动 allow|deny）
  // 「已取消」整张更暗（opacity-50），左侧细色条提示这条是 SDK 放弃的，不是用户操作；
  // 「已响应」保持原样的 70% 透明 + 中性灰描边（用户已经处理过的痕迹，不强调）
  const settled = !stillPending;
  const cardClass = stillPending
    ? 'border-status-waiting/40 bg-status-waiting/10'
    : wasCancelled
      ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
      : 'border-deck-border/60 bg-white/[0.02] opacity-70';
  const statusText = stillPending
    ? '⚠ 等待授权'
    : wasCancelled
      ? '🚫 已被 SDK 取消'
      : '✅ 已响应';
  const statusColor = stillPending
    ? 'text-status-waiting'
    : wasCancelled
      ? 'text-deck-muted/70'
      : 'text-status-working/80';

  return (
    <li className={`rounded-md border p-2 text-[11px] ${cardClass}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className={statusColor}>{statusText}</span>
        <span className="font-mono">{payload.toolName}</span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('allow')}
              className="rounded bg-status-working/30 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
            >
              允许本次
            </button>
            {payload.suggestions ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void respond('allow', true)}
                className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25 disabled:opacity-50"
              >
                始终允许
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('deny')}
              className="rounded bg-status-waiting/30 px-2 py-0.5 text-[10px] text-status-waiting hover:bg-status-waiting/40 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        )}
      </div>
      {diff ? (
        <div className="h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      ) : (
        <pre className="max-h-24 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {JSON.stringify(payload.toolInput, null, 2)}
        </pre>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">外部 CLI 会话无法在此回应</div>
      )}
      {settled && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          Claude 主动放弃了这次请求（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}

// ───────────────────────── AskUserQuestion 行（内嵌选项）

export function AskRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: AskUserQuestionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [selections, setSelections] = useState<Record<string, { selected: string[]; other?: string }>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const totalQuestions = payload.questions.length;
  const answeredCount = payload.questions.reduce((acc, q) => {
    const cur = selections[q.question];
    const hasSel = (cur?.selected.length ?? 0) > 0;
    const hasOther = (cur?.other ?? '').trim().length > 0;
    return acc + (hasSel || hasOther ? 1 : 0);
  }, 0);
  const canSubmit = answeredCount === totalQuestions;

  const toggle = (q: AskUserQuestionItem, label: string): void => {
    setSelections((prev) => {
      const cur = prev[q.question] ?? { selected: [], other: undefined };
      const has = cur.selected.includes(label);
      const nextSel = q.multiSelect
        ? has
          ? cur.selected.filter((s) => s !== label)
          : [...cur.selected, label]
        : has
          ? []
          : [label];
      return { ...prev, [q.question]: { selected: nextSel, other: cur.other } };
    });
  };

  const setOther = (q: AskUserQuestionItem, value: string): void => {
    setSelections((prev) => {
      const cur = prev[q.question] ?? { selected: [], other: undefined };
      return { ...prev, [q.question]: { selected: cur.selected, other: value } };
    });
  };

  const submit = async (): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      const answers = payload.questions.map((q) => {
        const cur = selections[q.question] ?? { selected: [], other: undefined };
        return { question: q.question, selected: cur.selected, other: cur.other };
      });
      await window.api.respondAskUserQuestion(agentId, sessionId, payload.requestId, { answers });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? '❓ Claude 在询问你'
            : wasCancelled
              ? '🚫 提问已被取消'
              : '✅ 已回答'}
        </span>
        {stillPending && (
          <span className="text-deck-muted/80">
            已选 {answeredCount}/{totalQuestions}
          </span>
        )}
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <button
            type="button"
            disabled={busy || answeredCount === 0}
            onClick={() => void submit()}
            title={canSubmit ? '提交回答' : '尚有题目未选，仍可提交（未选项保持空答）'}
            className="ml-auto rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交回答
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {payload.questions.map((q, qi) => {
          const sel = selections[q.question]?.selected ?? [];
          return (
            <div key={qi}>
              <div className="mb-1 text-[11px] text-deck-text">{q.question}</div>
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt) => {
                  const isSel = sel.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={!isSdk || !stillPending || busy}
                      onClick={() => toggle(q, opt.label)}
                      title={opt.description}
                      className={`rounded border px-2 py-0.5 text-[10px] disabled:opacity-50 ${
                        isSel
                          ? 'border-status-working/60 bg-status-working/30 text-status-working'
                          : 'border-deck-border bg-white/[0.04] text-deck-muted hover:bg-white/[0.08]'
                      }`}
                    >
                      {q.multiSelect && <span className="mr-1">{isSel ? '☑' : '☐'}</span>}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                value={selections[q.question]?.other ?? ''}
                onChange={(e) => setOther(q, e.target.value)}
                placeholder="其他（可选）"
                disabled={!isSdk || !stillPending || busy}
                className="mt-1 w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
              />
            </div>
          );
        })}
      </div>
      {stillPending && isSdk && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[10px] text-deck-muted">
            {canSubmit ? '已选满，可提交' : `还有 ${totalQuestions - answeredCount} 题未选`}
          </span>
          <button
            type="button"
            disabled={busy || answeredCount === 0}
            onClick={() => void submit()}
            className="rounded bg-status-working px-3 py-1 text-[11px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交回答
          </button>
        </div>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">外部 CLI 会话无法在此回应</div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          Claude 主动取消了这次提问（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}

// ───────────────────────── ExitPlanMode 行（markdown plan + 二选一按钮）

export function ExitPlanRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: ExitPlanModeRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  // 「继续规划」时可选反馈输入框，默认折叠；点了「继续规划」按钮且 feedback 为空时，
  // 展开输入框让用户可以补充意见再确认；如果用户已写过反馈直接发送，跳过 confirm 步骤。
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const plan = payload.plan ?? '';

  const respond = async (decision: 'approve' | 'keep-planning'): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      await window.api.respondExitPlanMode(agentId, sessionId, payload.requestId, {
        decision,
        feedback: decision === 'keep-planning' ? feedback.trim() || undefined : undefined,
      });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  // 「继续规划」按钮：第一次点击展开反馈框（如果还没展开），第二次/已有反馈直接提交。
  // 实战体验：避免每次都强制弹输入框（用户大概率没意见也想直接驳回），
  // 但提供一个「写明白哪儿不满意」的入口，比一句空 deny 让 Claude 瞎猜要好。
  const onClickKeepPlanning = (): void => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    void respond('keep-planning');
  };

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? '📋 Claude 提议了一个执行计划'
            : wasCancelled
              ? '🚫 计划批准已被取消'
              : '✅ 已处理'}
        </span>
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <div className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('approve')}
              title="批准计划，让 Claude 退出 plan mode 开始执行"
              className="rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              批准计划，开始执行
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClickKeepPlanning}
              title={
                showFeedback
                  ? feedback.trim()
                    ? '把反馈发给 Claude，让它修改计划'
                    : '不写反馈也可以，Claude 会主动询问需要补充哪方面'
                  : '让 Claude 留在 plan mode 继续修改计划（点击后可写反馈）'
              }
              className="rounded border border-deck-border bg-white/[0.06] px-2.5 py-0.5 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-50"
            >
              继续规划
            </button>
          </div>
        )}
      </div>
      <div className="rounded border border-deck-border/40 bg-black/20 p-2">
        <MarkdownText text={plan || '(plan 内容为空)'} />
      </div>
      {stillPending && isSdk && showFeedback && (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-[10px] text-deck-muted">
            可选：告诉 Claude 哪里需要调整（留空也能提交）
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="比如：步骤 3 不要改 main 进程；先做 UI 验证再写 SDK..."
            rows={2}
            disabled={busy}
            className="w-full resize-none rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowFeedback(false);
                setFeedback('');
              }}
              className="rounded px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/5"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('keep-planning')}
              className="rounded bg-deck-text/80 px-2.5 py-0.5 text-[10px] font-semibold text-deck-bg-strong hover:brightness-110 disabled:opacity-40"
            >
              发送反馈，继续规划
            </button>
          </div>
        </div>
      )}
      {!isSdk && (
        <div className="mt-1.5 text-[10px] text-deck-muted">外部 CLI 会话无法在此批准，请回到对应终端窗口操作</div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1.5 text-[10px] text-deck-muted/70">
          Claude 主动放弃了这次计划批准请求（流终止 / interrupt / 超时）
        </div>
      )}
    </li>
  );
}

// ───────────────────────── helpers

/**
 * 把 toolInput 翻译成 DiffPayload，让 PermissionRow / ToolStartRow 渲染 Monaco/图片 diff。
 * 与 toolInput 中字段约定耦合，新增工具支持时在这里加一条；返回 null 时上层退化为 JSON 展开。
 */
export function toolInputToDiff(
  toolName: string,
  input: unknown,
): DiffPayload<string | null> | DiffPayload<ImageSource | null> | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: { old_string: string; new_string: string }[];
  };
  if (!i.file_path) return null;
  const ts = Date.now();
  if (toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return { kind: 'text', filePath: i.file_path, before: i.old_string, after: i.new_string, ts };
  }
  if (toolName === 'Write' && typeof i.content === 'string') {
    return { kind: 'text', filePath: i.file_path, before: null, after: i.content, ts };
  }
  if (toolName === 'MultiEdit' && Array.isArray(i.edits) && i.edits.length > 0) {
    return {
      kind: 'text',
      filePath: i.file_path,
      before: i.edits.map((e) => e.old_string).join('\n---\n'),
      after: i.edits.map((e) => e.new_string).join('\n---\n'),
      metadata: { source: 'MultiEdit', editCount: i.edits.length },
      ts,
    };
  }
  // mcp 图片工具：tool-use-start 阶段只有 input.file_path，结构如下：
  // - ImageRead 直接展示这张图（before=null, after=path）→ 驱动 ImageDiffRenderer 缩略图视图
  // - 其他图片工具（Write/Edit/MultiEdit）的 before/after 要等 tool_result 才能拿到 server 快照路径，
  //   tool-use-start 阶段返 null 让 ToolStartRow 不画 diff，等 file-changed 事件来画
  if (isImageTool(toolName)) {
    if (toolName.endsWith('__ImageRead')) {
      return {
        kind: 'image',
        filePath: i.file_path,
        before: null,
        after: { kind: 'path', path: i.file_path },
        metadata: { source: 'ImageRead' },
        ts,
      } as DiffPayload<ImageSource | null>;
    }
    return null;
  }
  return null;
}
