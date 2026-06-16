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

import { cloneElement, useEffect, useId, useState, type JSX } from 'react';
import type { IssueRecord } from '@shared/types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import {
  getLastAdapter,
  getLastDefaults,
  setLastAdapter,
  setLastDefaults,
} from '@renderer/hooks/useLastSessionDefaults';
import {
  PERMISSION_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
  type CodexSandboxChoice,
  type ClaudeSandboxChoice,
  type PermissionModeChoice,
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
  // 闭环关键：把 issueId + 处置指引塞进 prompt，让解决会话能用 update_issue_status 自助标状态
  // （它被授权为本 issue 的「解决会话」）。否则解决会话拿不到 issueId 无从调 tool。
  // MED-1 轻量缓和（review Round 1）：明确「处理/修复完成后再改 status」——IPC 写回
  // resolutionSessionId 有数秒微延迟（先 await createSession 启动本会话才写回），诱导 agent
  // 把 status 变更放到首轮调查/修复之后，天然错开写回窗口，避免起动即调被当第三方 reject。
  parts.push(
    '',
    '---',
    '你是本 issue 的「解决会话」。请先调查并处理问题，**全部处理 / 修复完成后**再用 mcp 工具自助标记状态（无需用户去 UI 点）：',
    `- 修好了：update_issue_status({ issueId: "${issue.id}", status: "resolved", note: "简述怎么修的" })`,
    `- 没修好 / 需重开：update_issue_status({ issueId: "${issue.id}", status: "open", note: "说明原因" })`,
    '（若刚启动就调本工具收到「非源/解决会话」错误，是 resolutionSessionId 写回有数秒延迟所致——处理完再调通常即已写回。）',
    `issueId: ${issue.id}`,
  );
  return parts.join('\n');
}

export function ResolveInNewSessionDialog({ issue, onClose, onResolved }: Props): JSX.Element {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adapter, setAdapter] = useState<string>(() => getLastAdapter());
  const [cwd, setCwd] = useState(issue.cwd ?? '');
  // deep-review H1 INFO：buildDefaultPrompt 只需作 useState 初值（mount 后不再消费），用惰性初始化
  // 替代 useMemo（去掉每次 issue 变重算但不被用的死计算）。
  const [prompt, setPrompt] = useState(() => buildDefaultPrompt(issue));
  const [permissionMode, setPermissionMode] = useState<PermissionModeChoice>('bypassPermissions');
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxChoice>('');
  const [claudeCodeSandbox, setClaudeCodeSandbox] = useState<ClaudeSandboxChoice>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // deep-review H1 R2 LOW：adapter 列表加载失败 / 为空时禁止提交（否则用默认 'claude-code' 发起，
  // select 无 option、permission/sandbox 字段按错误 adapter 显示，最终 IPC 二次失败）。
  const [adaptersReady, setAdaptersReady] = useState(false);

  useEffect(() => {
    void window.api
      .listAdapters()
      .then((rows) => {
        const usable = rows.filter((a) => a.capabilities.canCreateSession);
        setAdapters(usable);
        setAdaptersReady(usable.length > 0);
        if (usable.length > 0) {
          setAdapter((current) => {
            const next =
              usable.find((a) => a.id === current)?.id
              ?? usable.find((a) => a.id === getLastAdapter())?.id
              ?? usable[0].id;
            setLastAdapter(next);
            return next;
          });
        }
      })
      .catch((e: unknown) => {
        // deep-review H1 MED：无 catch 时 reject 冒泡到 main.tsx unhandledrejection → 全屏 fatal；
        // adapter 列表空时 dialog 仍显示但 select 无选项 → 提示用户而非静默。
        setError(`无法加载 adapter 列表：${e instanceof Error ? e.message : String(e)}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // plan pending-tab-resume-and-new-session-default-20260602 §D2 BUG 2：与 NewSessionDialog
  // 共享 last-used 记忆。dialog mount 时 + adapter 切换时从 useLastSessionDefaults store 读回
  // 上次值；不要在「adapters 还没加载好」时跑（adapter 切到合法值后再跑）。
  useEffect(() => {
    const d = getLastDefaults(adapter);
    if (d.permissionMode !== undefined) setPermissionMode(d.permissionMode);
    if (d.claudeCodeSandbox !== undefined) setClaudeCodeSandbox(d.claudeCodeSandbox);
    if (d.codexSandbox !== undefined) setCodexSandbox(d.codexSandbox);
  }, [adapter]);

  // 与 NewSessionDialog 同款按 adapter capability 决定字段可见性
  const selectedAdapter = adapters.find((a) => a.id === adapter);
  const showPermissionMode = selectedAdapter?.capabilities.canSetPermissionMode ?? false;
  const showCodexSandbox = adapter === 'codex-cli';
  const showClaudeCodeSandbox = adapter === 'claude-code' || adapter === 'deepseek-claude-code';

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    // deep-review H1 R2 LOW：adapter 列表未就绪（加载失败 / 为空）→ 拒绝提交（避免用默认 adapter
    // 发起注定二次失败的会话）。
    if (!adaptersReady) {
      setError('adapter 列表不可用，无法起会话');
      return;
    }
    if (!prompt.trim()) {
      setError('第一条消息不能为空');
      return;
    }
    setBusy(true);
    try {
      const result = await window.api.issuesResolveInNewSession({
        issueId: issue.id,
        adapter,
        cwd: cwd.trim() || undefined,
        prompt,
        // plan pending-tab-resume-and-new-session-default-20260602 §D2：'default' = 跟随默认，
        // 不作为 per-session 覆盖传给主进程（主进程收到 'default' 也等价不传，与历史契约一致）。
        ...(showPermissionMode && permissionMode !== 'default' ? { permissionMode } : {}),
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
    // 根 div 不能叠 .frosted-frame：其 unlayered `position:relative` 会顶掉 Tailwind `@layer
    // utilities` 里的 `.fixed{position:fixed}`（CSS 级联 unlayered > layered），令 overlay 退回
    // 文档流而非相对 viewport 全屏。overlay 只需半透明遮罩 + 模糊。详见 LogViewerModal 顶部注释。
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-[640px] flex-col rounded-lg bg-deck-bg shadow-xl">
        <div className="flex items-center justify-between border-b border-deck-border px-4 py-2">
          <h2 className="text-sm font-medium text-deck-text">起新会话解决问题</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-deck-muted hover:text-deck-text">
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto scrollbar-deck px-4 py-3">
          {error && (
            <div className="rounded bg-status-waiting/15 px-2 py-1 text-xs text-status-waiting">
              {error}
            </div>
          )}
          {issue.resolutionSessionId && (
            <div className="rounded bg-status-waiting/15 px-2 py-1 text-[11px] text-status-waiting">
              ⚠️ 该问题已有解决会话（{issue.resolutionSessionId.slice(0, 8)}）。重新起新会话会替换
              resolutionSessionId，旧解决会话将失去自助改状态（update_issue_status）的授权。
            </div>
          )}
          <DialogField label="执行器">
            <DeckSelect
              value={adapter}
              onChange={(next) => {
                setAdapter(next);
                setLastAdapter(next);
              }}
              disabled={busy}
              options={adapters.map((a) => ({ value: a.id, label: a.displayName }))}
              buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-xs text-deck-text outline-none disabled:opacity-50"
            />
          </DialogField>
          <DialogField label="工作目录（留空则用问题来源目录，仍为空则用主目录）">
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/project"
              disabled={busy}
              maxLength={4096}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            />
          </DialogField>
          <DialogField label="第一条消息（已根据问题内容预填，可编辑）">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={12}
              disabled={busy}
              maxLength={102400}
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
            />
          </DialogField>
          <div className="-mt-2 text-[10px] text-deck-muted">{prompt.length} / 102400</div>
          {showPermissionMode && (
            <DialogField label="权限模式（跟随上次选；切 adapter 会重读）">
              <DeckSelect
                value={permissionMode}
                onChange={(v) => {
                  setPermissionMode(v);
                  setLastDefaults(adapter, { permissionMode: v });
                }}
                disabled={busy}
                options={PERMISSION_OPTIONS}
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-xs text-deck-text outline-none disabled:opacity-50"
              />
            </DialogField>
          )}
          {showCodexSandbox && (
            <DialogField label="沙盒（跟随上次选）">
              <DeckSelect
                value={codexSandbox}
                onChange={(v) => {
                  setCodexSandbox(v);
                  setLastDefaults(adapter, { codexSandbox: v });
                }}
                disabled={busy}
                options={CODEX_SANDBOX_OPTIONS}
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-xs text-deck-text outline-none disabled:opacity-50"
              />
            </DialogField>
          )}
          {showClaudeCodeSandbox && (
            <DialogField label="系统沙盒（跟随上次选）">
              <DeckSelect
                value={claudeCodeSandbox}
                onChange={(v) => {
                  setClaudeCodeSandbox(v);
                  setLastDefaults(adapter, { claudeCodeSandbox: v });
                }}
                disabled={busy}
                options={CLAUDE_SANDBOX_OPTIONS}
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-xs text-deck-text outline-none disabled:opacity-50"
              />
            </DialogField>
          )}
        </div>
        <div className="flex gap-1.5 border-t border-deck-border px-4 py-2">
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded bg-white/[0.06] px-3 py-1 text-xs text-deck-muted hover:text-deck-text disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || !adaptersReady}
            className="rounded bg-status-working/30 px-3 py-1 text-xs text-status-working hover:bg-status-working/50 disabled:opacity-50"
          >
            {busy ? '正在起新会话…' : '起新会话'}
          </button>
        </div>
      </div>
    </div>
  );
}

// deep-review H1 LOW（a11y）：label htmlFor 关联到唯一控件子节点（input/select/textarea）。
// 与 IssueDetail.Field 同款 cloneElement 注入 id 模式。
function DialogField({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[10px] uppercase tracking-wide text-deck-muted">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}
