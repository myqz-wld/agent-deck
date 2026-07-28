import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import log from '@renderer/utils/logger';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '../../expandable-content';
import { RefreshIcon, SaveIcon, TrashIcon } from '../../icons';

type ConventionAdapter = 'claude-code' | 'codex-cli' | 'grok-build';
type ConventionAction = 'load' | 'reset' | 'save';

const logger = log.scope('renderer-convention-document-editor');
const ACTION_ERROR_COPY: Record<ConventionAction, string> = {
  load: '读取失败，请重试。',
  reset: '恢复默认失败，请重试。',
  save: '保存失败，请重试。',
};

interface LoadedConventionDocument {
  content: string;
  isCustom: boolean;
}

interface ResetConventionDocument {
  content: string;
}

export interface ConventionDocumentEditorConfig {
  adapter: ConventionAdapter;
  adapterName: 'Claude Code' | 'Codex CLI' | 'Grok Build';
  fileName: 'CLAUDE.md' | 'CODEX_AGENTS.md' | 'GROK_AGENTS.md';
  description: string;
  saveHint: string;
  resetHint: string;
  resetDetail: string;
  load: () => Promise<LoadedConventionDocument>;
  save: (content: string) => Promise<LoadedConventionDocument>;
  reset: () => Promise<ResetConventionDocument>;
}

export interface ConventionDocumentEditorProps {
  config: ConventionDocumentEditorConfig;
  onDirtyChange?: (dirty: boolean) => void;
}

function safeErrorKind(reason: unknown): 'function' | 'null' | 'object' | 'primitive' | 'string' {
  if (reason === null) return 'null';
  if (typeof reason === 'object') return 'object';
  if (typeof reason === 'string') return 'string';
  if (typeof reason === 'function') return 'function';
  return 'primitive';
}

function logActionFailure(
  action: ConventionAction,
  adapter: ConventionAdapter,
  reason: unknown,
): void {
  logger.error('convention document action failed', {
    action,
    adapter,
    category: 'request-rejected',
    errorKind: safeErrorKind(reason),
  });
}

export function ConventionDocumentEditor({
  config,
  onDirtyChange,
}: ConventionDocumentEditorProps): JSX.Element {
  const [loaded, setLoaded] = useState<LoadedConventionDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequenceRef.current;
    setBusy(true);
    setError(null);
    setSavedHint(null);
    try {
      const result = await config.load();
      if (sequence !== loadSequenceRef.current) return;
      setLoaded(result);
      setDraft(result.content);
    } catch (reason) {
      if (sequence === loadSequenceRef.current) {
        logActionFailure('load', config.adapter, reason);
        setError(ACTION_ERROR_COPY.load);
      }
    } finally {
      if (sequence === loadSequenceRef.current) setBusy(false);
    }
  }, [config]);

  useEffect(() => {
    void refresh();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [refresh]);

  const dirty = loaded !== null && draft !== loaded.content;

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => {
    onDirtyChangeRef.current?.(false);
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSavedHint(null);
    try {
      const written = await config.save(draft);
      setLoaded(written);
      setDraft(written.content);
      setSavedHint(config.saveHint);
    } catch (reason) {
      logActionFailure('save', config.adapter, reason);
      setError(ACTION_ERROR_COPY.save);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    const confirmed = await window.api.confirmDialog({
      title: '恢复默认',
      message: `确定要删除自定义副本，恢复应用内置的 ${config.fileName} 吗？`,
      detail: config.resetDetail,
      okLabel: '恢复默认',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setSavedHint(null);
    try {
      const result = await config.reset();
      setLoaded({ content: result.content, isCustom: false });
      setDraft(result.content);
      setSavedHint(config.resetHint);
    } catch (reason) {
      logActionFailure('reset', config.adapter, reason);
      setError(ACTION_ERROR_COPY.reset);
    } finally {
      setBusy(false);
    }
  };

  const confirmExpandedClose = (): Promise<boolean> => window.api.confirmDialog({
    title: '收起展开编辑器',
    message: `${config.fileName} 还有未保存的草稿，仍要收起吗？`,
    detail: '草稿会保留在应用约定页面，可继续编辑或保存。',
    okLabel: '收起',
    cancelLabel: '继续编辑',
  });

  if (loaded === null) {
    if (!error) {
      return <div className="text-[11px] text-deck-muted">正在读取…</div>;
    }
    return (
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-status-waiting">
        <span>{error}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="min-h-8 rounded bg-white/10 px-2 text-deck-text disabled:opacity-50"
        >
          重试
        </button>
      </div>
    );
  }

  const ariaLabel = `${config.adapterName} 应用约定`;
  const payload: DiagnosticContentPayload = {
    kind: 'diagnostic',
    text: draft,
    metadata: {
      adapter: config.adapter,
      fileName: config.fileName,
      isCustom: loaded.isCustom,
      dirty,
    },
  };
  const actions = (
    <EditorActions
      busy={busy}
      dirty={dirty}
      isCustom={loaded.isCustom}
      fileName={config.fileName}
      onRefresh={() => void refresh()}
      onReset={() => void reset()}
      onSave={() => void save()}
    />
  );

  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-[11px]">
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {loaded.isCustom ? '当前使用用户自定义副本' : '当前使用应用内置默认内容'}。
        {config.description}
      </div>
      <div className="relative min-w-0">
        <ConventionTextArea
          ariaLabel={ariaLabel}
          value={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <ExpandableContent<DiagnosticContentPayload>
          identity={{
            sessionId: 'agent-deck-application-conventions',
            kind: 'diagnostic',
            diagnosticId: config.adapter,
          }}
          payload={payload}
          title={`编辑 ${ariaLabel}`}
          triggerLabel={`展开编辑 ${ariaLabel}`}
          dirty={dirty}
          confirmClose={confirmExpandedClose}
          actions={actions}
          validation={(
            <EditorStatus
              dirty={dirty}
              error={error}
              savedHint={savedHint}
            />
          )}
          heavyView={{
            id: `application-convention-editor:${config.adapter}`,
            kind: 'custom',
            render: () => (
              <ConventionTextArea
                ariaLabel={`${ariaLabel}（展开编辑）`}
                value={draft}
                onChange={setDraft}
                disabled={busy}
                expanded
              />
            ),
          }}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <EditorStatus dirty={dirty} error={error} savedHint={savedHint} />
        {actions}
      </div>
    </div>
  );
}

function ConventionTextArea({
  ariaLabel,
  value,
  onChange,
  disabled,
  expanded = false,
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  expanded?: boolean;
}): JSX.Element {
  return (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      spellCheck={false}
      className={[
        'no-drag w-full rounded border border-deck-border bg-white/[0.04]',
        'p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-60',
        expanded ? 'min-h-[60vh] flex-1 resize-none' : 'h-64 resize-y pr-12',
      ].join(' ')}
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    />
  );
}

function EditorActions({
  busy,
  dirty,
  isCustom,
  fileName,
  onRefresh,
  onReset,
  onSave,
}: {
  busy: boolean;
  dirty: boolean;
  isCustom: boolean;
  fileName: string;
  onRefresh: () => void;
  onReset: () => void;
  onSave: () => void;
}): JSX.Element {
  return (
    <div className="no-drag flex min-w-0 flex-wrap items-center justify-end gap-1">
      {dirty && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="min-h-8 rounded bg-white/8 px-2 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text disabled:opacity-50"
        >
          <RefreshIcon className="mr-1 inline h-3 w-3" />撤销
        </button>
      )}
      {isCustom && (
        <button
          type="button"
          onClick={onReset}
          disabled={busy}
          title={`删除自定义副本，恢复应用内置的 ${fileName}`}
          className="min-h-8 rounded bg-white/8 px-2 text-[10px] text-status-waiting/80 hover:bg-status-waiting/20 disabled:opacity-50"
        >
          <TrashIcon className="mr-1 inline h-3 w-3" />恢复默认
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={busy || !dirty}
        className="min-h-8 rounded bg-status-working/20 px-2 text-[10px] text-status-working hover:bg-status-working/30 disabled:opacity-40"
      >
        <SaveIcon className="mr-1 inline h-3 w-3" />保存
      </button>
    </div>
  );
}

function EditorStatus({
  dirty,
  error,
  savedHint,
}: {
  dirty: boolean;
  error: string | null;
  savedHint: string | null;
}): JSX.Element {
  if (error) {
    return <div className="text-[10px] leading-snug text-status-waiting">{error}</div>;
  }
  if (savedHint) {
    return <div className="text-[10px] leading-snug text-deck-muted/80">{savedHint}</div>;
  }
  return (
    <div className="text-[10px] leading-snug text-deck-muted/60">
      {dirty ? '有未保存的改动' : '没有未保存的改动'}
    </div>
  );
}
