import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent, ExitPlanModeRequest, PlanDeepReviewSession } from '@shared/types';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import {
  RECENT_LIMIT,
  useSessionStore,
} from '@renderer/stores/session-store';
import log from '@renderer/utils/logger';
import { MemoizedMarkdownText } from '../MarkdownText';
import { CloseIcon } from '../icons';

const logger = log.scope('renderer-plan-deep-review');
const EMPTY_EVENTS: AgentEvent[] = [];
const INTERNAL_MARKER_PREFIX = '<!-- agent-deck-plan-review-internal:';

interface Props {
  open: boolean;
  sourceSessionId: string;
  request: ExitPlanModeRequest;
  decisionBusy: boolean;
  onClose: () => void;
  onApprove: () => Promise<boolean>;
  onRevise: (feedback?: string) => Promise<boolean>;
  onAutoSubmitted: () => void;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

function conversationFromEvents(events: AgentEvent[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const event of [...events].reverse()) {
    if (event.kind !== 'message') continue;
    const payload = event.payload as { role?: unknown; text?: unknown; error?: unknown } | null;
    if (
      (payload?.role !== 'user' && payload?.role !== 'assistant') ||
      typeof payload.text !== 'string' ||
      payload.error === true ||
      payload.text.startsWith(INTERNAL_MARKER_PREFIX)
    ) continue;
    messages.push({ role: payload.role, text: payload.text, ts: event.ts });
  }
  return messages;
}

function quotedText(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function PlanDeepReviewDialog({
  open,
  sourceSessionId,
  request,
  decisionBusy,
  onClose,
  onApprove,
  onRevise,
  onAutoSubmitted,
}: Props): JSX.Element | null {
  const [child, setChild] = useState<PlanDeepReviewSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [questionBusy, setQuestionBusy] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [selectedPlanText, setSelectedPlanText] = useState('');
  const [keyboardSelectionOpen, setKeyboardSelectionOpen] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [localDecisionBusy, setLocalDecisionBusy] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const planRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const operationRef = useRef<'question' | 'auto' | 'decision' | null>(null);
  const setRecentEvents = useSessionStore((state) => state.setRecentEvents);
  const childEvents = useSessionStore((state) =>
    child ? state.recentEventsBySession.get(child.sessionId) ?? EMPTY_EVENTS : EMPTY_EVENTS,
  );
  const messages = useMemo(() => conversationFromEvents(childEvents), [childEvents]);
  const busy = decisionBusy || localDecisionBusy || autoBusy || questionBusy;
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStartError(null);
    void window.api.startPlanDeepReview(sourceSessionId, request.requestId)
      .then(async (session) => {
        if (cancelled) return;
        setChild(session);
        await loadStableSnapshot({
          readVersion: () =>
            useSessionStore.getState().eventRevisionsBySession.get(session.sessionId) ?? 0,
          load: () => window.api.listEvents(session.sessionId, RECENT_LIMIT),
          apply: (events) => setRecentEvents(session.sessionId, events),
          isCancelled: () => cancelled,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.error('startPlanDeepReview failed', error);
        setStartError('无法创建隔离的原生 fork。请等待当前会话到达安全边界后重试。');
      });
    return () => {
      cancelled = true;
    };
  }, [open, request.requestId, setRecentEvents, sourceSessionId]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const background = [...document.body.children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== dialog)
      .map((node) => ({
        node,
        ariaHidden: node.getAttribute('aria-hidden'),
        inert: node.inert,
      }));
    for (const { node } of background) {
      node.inert = true;
      node.setAttribute('aria-hidden', 'true');
    }
    closeButtonRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown);
      for (const { node, ariaHidden, inert } of background) {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute('aria-hidden');
        else node.setAttribute('aria-hidden', ariaHidden);
      }
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    const node = conversationRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  if (!open) return null;

  const captureSelection = (): void => {
    const selection = window.getSelection();
    const root = planRef.current;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !root) {
      setSelectedPlanText('');
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setSelectedPlanText('');
      return;
    }
    setSelectedPlanText(selection.toString().trim().slice(0, 8_000));
  };

  const insertQuote = (): void => {
    if (!selectedPlanText) return;
    const textarea = questionRef.current;
    const start = textarea?.selectionStart ?? question.length;
    const end = textarea?.selectionEnd ?? start;
    const quote = quotedText(selectedPlanText);
    const prefix = start > 0 && !question.slice(0, start).endsWith('\n') ? '\n\n' : '';
    const suffix = end < question.length && !question.slice(end).startsWith('\n') ? '\n\n' : '\n\n';
    const insertion = `${prefix}${quote}${suffix}`;
    setQuestion(`${question.slice(0, start)}${insertion}${question.slice(end)}`);
    setSelectedPlanText('');
    requestAnimationFrame(() => {
      questionRef.current?.focus();
      const cursor = start + insertion.length;
      questionRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const beginOperation = (operation: 'question' | 'auto' | 'decision'): boolean => {
    if (busyRef.current || operationRef.current) return false;
    operationRef.current = operation;
    busyRef.current = true;
    return true;
  };

  const finishOperation = (operation: 'question' | 'auto' | 'decision'): void => {
    if (operationRef.current === operation) operationRef.current = null;
  };

  const submitQuestion = async (): Promise<void> => {
    const text = question.trim();
    if (!text || !child || !beginOperation('question')) return;
    setQuestionBusy(true);
    setQuestionError(null);
    try {
      await window.api.askPlanDeepReview(sourceSessionId, request.requestId, text);
      setQuestion('');
    } catch (error) {
      logger.error('askPlanDeepReview failed', error);
      setQuestionError('问题发送失败，请确认计划仍在等待审阅后重试。');
    } finally {
      finishOperation('question');
      setQuestionBusy(false);
    }
  };

  const onQuestionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitQuestion();
  };

  const submitAutoFeedback = async (): Promise<void> => {
    if (!child || !beginOperation('auto')) return;
    setAutoBusy(true);
    setAutoError(null);
    try {
      await window.api.autoFeedbackPlanDeepReview(sourceSessionId, request.requestId);
      onAutoSubmitted();
      onClose();
    } catch (error) {
      logger.error('autoFeedbackPlanDeepReview failed', error);
      setAutoError('自动整理意见失败，请重试或手动提交修改意见。');
    } finally {
      finishOperation('auto');
      setAutoBusy(false);
    }
  };

  const submitApprove = async (): Promise<void> => {
    if (!beginOperation('decision')) return;
    setLocalDecisionBusy(true);
    try {
      if (await onApprove()) onClose();
    } finally {
      finishOperation('decision');
      setLocalDecisionBusy(false);
    }
  };

  const continueModifying = async (): Promise<void> => {
    if (!showFeedback) {
      if (busyRef.current || operationRef.current) return;
      setShowFeedback(true);
      return;
    }
    if (!beginOperation('decision')) return;
    setLocalDecisionBusy(true);
    try {
      if (await onRevise(feedback.trim() || undefined)) onClose();
    } finally {
      finishOperation('decision');
      setLocalDecisionBusy(false);
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex flex-col bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="计划深度审阅"
    >
      <div className="no-drag flex min-h-0 flex-1 flex-col bg-[#141418]">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-deck-border px-4 py-2">
          <div className="mr-auto min-w-0">
            <div className="text-[13px] font-semibold text-deck-text">计划深度审阅</div>
            <div className="max-w-[42rem] truncate text-[10px] text-deck-muted">
              {request.title ?? '当前计划'} · 隔离的同适配器原生 fork
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitApprove()}
            className="rounded bg-status-working px-3 py-1 text-[10px] font-semibold text-black hover:brightness-110 disabled:opacity-40"
          >
            批准计划
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void continueModifying()}
            className="rounded border border-deck-border bg-white/[0.06] px-3 py-1 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-40"
          >
            继续修改
          </button>
          <button
            type="button"
            disabled={busy || !child}
            onClick={() => void submitAutoFeedback()}
            title="让审阅子会话结合继承的聊天上下文总结意见，并自动提交给当前计划所属会话"
            className="rounded border border-status-waiting/50 bg-status-waiting/10 px-3 py-1 text-[10px] text-status-waiting hover:bg-status-waiting/20 disabled:opacity-40"
          >
            {autoBusy ? '正在整理并提交…' : '根据上下文提意见'}
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭深度审阅"
            className="ml-1 flex h-6 w-6 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text disabled:opacity-40"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
          <div className="basis-full text-right text-[9px] text-deck-muted/70">
            “根据上下文提意见”会生成针对当前计划的修改意见，并直接提交给当前所属会话。
          </div>
        </header>

        {showFeedback && (
          <div className="flex shrink-0 gap-2 border-b border-deck-border bg-white/[0.02] px-4 py-2">
            <textarea
              autoFocus
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="反馈可选；再次点击“继续修改”提交"
              disabled={busy}
              className="min-h-14 flex-1 resize-y rounded border border-deck-border bg-black/20 px-2 py-1.5 text-[11px] text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
            />
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <section className="min-h-0 overflow-auto border-r border-deck-border p-4 scrollbar-deck">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-deck-text">完整计划</span>
              <button
                type="button"
                disabled={busy || !selectedPlanText}
                onClick={insertQuote}
                className="rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/[0.1] hover:text-deck-text disabled:opacity-35"
              >
                引用所选
              </button>
              <button
                type="button"
                disabled={busy}
                aria-expanded={keyboardSelectionOpen}
                onClick={() => setKeyboardSelectionOpen((value) => !value)}
                className="rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/[0.1] hover:text-deck-text"
              >
                键盘选择
              </button>
            </div>
            {keyboardSelectionOpen && (
              <textarea
                readOnly
                value={request.plan || '(计划内容为空)'}
                aria-label="用键盘选择计划文本"
                onSelect={(event) => {
                  const target = event.currentTarget;
                  setSelectedPlanText(
                    target.value.slice(target.selectionStart, target.selectionEnd).trim().slice(0, 8_000),
                  );
                }}
                className="mb-2 min-h-28 w-full resize-y rounded border border-status-working/30 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-deck-text outline-none focus:border-status-working/60"
              />
            )}
            <div
              ref={planRef}
              data-testid="plan-review-plan"
              tabIndex={0}
              role="region"
              aria-label="计划正文，可选择文本后引用"
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
              className="select-text rounded-lg border border-deck-border/60 bg-black/20 p-4 text-[12px] leading-relaxed"
            >
              <MemoizedMarkdownText text={request.plan || '(计划内容为空)'} />
            </div>
          </section>

          <section className="flex min-h-0 flex-col bg-white/[0.015]">
            <div className="shrink-0 border-b border-deck-border px-3 py-2">
              <div className="text-[11px] font-medium text-deck-text">提问与回答</div>
              <div className="text-[9px] text-deck-muted/70">审阅会话默认只读，不会修改其他文件。</div>
            </div>
            <div ref={conversationRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-3 scrollbar-deck">
              {startError ? (
                <div className="rounded border border-status-error/40 bg-status-error/10 p-2 text-[10px] text-status-error">
                  {startError}
                </div>
              ) : !child ? (
                <div className="text-[10px] text-deck-muted">正在准备隔离的审阅会话…</div>
              ) : messages.length === 0 ? (
                <div className="text-[10px] text-deck-muted">审阅会话已创建，正在准备回答…</div>
              ) : messages.map((message, index) => (
                <div
                  key={`${message.ts}-${index}`}
                  className={`rounded-lg border p-2 text-[11px] ${
                    message.role === 'user'
                      ? 'ml-6 border-status-working/30 bg-status-working/10'
                      : 'mr-6 border-deck-border bg-black/20'
                  }`}
                >
                  <div className="mb-1 text-[9px] text-deck-muted/70">
                    {message.role === 'user' ? '你' : '审阅会话'}
                  </div>
                  <MemoizedMarkdownText text={message.text} />
                </div>
              ))}
            </div>
            <div className="shrink-0 border-t border-deck-border p-3">
              {selectedPlanText && (
                <div className="mb-1.5 truncate text-[9px] text-status-working">
                  已选中 {selectedPlanText.length} 字，可点击左侧“引用所选”加入问题
                </div>
              )}
              <textarea
                ref={questionRef}
                data-testid="plan-review-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={onQuestionKeyDown}
                disabled={!child || busy}
                placeholder="询问计划；Enter 发送，Shift+Enter 换行"
                className="min-h-20 w-full resize-y rounded border border-deck-border bg-black/30 px-2 py-1.5 text-[11px] text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[9px] text-status-error">
                  {questionError ?? autoError ?? ''}
                </span>
                <button
                  type="button"
                  disabled={!child || !question.trim() || busy}
                  onClick={() => void submitQuestion()}
                  className="shrink-0 rounded bg-white/10 px-3 py-1 text-[10px] text-deck-text hover:bg-white/15 disabled:opacity-40"
                >
                  {questionBusy ? '发送中…' : '发送问题'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
