import { useEffect, useState, type JSX } from 'react';
import { RefreshIcon, SaveIcon, TrashIcon } from '../icons';

export function GrokAgentsMdEditor({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const [loaded, setLoaded] = useState<{ content: string; isCustom: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const refresh = (): void => {
    setError(null);
    void window.api
      .getGrokAgentsMd()
      .then((result) => {
        setLoaded(result);
        setDraft(result.content);
      })
      .catch((reason: unknown) => {
        setError(`读取失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
  };

  useEffect(() => refresh(), []);

  const dirty = loaded !== null && draft !== loaded.content;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSavedHint(null);
    try {
      const written = await window.api.saveGrokAgentsMd(draft);
      setLoaded(written);
      if (written.content !== draft) setDraft(written.content);
      setSavedHint('已保存。下次新建 Grok Build 会话生效。');
    } catch (reason) {
      setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    const confirmed = await window.api.confirmDialog({
      title: '恢复默认',
      message: '确定要丢弃自定义副本，回落到应用内置 GROK_AGENTS.md 吗？',
      detail: '只删除 Agent Deck userData 下的副本；不会修改 ~/.grok 下的任何文件。',
      okLabel: '恢复默认',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setSavedHint(null);
    try {
      const result = await window.api.resetGrokAgentsMd();
      setLoaded({ content: result.content, isCustom: false });
      setDraft(result.content);
      setSavedHint('已恢复默认。下次新建 Grok Build 会话生效。');
    } catch (reason) {
      setError(`重置失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loaded === null && error === null) {
    return <div className="text-[11px] text-deck-muted">读取中…</div>;
  }

  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {loaded?.isCustom ? '当前为用户自定义副本（覆盖内置）' : '当前为应用内置默认'}
        ，通过 ACP 注入新建的 Grok Build 会话；不会写入用户级 Grok 配置。
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="no-drag h-64 resize-y rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20"
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] leading-snug text-deck-muted/60">
          {dirty ? '有未保存改动' : '无改动'}
        </div>
        <div className="no-drag flex items-center gap-1">
          {dirty && (
            <button
              type="button"
              onClick={refresh}
              disabled={busy}
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text disabled:opacity-50"
            >
              <RefreshIcon className="mr-1 inline h-3 w-3" />撤销
            </button>
          )}
          {loaded?.isCustom && (
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy}
              title="删除 Agent Deck 自定义副本，回落到内置 GROK_AGENTS.md"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-status-waiting/80 hover:bg-status-waiting/20 disabled:opacity-50"
            >
              <TrashIcon className="mr-1 inline h-3 w-3" />恢复默认
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="rounded bg-status-working/20 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/30 disabled:opacity-40"
          >
            <SaveIcon className="mr-1 inline h-3 w-3" />保存
          </button>
        </div>
      </div>
      {error && <div className="text-[10px] leading-snug text-status-waiting">{error}</div>}
      {savedHint && !error && (
        <div className="text-[10px] leading-snug text-deck-muted/80">{savedHint}</div>
      )}
    </div>
  );
}
