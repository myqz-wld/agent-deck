import { useEffect, useRef, useState, type JSX, type KeyboardEvent,
  type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  NO_PLAN_REVIEW_DIALOGUE_FEEDBACK,
  type AgentEvent,
  type ExitPlanModeRequest,
  type PlanDeepReviewSession,
} from '@shared/types';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import { RECENT_LIMIT, useSessionStore } from '@renderer/stores/session-store';
import log from '@renderer/utils/logger';
import { MemoizedMarkdownText } from '../MarkdownText';
import { CloseIcon } from '../icons';
import { PlanQuoteContextMenu, type PlanQuoteMenuState } from './PlanQuoteContextMenu';
import { PlanQuotePreview } from './PlanQuotePreview';
import { PlanReviewConversation } from './PlanReviewConversation';
import { PlanReviewDecisionFooter } from './PlanReviewDecisionFooter';
import {
  PLAN_QUOTE_ARIA_SHORTCUT, PLAN_QUOTE_SHORTCUT, isPlanQuoteShortcut,
  quotedPlanText, selectedTextWithin,
} from './plan-quote-selection';

const logger = log.scope('renderer-plan-deep-review');
const EMPTY_EVENTS: AgentEvent[] = [];

interface Props {
  open: boolean;
  sourceSessionId: string;
  request: ExitPlanModeRequest;
  decisionBusy: boolean;
  onClose: () => void;
  onApprove: () => Promise<boolean>;
  onRevise: (feedback?: string) => Promise<boolean>;
}

interface AttachedPlanQuote {
  id: number;
  text: string;
}

export function PlanDeepReviewDialog({
  open,
  sourceSessionId,
  request,
  decisionBusy,
  onClose,
  onApprove,
  onRevise,
}: Props): JSX.Element | null {
  const [child, setChild] = useState<PlanDeepReviewSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [questionBusy, setQuestionBusy] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [selectedPlanText, setSelectedPlanText] = useState('');
  const [planQuotes, setPlanQuotes] = useState<AttachedPlanQuote[]>([]);
  const [quoteMenu, setQuoteMenu] = useState<PlanQuoteMenuState | null>(null);
  const [feedback, setFeedback] = useState('');
  const [feedbackDraftBusy, setFeedbackDraftBusy] = useState(false);
  const [localDecisionBusy, setLocalDecisionBusy] = useState(false);
  const [feedbackDraftError, setFeedbackDraftError] = useState<string | null>(null);
  const [feedbackDraftGenerated, setFeedbackDraftGenerated] = useState(false);
  const planRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const quoteMenuOpenRef = useRef(false);
  const nextQuoteIdRef = useRef(1);
  const operationRef = useRef<'question' | 'feedback' | 'decision' | null>(null);
  const setRecentEvents = useSessionStore((state) => state.setRecentEvents);
  const childEvents = useSessionStore((state) =>
    child ? state.recentEventsBySession.get(child.sessionId) ?? EMPTY_EVENTS : EMPTY_EVENTS,
  );
  const busy = decisionBusy || localDecisionBusy || feedbackDraftBusy || questionBusy;
  onCloseRef.current = onClose;
  busyRef.current = busy;
  quoteMenuOpenRef.current = quoteMenu !== null;

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
      if (quoteMenuOpenRef.current && (event.key === 'Escape' || event.key === 'Tab')) {
        event.preventDefault();
        event.stopPropagation();
        const focusTarget = event.key === 'Escape'
          ? planRef.current
          : event.shiftKey ? closeButtonRef.current : questionRef.current;
        setQuoteMenu(null);
        requestAnimationFrame(() => focusTarget?.focus());
        return;
      }
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
  }, [childEvents, questionBusy]);

  useEffect(() => {
    if (feedbackDraftGenerated && !feedbackDraftBusy) feedbackRef.current?.focus();
  }, [feedbackDraftBusy, feedbackDraftGenerated]);

  if (!open) return null;

  const captureSelection = (): void => {
    setSelectedPlanText(selectedTextWithin(planRef.current));
  };

  const attachQuote = (text: string): void => {
    if (!text) return;
    setPlanQuotes((quotes) => {
      const remaining = 8_000 - quotes.reduce((total, quote) => total + quote.text.length, 0);
      const nextText = text.slice(0, Math.max(0, remaining));
      if (!nextText) return quotes;
      return [...quotes, { id: nextQuoteIdRef.current++, text: nextText }];
    });
    setSelectedPlanText('');
    setQuoteMenu(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => questionRef.current?.focus());
  };

  const openQuoteMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const text = selectedTextWithin(planRef.current);
    if (!text || busyRef.current) {
      setQuoteMenu(null);
      return;
    }
    event.preventDefault();
    const menuWidth = 208;
    const menuHeight = 42;
    setSelectedPlanText(text);
    setQuoteMenu({
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      text,
    });
  };

  const onPlanKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    captureSelection();
    if (!isPlanQuoteShortcut(event) || busyRef.current) return;
    const text = selectedTextWithin(planRef.current);
    if (!text) return;
    event.preventDefault();
    attachQuote(text);
  };

  const beginOperation = (operation: 'question' | 'feedback' | 'decision'): boolean => {
    if (busyRef.current || operationRef.current) return false;
    operationRef.current = operation;
    busyRef.current = true;
    return true;
  };

  const finishOperation = (operation: 'question' | 'feedback' | 'decision'): void => {
    if (operationRef.current === operation) operationRef.current = null;
  };

  const submitQuestion = async (): Promise<void> => {
    const text = question.trim();
    if (!text || !beginOperation('question')) return;
    const submittedText = [...planQuotes.map((quote) => quotedPlanText(quote.text)), text]
      .join('\n\n');
    const submittedQuotes = planQuotes;
    let forkReady = child !== null;
    setQuestionBusy(true);
    setQuestionError(null);
    setQuestion('');
    setPlanQuotes([]);
    try {
      let activeChild = child;
      if (!activeChild) {
        activeChild = await window.api.startPlanDeepReview(sourceSessionId, request.requestId);
        forkReady = true;
        setChild(activeChild);
        await loadStableSnapshot({
          readVersion: () =>
            useSessionStore.getState().eventRevisionsBySession.get(activeChild!.sessionId) ?? 0,
          load: () => window.api.listEvents(activeChild!.sessionId, RECENT_LIMIT),
          apply: (events) => setRecentEvents(activeChild!.sessionId, events),
        });
      }
      await window.api.askPlanDeepReview(sourceSessionId, request.requestId, submittedText);
      setStartError(null);
    } catch (error) {
      logger.error('askPlanDeepReview failed', error);
      setQuestion(text);
      setPlanQuotes(submittedQuotes);
      if (!forkReady) {
        setStartError('无法创建隔离的原生 fork。请等待当前会话到达安全边界后重试。');
      }
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

  const generateFeedbackDraft = async (): Promise<void> => {
    if (!beginOperation('feedback')) return;
    setFeedbackDraftBusy(true);
    setFeedbackDraftError(null);
    setFeedbackDraftGenerated(false);
    try {
      const result = await window.api.generatePlanDeepReviewFeedback(
        sourceSessionId,
        request.requestId,
      );
      const generated = result.feedback.trim();
      setFeedback((current) => current.trim() === NO_PLAN_REVIEW_DIALOGUE_FEEDBACK
        ? generated
        : current.trim()
        ? `${current.trimEnd()}\n\n${generated}`
        : generated);
      setFeedbackDraftGenerated(true);
    } catch (error) {
      logger.error('generatePlanDeepReviewFeedback failed', error);
      setFeedbackDraftError('意见草稿生成失败，请重试或手动填写。');
    } finally {
      finishOperation('feedback');
      setFeedbackDraftBusy(false);
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
      aria-labelledby="plan-deep-review-title"
      aria-describedby="plan-deep-review-description"
    >
      <div className="no-drag flex min-h-0 flex-1 flex-col bg-[#141418]">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-deck-border py-2 pl-[78px] pr-4">
          <div className="mr-auto min-w-0">
            <h2 id="plan-deep-review-title" className="text-[13px] font-semibold text-deck-text">
              计划深度审阅
            </h2>
            <div id="plan-deep-review-description" className="max-w-[42rem] truncate text-[10px] text-deck-muted">
              {request.title ?? '当前计划'} · 首次提问时创建隔离的同适配器原生 fork
            </div>
          </div>
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
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <section className="min-h-0 overflow-auto border-r border-deck-border p-4 scrollbar-deck">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-deck-text">完整计划</span>
              <span id="plan-quote-help" className="text-right text-[9px] text-deck-muted/70">
                选择文字后右键引用，或按 {PLAN_QUOTE_SHORTCUT}
              </span>
            </div>
            <div
              ref={planRef}
              data-testid="plan-review-plan"
              tabIndex={0}
              role="region"
              aria-label="计划正文，可选择文本后右键引用到提问"
              aria-describedby="plan-quote-help"
              aria-keyshortcuts={PLAN_QUOTE_ARIA_SHORTCUT}
              onMouseUp={captureSelection}
              onContextMenu={openQuoteMenu}
              onKeyDown={onPlanKeyDown}
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
            <PlanReviewConversation
              events={childEvents}
              childReady={child !== null}
              startError={startError}
              waitingForReply={questionBusy}
              conversationRef={conversationRef}
            />
            <div className="shrink-0 border-t border-deck-border p-3">
              {selectedPlanText && (
                <div className="mb-1.5 truncate text-[9px] text-status-working" role="status">
                  已选中 {selectedPlanText.length} 字；右键选择“引用到提问”，或按 {PLAN_QUOTE_SHORTCUT}
                </div>
              )}
              <div
                role="list"
                aria-label="已附加的计划引用"
                aria-live="polite"
                className="max-h-40 overflow-y-auto scrollbar-deck"
              >
                {planQuotes.map((quote, index) => (
                  <PlanQuotePreview
                    key={quote.id}
                    text={quote.text}
                    removeLabel={`移除第 ${index + 1} 条计划引用`}
                    onRemove={() => setPlanQuotes((quotes) =>
                      quotes.filter((item) => item.id !== quote.id))}
                  />
                ))}
              </div>
              <textarea
                ref={questionRef}
                data-testid="plan-review-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={onQuestionKeyDown}
                disabled={busy}
                aria-label="向审阅会话提问"
                placeholder="询问计划；Enter 发送，Shift+Enter 换行"
                className="min-h-20 w-full resize-y rounded border border-deck-border bg-black/30 px-2 py-1.5 text-[11px] text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[9px] text-status-error">
                  {questionError ?? ''}
                </span>
                <button
                  type="button"
                  disabled={!question.trim() || busy}
                  onClick={() => void submitQuestion()}
                  className="shrink-0 rounded bg-white/10 px-3 py-1 text-[10px] text-deck-text hover:bg-white/15 disabled:opacity-40"
                >
                  {questionBusy ? '发送中…' : '发送问题'}
                </button>
              </div>
            </div>
          </section>
        </div>
        <PlanReviewDecisionFooter
          feedback={feedback}
          feedbackRef={feedbackRef}
          busy={busy}
          canGenerate
          generating={feedbackDraftBusy}
          generated={feedbackDraftGenerated}
          error={feedbackDraftError}
          onFeedbackChange={(value) => {
            setFeedback(value);
            setFeedbackDraftError(null);
          }}
          onGenerate={() => void generateFeedbackDraft()}
          onRevise={() => void continueModifying()}
          onApprove={() => void submitApprove()}
        />
        {quoteMenu && (
          <PlanQuoteContextMenu
            menu={quoteMenu}
            onClose={() => {
              setQuoteMenu(null);
              planRef.current?.focus();
            }}
            onQuote={() => attachQuote(quoteMenu.text)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
