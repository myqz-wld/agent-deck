import { useEffect, useRef, useState, type JSX, type KeyboardEvent,
  type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  NO_PLAN_REVIEW_DIALOGUE_FEEDBACK,
  type ExitPlanModeRequest,
} from '@shared/types';
import type { PlanDeepReviewTransport } from '@renderer/plan-review/transport';
import {
  EMPTY_PLAN_DEEP_REVIEW_DRAFT,
  usePlanDeepReviewStore,
} from '@renderer/stores/plan-deep-review-store';
import log from '@renderer/utils/logger';
import { MemoizedMarkdownText } from '../MarkdownText';
import { CloseIcon } from '../icons';
import { PlanQuoteContextMenu, type PlanQuoteMenuState } from './PlanQuoteContextMenu';
import { PlanQuotePreview } from './PlanQuotePreview';
import { PlanReviewConversation } from './PlanReviewConversation';
import { PlanReviewDecisionFooter } from './PlanReviewDecisionFooter';
import { ExpandableReviewTextField } from './review-detail/ExpandableReviewTextField';
import {
  PLAN_QUOTE_ARIA_SHORTCUT, PLAN_QUOTE_SHORTCUT, isPlanQuoteShortcut,
  quotedPlanText, selectedTextWithin,
} from './plan-quote-selection';
import { useReviewDialogFocus } from './review-detail/use-review-dialog-focus';
import { usePlanDeepReviewEvents } from './use-plan-deep-review-events';

const logger = log.scope('renderer-plan-deep-review');
interface Props {
  open: boolean;
  sourceAgentId: string;
  sourceSessionId: string;
  request: ExitPlanModeRequest;
  decisionBusy: boolean;
  decisionError?: string | null;
  onClose: () => void;
  onApprove: () => Promise<boolean>;
  onRevise: (feedback?: string) => Promise<boolean>;
  transport?: PlanDeepReviewTransport;
  draftKey?: string;
}

export function PlanDeepReviewDialog({
  open,
  sourceAgentId,
  sourceSessionId,
  request,
  decisionBusy,
  decisionError,
  onClose,
  onApprove,
  onRevise,
  transport,
  draftKey,
}: Props): JSX.Element | null {
  const reviewKey = draftKey ?? request.requestId;
  const draft = usePlanDeepReviewStore((state) =>
    state.drafts.get(reviewKey) ?? EMPTY_PLAN_DEEP_REVIEW_DRAFT);
  const patchDraft = usePlanDeepReviewStore((state) => state.patchDraft);
  const clearDraft = usePlanDeepReviewStore((state) => state.clearDraft);
  const {
    child,
    startError,
    question,
    questionBusy,
    questionError,
    planQuotes,
    feedback,
    feedbackDraftBusy,
    feedbackDraftError,
    feedbackDraftGenerated,
  } = draft;
  const [selectedPlanText, setSelectedPlanText] = useState('');
  const [quoteMenu, setQuoteMenu] = useState<PlanQuoteMenuState | null>(null);
  const [localDecisionBusy, setLocalDecisionBusy] = useState(false);
  const planRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const operationRef = useRef<'question' | 'feedback' | 'decision' | null>(null);
  const patchExistingDraft = usePlanDeepReviewStore((state) => state.patchExistingDraft);
  const { childEvents, loadEvents } = usePlanDeepReviewEvents(open, child, transport);
  const busy = decisionBusy || localDecisionBusy || feedbackDraftBusy || questionBusy;
  const closeBlocked = decisionBusy || localDecisionBusy;
  busyRef.current = busy;

  useReviewDialogFocus({
    open,
    dialogRef,
    closeButtonRef,
    planRef,
    questionRef,
    closeBlocked,
    quoteMenuOpen: quoteMenu !== null,
    onClose,
    closeQuoteMenu: () => setQuoteMenu(null),
  });

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
    patchDraft(reviewKey, (current) => {
      const quotes = current.planQuotes;
      const remaining = 8_000 - quotes.reduce((total, quote) => total + quote.text.length, 0);
      const nextText = text.slice(0, Math.max(0, remaining));
      if (!nextText) return {};
      const nextId = quotes.reduce((largest, quote) => Math.max(largest, quote.id), 0) + 1;
      return { planQuotes: [...quotes, { id: nextId, text: nextText }] };
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
    patchDraft(reviewKey, {
      questionBusy: true,
      questionError: null,
      question: '',
      planQuotes: [],
    });
    try {
      let activeChild = child;
      if (!activeChild) {
        activeChild = transport
          ? await transport.start()
          : await window.api.startPlanDeepReview(sourceSessionId, request.requestId);
        forkReady = true;
        patchExistingDraft(reviewKey, { child: activeChild });
        await loadEvents(activeChild);
      }
      if (transport) await transport.ask(submittedText);
      else await window.api.askPlanDeepReview(sourceSessionId, request.requestId, submittedText);
      await loadEvents(activeChild);
      patchExistingDraft(reviewKey, { startError: null });
    } catch (error) {
      logger.error('plan deep-review question failed', {
        action: 'askPlanDeepReview',
        agentId: sourceAgentId,
        sourceSessionId,
        requestId: request.requestId,
        error,
      });
      patchExistingDraft(reviewKey, {
        question: text,
        planQuotes: submittedQuotes,
        ...(!forkReady
          ? { startError: '无法创建隔离的审阅会话。请稍后重试。' }
          : {}),
        questionError: '问题发送失败，请确认计划仍在等待审阅后重试。',
      });
    } finally {
      finishOperation('question');
      patchExistingDraft(reviewKey, { questionBusy: false });
    }
  };

  const onQuestionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitQuestion();
  };

  const generateFeedbackDraft = async (): Promise<void> => {
    if (!beginOperation('feedback')) return;
    patchDraft(reviewKey, {
      feedbackDraftBusy: true,
      feedbackDraftError: null,
      feedbackDraftGenerated: false,
    });
    try {
      const result = transport
        ? await transport.generateFeedback()
        : await window.api.generatePlanDeepReviewFeedback(sourceSessionId, request.requestId);
      const generated = result.feedback.trim();
      patchExistingDraft(reviewKey, (current) => ({
        feedback: current.feedback.trim() === NO_PLAN_REVIEW_DIALOGUE_FEEDBACK
          ? generated
          : current.feedback.trim()
          ? `${current.feedback.trimEnd()}\n\n${generated}`
          : generated,
        feedbackDraftGenerated: true,
      }));
    } catch (error) {
      logger.error('plan deep-review feedback generation failed', {
        action: 'generatePlanDeepReviewFeedback',
        agentId: sourceAgentId,
        sourceSessionId,
        requestId: request.requestId,
        error,
      });
      patchExistingDraft(reviewKey, {
        feedbackDraftError: '意见草稿生成失败，请重试或手动填写。',
      });
    } finally {
      finishOperation('feedback');
      patchExistingDraft(reviewKey, { feedbackDraftBusy: false });
    }
  };

  const submitApprove = async (): Promise<void> => {
    if (
      feedback.trim()
      && !window.confirm('修改意见尚未提交。批准计划将丢弃这些内容，是否仍要批准？')
    ) return;
    if (!beginOperation('decision')) return;
    setLocalDecisionBusy(true);
    try {
      if (await onApprove()) {
        clearDraft(reviewKey);
        onClose();
      }
    } finally {
      finishOperation('decision');
      setLocalDecisionBusy(false);
    }
  };

  const continueModifying = async (): Promise<void> => {
    if (!beginOperation('decision')) return;
    setLocalDecisionBusy(true);
    try {
      if (await onRevise(feedback.trim() || undefined)) {
        clearDraft(reviewKey);
        onClose();
      }
    } finally {
      finishOperation('decision');
      setLocalDecisionBusy(false);
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="no-drag fixed inset-0 z-[70] flex min-h-0 min-w-0 flex-col overflow-hidden bg-deck-bg-strong text-deck-text shadow-2xl outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plan-deep-review-title"
      aria-describedby="plan-deep-review-description"
    >
      <div className="flex min-h-0 flex-1 flex-col bg-[#141418]">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-deck-border py-2 pl-[78px] pr-3 sm:pr-4">
          <div className="mr-auto min-w-0">
            <h2 id="plan-deep-review-title" className="text-[13px] font-semibold text-deck-text">
              计划深度审阅
            </h2>
            <div id="plan-deep-review-description" className="max-w-[42rem] truncate text-[10px] text-deck-muted">
              {request.title ?? '当前计划'} · 回复期间可关闭窗口，稍后返回继续审阅
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            disabled={closeBlocked}
            onClick={onClose}
            aria-label="关闭深度审阅"
            title={
              questionBusy || feedbackDraftBusy
                ? '关闭窗口；正在进行的审阅会继续'
                : '关闭深度审阅'
            }
            className="ml-1 flex h-11 w-11 touch-manipulation items-center justify-center rounded-md text-deck-muted hover:bg-white/10 hover:text-deck-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-status-working disabled:opacity-40"
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
              <MemoizedMarkdownText text={request.plan || '（计划内容为空）'} />
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
                    onRemove={() => patchDraft(reviewKey, (current) => ({
                      planQuotes: current.planQuotes.filter((item) => item.id !== quote.id),
                    }))}
                  />
                ))}
              </div>
              <ExpandableReviewTextField
                textareaRef={questionRef}
                sessionId={sourceSessionId}
                requestId={reviewKey}
                fieldId="question"
                title="向审阅会话提问"
                triggerLabel="放大提问输入框"
                testId="plan-review-question"
                value={question}
                onChange={(value) => patchDraft(reviewKey, {
                  question: value,
                })}
                onKeyDown={onQuestionKeyDown}
                disabled={busy}
                ariaLabel="向审阅会话提问"
                placeholder="询问计划；Enter 发送，Shift+Enter 换行"
                compactClassName="min-h-20 rounded border border-deck-border bg-black/30 py-1.5 pl-2 text-[11px] text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
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
          sessionId={sourceSessionId}
          requestId={reviewKey}
          feedback={feedback}
          feedbackRef={feedbackRef}
          busy={busy}
          canGenerate
          generating={feedbackDraftBusy}
          generated={feedbackDraftGenerated}
          error={feedbackDraftError ?? decisionError ?? null}
          onFeedbackChange={(value) => {
            patchDraft(reviewKey, {
              feedback: value,
              feedbackDraftError: null,
            });
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
