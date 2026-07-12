import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  SessionAdapterId,
  SessionHandOffExecutionFailure,
  SessionHandOffPreparation,
  SessionRecord,
} from '@shared/types';
import { DeckSelect, type DeckSelectOption } from './DeckSelect';
import { CloseIcon, HandOffIcon, RefreshIcon } from './icons';
import {
  SessionModelFields,
  thinkingOptionsForAdapter,
  type SessionThinkingChoice,
} from './SessionModelFields';

interface Props {
  open: boolean;
  session: SessionRecord;
  onClose: () => void;
}

export const DEFAULT_UI_CONTINUATION_INSTRUCTION =
  '请基于以上会话续接上下文继续完成当前工作。';

// The dialog stays mounted only with one SessionDetail and can be closed to navigate to the orphan.
// Keep failed-cleanup acknowledgements outside component state so close/reopen and session switches
// cannot silently re-enable another handoff from the same source.
const pendingOrphanAcknowledgements = new Map<string, SessionHandOffExecutionFailure>();

function sourceThinking(session: SessionRecord): SessionThinkingChoice {
  const value = session.thinking ?? '';
  return thinkingOptionsForAdapter(session.agentId).some((option) => option.value === value)
    ? (value as SessionThinkingChoice)
    : '';
}

function qualityLabel(quality: SessionHandOffPreparation['quality']): string {
  switch (quality) {
    case 'full':
      return '完整检查点';
    case 'projected':
      return '检查点已按目标容量投影';
    case 'coverage-gap':
      return '部分历史未覆盖';
    case 'raw-only':
      return '仅保留原始用户输入';
    case 'instruction-only':
      return '仅包含下一步指令';
  }
}

function warningLabel(code: string): string {
  const labels: Record<string, string> = {
    'checkpoint-generation-failed': '续接检查点生成失败，已按可用历史降级。',
    'checkpoint-repair-failed': '续接检查点修复失败，已保留上一个有效结果。',
    'checkpoint-projected': '续接检查点已按目标上下文容量裁剪。',
    'coverage-gap': '部分事件修订未被续接检查点覆盖。',
    'legacy-wrapper-excluded': '已排除无法验证的旧版续接包装内容。',
    'legacy-wrapper-unwrapped': '已从旧版续接内容中仅保留权威用户指令。',
    'raw-boundary-truncated': '最早保留的用户输入已在 UTF-8 边界安全截断。',
    'raw-history-omitted': '部分较早的用户输入未能放入目标上下文预算。',
    'checkpoint-omitted': '续接检查点未能放入目标投影预算。',
    'target-capacity-fallback': '目标模型容量尚未观测，已采用保守容量。',
    'instruction-only': '没有可验证的历史，仅发送下一步指令。',
    'spool-resource-guard': '不可变历史快照达到资源上限，覆盖范围已明确标记。',
    'codex-generator-tools-unproven': 'Codex 压缩运行时隔离尚未证明安全，已关闭检查点生成。',
  };
  return labels[code] ?? `会话续接上下文已降级（${code}）。`;
}

function executionFailureLabel(failure: SessionHandOffExecutionFailure): string {
  const stageLabel = failure.stage === 'cutover' ? '源会话切换前检查' : '必要资源转移';
  const cleanupLabel = failure.successorCleanup === 'failed' ? '自动关闭失败' : '已自动关闭';
  const prefix =
    `续接会话 ${failure.successorSessionId} 已创建，但${stageLabel}失败` +
    `（阶段：${stageLabel}；清理状态：${cleanupLabel}）。`;
  if (failure.successorCleanup === 'failed') {
    return (
      `${prefix}自动关闭该会话也失败，它可能仍在运行。` +
      `请先找到并关闭会话 ${failure.successorSessionId}，确认关闭后再重新生成续接上下文，` +
      '避免产生更多孤儿会话。'
    );
  }
  return `${prefix}该会话已自动关闭；请重新生成续接上下文后再试。`;
}

export function HandOffPreviewDialog({ open, session, onClose }: Props): JSX.Element | null {
  const sessionId = session.id;
  const [adapters, setAdapters] = useState<DeckSelectOption<SessionAdapterId>[]>([]);
  const [targetAdapter, setTargetAdapter] = useState<SessionAdapterId>(
    session.agentId as SessionAdapterId,
  );
  const [targetModel, setTargetModel] = useState(session.model ?? '');
  const [targetThinking, setTargetThinking] = useState<SessionThinkingChoice>(() =>
    sourceThinking(session),
  );
  const [instruction, setInstruction] = useState(DEFAULT_UI_CONTINUATION_INSTRUCTION);
  const [preparation, setPreparation] = useState<SessionHandOffPreparation | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [executionFailure, setExecutionFailure] =
    useState<SessionHandOffExecutionFailure | null>(null);
  const requestSequence = useRef(0);
  const preparationId = useRef<string | null>(null);
  const prepareInFlight = useRef(false);
  const commitInFlight = useRef(false);

  const cancelPreparation = (): void => {
    requestSequence.current += 1;
    const id = preparationId.current;
    preparationId.current = null;
    setPreparation(null);
    if (id) void window.api.handOffCancel(id).catch(() => undefined);
  };

  useEffect(() => {
    if (!open) return;
    cancelPreparation();
    setTargetAdapter(session.agentId as SessionAdapterId);
    setTargetModel(session.model ?? '');
    setTargetThinking(sourceThinking(session));
    setInstruction(DEFAULT_UI_CONTINUATION_INSTRUCTION);
    setPreparing(false);
    setCommitting(false);
    setError(null);
    setExecutionFailure(pendingOrphanAcknowledgements.get(sessionId) ?? null);
    prepareInFlight.current = false;
    commitInFlight.current = false;
    return () => {
      requestSequence.current += 1;
      const id = preparationId.current;
      preparationId.current = null;
      if (id) void window.api.handOffCancel(id).catch(() => undefined);
    };
    // sessionId is the reset boundary; other session fields are frozen again by main during prepare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.api
      .listAdapters()
      .then((rows) => {
        if (cancelled) return;
        setAdapters(
          rows
            .filter(
              (row): row is typeof row & { id: SessionAdapterId } =>
                row.capabilities.canCreateSession === true &&
                (row.id === 'claude-code' ||
                  row.id === 'deepseek-claude-code' ||
                  row.id === 'codex-cli'),
            )
            .map((row) => ({ value: row.id, label: row.displayName })),
        );
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(`加载 adapter 失败：${caught instanceof Error ? caught.message : String(caught)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const invalidateAndChange = (change: () => void): void => {
    if (preparationId.current) cancelPreparation();
    setError(null);
    change();
  };

  const prepare = async (): Promise<void> => {
    if (
      prepareInFlight.current ||
      !instruction.trim() ||
      executionFailure?.successorCleanup === 'failed'
    ) {
      return;
    }
    prepareInFlight.current = true;
    cancelPreparation();
    setPreparing(true);
    setError(null);
    setExecutionFailure(null);
    const sequence = requestSequence.current;
    try {
      const result = await window.api.handOffPrepare({
        sourceSessionId: sessionId,
        continuationInstruction: instruction,
        target: {
          adapter: targetAdapter,
          model: targetModel.trim() || null,
          thinking: targetThinking || null,
        },
      });
      if (sequence !== requestSequence.current) {
        void window.api.handOffCancel(result.preparationId).catch(() => undefined);
        return;
      }
      preparationId.current = result.preparationId;
      setPreparation(result);
    } catch (caught) {
      if (sequence === requestSequence.current) {
        setError(`生成续接上下文失败：${caught instanceof Error ? caught.message : String(caught)}`);
      }
    } finally {
      prepareInFlight.current = false;
      if (sequence === requestSequence.current) setPreparing(false);
    }
  };

  const commit = async (): Promise<void> => {
    const id = preparationId.current;
    if (!id || commitInFlight.current) return;
    commitInFlight.current = true;
    setCommitting(true);
    setError(null);
    try {
      const response = await window.api.handOffCommit(id);
      preparationId.current = null;
      setPreparation(null);
      if (response.status === 'execution-error') {
        if (response.successorCleanup === 'failed') {
          pendingOrphanAcknowledgements.set(sessionId, response);
        }
        setExecutionFailure(response);
        return;
      }
      const result = response;
      if (result.sourceFinalizationWarning) {
        setError(
          `新会话 ${result.successorSessionId} 已创建，但源会话收尾失败：${result.sourceFinalizationWarning}。` +
            '新会话不会回滚；请检查源会话状态并按提示处理后，再切换继续。',
        );
        return;
      }
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (/已过期|not found|not authorized|already been consumed/i.test(message)) {
        preparationId.current = null;
        setPreparation(null);
      }
      setError(`创建续接会话失败：${message}`);
    } finally {
      commitInFlight.current = false;
      setCommitting(false);
    }
  };

  const busy = preparing || committing;
  const close = (): void => {
    cancelPreparation();
    onClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag flex max-h-[92%] w-[620px] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-bg-strong shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
            <HandOffIcon className="h-4 w-4 text-status-working" />
            <span>接力到新会话{preparing ? '（正在压缩会话上下文…）' : committing ? '（正在创建…）' : ''}</span>
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={busy ? '请等待当前操作完成' : '关闭接力窗口'}
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10 disabled:opacity-30"
            title={busy ? '请等待当前操作完成' : '取消'}
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-deck">
          <p className="text-[10px] leading-relaxed text-deck-muted">
            续接检查点生成器由“会话续接上下文”设置控制，与下方目标会话的 adapter、模型和思考程度相互独立。
          </p>

          <div className="space-y-3 rounded border border-deck-border/80 bg-white/[0.02] p-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider text-deck-muted/70">
                目标 adapter
              </label>
              <DeckSelect
                value={targetAdapter}
                ariaLabel="目标 adapter"
                options={adapters}
                disabled={busy || adapters.length === 0}
                onChange={(next) =>
                  invalidateAndChange(() => {
                    setTargetAdapter(next);
                    if (next === session.agentId) {
                      setTargetModel(session.model ?? '');
                      setTargetThinking(sourceThinking(session));
                    } else {
                      setTargetModel('');
                      setTargetThinking('');
                    }
                  })
                }
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px]"
                menuMinWidth={220}
              />
            </div>
            <SessionModelFields
              adapterId={targetAdapter}
              model={targetModel}
              thinking={targetThinking}
              disabled={busy}
              onModelChange={(model) => invalidateAndChange(() => setTargetModel(model))}
              onThinkingChange={(thinking) =>
                invalidateAndChange(() => setTargetThinking(thinking))
              }
            />
          </div>

          <label className="flex flex-col gap-1 text-[10px] text-deck-muted">
            <span className="uppercase tracking-wider text-deck-muted/70">
              下一步指令 / 补充与修正
            </span>
            <textarea
              aria-label="下一步指令 / 补充与修正"
              value={instruction}
              disabled={busy}
              maxLength={102_400}
              rows={4}
              onChange={(event) =>
                invalidateAndChange(() => setInstruction(event.target.value))
              }
              className="resize-y rounded border border-deck-border bg-white/[0.04] px-3 py-2 text-[11px] leading-relaxed text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            />
          </label>

          <button
            type="button"
            onClick={() => void prepare()}
            disabled={
              busy ||
              !instruction.trim() ||
              executionFailure?.successorCleanup === 'failed'
            }
            className="self-start rounded bg-status-working/30 px-3 py-1.5 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            {!preparing && preparation ? <RefreshIcon className="mr-1 inline h-3 w-3" /> : null}
            {preparing
              ? '正在压缩会话上下文…'
              : preparation
                ? '重新生成续接上下文'
                : '生成续接上下文'}
          </button>

          {preparation && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-deck-muted">
                <h3 className="font-medium text-deck-text">续接上下文预览</h3>
                <span>
                  {qualityLabel(preparation.quality)} · 约{' '}
                  {preparation.metrics.estimatedPromptTokens.toLocaleString()} tokens · 保留{' '}
                  {preparation.metrics.includedUserMessages} 条用户输入
                </span>
              </div>
              <textarea
                aria-label="续接上下文预览"
                readOnly
                value={preparation.preview}
                rows={16}
                className="min-h-[260px] w-full resize-y rounded border border-deck-border bg-white/[0.04] px-3 py-2 font-mono text-[11px] leading-relaxed text-deck-text outline-none"
              />
              {(preparation.previewTruncated || preparation.warnings.length > 0) && (
                <div className="rounded bg-status-waiting/10 px-3 py-2 text-[10px] text-status-waiting">
                  {preparation.previewTruncated && <div>预览已截断；目标会话仍会收到完整上下文。</div>}
                  {preparation.warnings.map((warning) => (
                    <div key={`${warning.code}:${warning.message}`}>{warningLabel(warning.code)}</div>
                  ))}
                </div>
              )}
            </section>
          )}

          {executionFailure && (
            <div
              role="alert"
              className="space-y-2 rounded bg-status-error/10 px-3 py-2 text-[11px] text-status-error"
            >
              <div>⚠️ {executionFailureLabel(executionFailure)}</div>
              {executionFailure.successorCleanup === 'failed' && (
                <button
                  type="button"
                  onClick={() => {
                    pendingOrphanAcknowledgements.delete(sessionId);
                    setExecutionFailure(null);
                  }}
                  className="rounded border border-status-error/40 px-2 py-1 text-[10px] hover:bg-status-error/10"
                >
                  我已关闭该会话，允许重新生成
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="rounded bg-status-waiting/10 px-3 py-2 text-[11px] text-status-waiting">
              ⚠️ {error}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-deck-border px-4 py-3">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy || !preparation}
            className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
          >
            {!committing && <HandOffIcon className="mr-1 inline h-3 w-3" />}
            {committing ? '正在创建续接会话…' : '打开新会话接力'}
          </button>
        </footer>
      </div>
    </div>
  );
}
