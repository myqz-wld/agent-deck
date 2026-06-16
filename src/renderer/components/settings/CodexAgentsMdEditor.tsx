import { useEffect, useState, type JSX } from 'react';

/**
 * 编辑 Codex 视角应用约定(CODEX_AGENTS.md)。
 *
 * 与 ClaudeMdEditor.tsx 字面镜像(claude-config 同款机制)。差异:
 * - 用户副本路径 `<userData>/agent-deck-codex-agents.md`(对偶 `agent-deck-claude.md`)
 * - save / reset 后只更新 app userData 副本；新建 Codex app-server 会话时通过
 *   developerInstructions 注入
 * - 已运行的 codex SDK 会话不受影响(thread system prompt 已固化进 LLM 上下文);只有「下次
 *   新建会话」生效
 *
 * 父级 dirty 上报契约同 ClaudeMdEditor — `onDirtyChange(dirty)` 让父级关闭弹窗时拦截二次确认,
 * 卸载时显式上报 false 防 ref 残留 true 让下次打开误拦截。
 */

export interface CodexAgentsMdEditorProps {
  /** 草稿 dirty 状态变更回调(父级拦截关闭用)。 */
  onDirtyChange?: (dirty: boolean) => void;
}

export function CodexAgentsMdEditor({ onDirtyChange }: CodexAgentsMdEditorProps): JSX.Element {
  const [loaded, setLoaded] = useState<{ content: string; isCustom: boolean } | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const refresh = (): void => {
    setError(null);
    void window.api
      .getCodexAgentsMd()
      .then((r) => {
        setLoaded(r);
        setDraft(r.content);
      })
      .catch((err: unknown) => setError(`读取失败：${(err as Error).message ?? String(err)}`));
  };

  useEffect(() => {
    refresh();
  }, []);

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
      const written = await window.api.saveCodexAgentsMd(draft);
      setLoaded({ content: written.content, isCustom: written.isCustom });
      if (written.content !== draft) setDraft(written.content);
      setSavedHint('已保存。下次新建 Codex 会话会自动使用新内容。');
    } catch (err) {
      setError(`保存失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    if (
      !(await window.api.confirmDialog({
        title: '恢复默认',
        message: '确定要丢弃自定义副本，回落到应用内置 CODEX_AGENTS.md 吗？',
        detail: '此操作会删除 userData 下的用户副本文件；新 Codex 会话将使用内置内容。',
        okLabel: '恢复默认',
        cancelLabel: '取消',
        destructive: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSavedHint(null);
    try {
      const r = await window.api.resetCodexAgentsMd();
      setLoaded({ content: r.content, isCustom: false });
      setDraft(r.content);
      setSavedHint('已恢复默认。下次新建 Codex 会话生效。');
    } catch (err) {
      setError(`重置失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (loaded === null && error === null) {
    return <div className="text-[11px] text-deck-muted">读取中…</div>;
  }

  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      <div className="text-[10px] text-deck-muted/70 leading-snug">
        {loaded?.isCustom ? '当前为用户自定义副本（覆盖内置）' : '当前为应用内置默认'}
        ，会随新建的 Codex 会话自动加载。改动仅对「下次新建 Codex 会话」生效。
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="no-drag h-64 resize-y rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20"
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-deck-muted/60 leading-snug">
          {dirty ? '有未保存改动' : '无改动'}
        </div>
        <div className="no-drag flex items-center gap-1">
          {dirty && (
            <button
              type="button"
              onClick={() => refresh()}
              disabled={busy}
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text disabled:opacity-50"
            >
              撤销
            </button>
          )}
          {loaded?.isCustom && (
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy}
              title="删除用户副本，回落到应用内置 CODEX_AGENTS.md"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-status-waiting/80 hover:bg-status-waiting/20 disabled:opacity-50"
            >
              恢复默认
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className="rounded bg-status-working/20 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/30 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
      {error && <div className="text-[10px] text-status-waiting leading-snug">{error}</div>}
      {savedHint && !error && (
        <div className="text-[10px] text-deck-muted/80 leading-snug">{savedHint}</div>
      )}
    </div>
  );
}
