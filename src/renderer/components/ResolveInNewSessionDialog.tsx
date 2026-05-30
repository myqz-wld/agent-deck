/**
 * 「起新会话解决」dialog（plan issue-tracker-mcp-20260529 §Step 3.8.4 / §D8）。
 *
 * - 三必填字段: adapter / cwd / prompt
 * - cwd 默认 = issue.cwd（issue 无 cwd 时空）;prompt 默认按 §D8 template 拼（null 字段整段省略）
 * - permissionMode / codexSandbox / claudeCodeSandbox 三 optional 字段
 * - submit 调 `window.api.issuesResolveInNewSession`，spawn 成功后回写 issue + emit kind=updated
 * - **UI throttle**: submit 期间 button disabled 防 React 双 click;IPC handler 内部 in-flight Promise
 *   dedupe 兜底（§D14 UI throttle 兜底）
 */

import { useEffect, useMemo, useState, type JSX } from 'react';
import type { IssueRecord } from '@shared/types';
import {
  PERMISSION_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
  type CodexSandboxChoice,
  type ClaudeSandboxChoice,
} from '@renderer/lib/sandbox-options';

interface Props {
  issue: IssueRecord;
  onClose: () => void;
  onResolved: (updated: IssueRecord) => void;
}

interface AdapterInfo {
  id: string;
  displayName: string;
  capabilities: { canCreateSession?: boolean; canSetPermissionMode?: boolean };
}

function buildDefaultPrompt(issue: IssueRecord): string {
  const parts: string[] = [`请处理 issue: ${issue.title}`, '', '## 描述', issue.description];
  if (issue.repro && issue.repro.trim().length > 0) {
    parts.push('', '## 重现步骤', issue.repro);
  }
  if (issue.logsRef) {
    const lr = issue.logsRef;
    parts.push('', '## 日志参考');
    parts.push(`- date: ${lr.date}`);
    parts.push(
      `- tsRange: ${
        lr.tsRange
          ? `${new Date(lr.tsRange.start).toISOString()} ~ ${new Date(lr.tsRange.end).toISOString()}`
          : 'N/A'
      }`,
    );
    parts.push(`- scopes: ${lr.scopes && lr.scopes.length > 0 ? lr.scopes.join(',') : 'N/A'}`);
    parts.push(`- note: ${lr.note ?? 'N/A'}`);
  }
  const apps = issue.appendices ?? [];
  if (apps.length > 0) {
    parts.push('', `## 后续补充（${apps.length} 条）`);
    apps
      .slice()
      .sort((a, b) => a.appendedAt - b.appendedAt)
      .forEach((a, idx) => {
        parts.push(`[${idx + 1}] ${new Date(a.appendedAt).toISOString()}: ${a.body}`);
      });
  }
  return parts.join('\n');
}

export function ResolveInNewSessionDialog({ issue, onClose, onResolved }: Props): JSX.Element {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adapter, setAdapter] = useState('claude-code');
  const [cwd, setCwd] = useState(issue.cwd ?? '');
  const defaultPrompt = useMemo(() => buildDefaultPrompt(issue), [issue]);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [permissionMode, setPermissionMode] = useState('');
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxChoice>('');
  const [claudeCodeSandbox, setClaudeCodeSandbox] = useState<ClaudeSandboxChoice>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.listAdapters().then((rows) => {
      const usable = rows.filter((a) => a.capabilities.canCreateSession);
      setAdapters(usable);
      if (usable.length > 0 && !usable.find((a) => a.id === adapter)) {
        setAdapter(usable[0].id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 与 NewSessionDialog 同款按 adapter capability 决定字段可见性
  const selectedAdapter = adapters.find((a) => a.id === adapter);
  const showPermissionMode = selectedAdapter?.capabilities.canSetPermissionMode ?? false;
  const showCodexSandbox = adapter === 'codex-cli';
  const showClaudeCodeSandbox = adapter === 'claude-code';

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    if (!prompt.trim()) {
      setError('首条 prompt 不能为空');
      return;
    }
    setBusy(true);
    try {
      const result = await window.api.issuesResolveInNewSession({
        issueId: issue.id,
        adapter,
        cwd: cwd.trim() || undefined,
        prompt,
        ...(showPermissionMode && permissionMode ? { permissionMode } : {}),
        ...(showCodexSandbox && codexSandbox ? { codexSandbox } : {}),
        ...(showClaudeCodeSandbox && claudeCodeSandbox ? { claudeCodeSandbox } : {}),
      });
      onResolved(result.issue);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="frosted-frame fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-[640px] flex-col rounded-lg bg-deck-bg shadow-xl">
        <div className="flex items-center justify-between border-b border-deck-border px-4 py-2">
          <h2 className="text-sm font-medium text-deck-text">起新会话解决问题</h2>
          <button onClick={onClose} className="text-deck-muted hover:text-deck-text">
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto scrollbar-deck px-4 py-3">
          {error && (
            <div className="rounded bg-status-waiting/15 px-2 py-1 text-xs text-status-waiting">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
              Adapter
            </label>
            <select
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
              disabled={busy}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
              工作目录（留空则用问题来源目录，仍为空则用主目录）
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/project"
              disabled={busy}
              maxLength={4096}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
              首条 prompt（已根据问题内容预填，可编辑）
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={12}
              disabled={busy}
              maxLength={102400}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            />
            <div className="text-[10px] text-deck-muted">{prompt.length} / 102400</div>
          </div>
          {showPermissionMode && (
            <div className="space-y-1">
              <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
                权限模式（可选；留空用默认）
              </label>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value)}
                disabled={busy}
                className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
              >
                <option value="">跟随默认</option>
                {PERMISSION_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value} title={p.title}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {showCodexSandbox && (
            <div className="space-y-1">
              <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
                沙盒（可选；留空用默认）
              </label>
              <select
                value={codexSandbox}
                onChange={(e) => setCodexSandbox(e.target.value as CodexSandboxChoice)}
                disabled={busy}
                className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
              >
                {CODEX_SANDBOX_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value} title={p.title}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {showClaudeCodeSandbox && (
            <div className="space-y-1">
              <label className="block text-[10px] uppercase tracking-wide text-deck-muted">
                系统沙盒（可选；留空用默认）
              </label>
              <select
                value={claudeCodeSandbox}
                onChange={(e) => setClaudeCodeSandbox(e.target.value as ClaudeSandboxChoice)}
                disabled={busy}
                className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none disabled:opacity-50"
              >
                {CLAUDE_SANDBOX_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value} title={p.title}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex gap-1.5 border-t border-deck-border px-4 py-2">
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded bg-white/[0.06] px-3 py-1 text-xs text-deck-muted hover:text-deck-text disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={busy}
            className="rounded bg-status-working/30 px-3 py-1 text-xs text-status-working hover:bg-status-working/50 disabled:opacity-50"
          >
            {busy ? '正在起新会话…' : '起新会话'}
          </button>
        </div>
      </div>
    </div>
  );
}
