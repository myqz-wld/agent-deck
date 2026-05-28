import { useEffect, useRef, useState, type JSX } from 'react';
import type { AssetKind, AssetMeta } from '@shared/types';
import { ASSET_LIMITS, ASSET_NAME_REGEX } from '@shared/types';

/**
 * 用户自定义 agent / skill 编辑器（CHANGELOG_57 C3 / plan assets-codex-user-and-ui-unify-20260521
 * §D5 §D7 双 adapter 编辑姿势）。
 *
 * 字段（按 kind 分流）：
 * - 共用：name (slug，仅新建时可填) / description (必填) / body (markdown 正文)
 * - agent only：model (必填，opus/sonnet/haiku 下拉) / tools (逗号分隔，可空)
 *
 * **plan §D5 升级**:接 `adapter` prop（'claude-code' | 'codex-cli'，必传，由 sub-tab 锁定）
 * - 新建模式：adapter = 当前 sub-tab 值（在 Codex sub-tab 内点 + 新建则 adapter='codex-cli'）
 * - 编辑模式：adapter = `asset.adapter`（与 name 同款 read-only 不可改;改 adapter = 跨 root mv,
 *   本批不实现）
 *
 * mount 行为：
 * - asset === null：新建模式，全部空字段
 * - asset !== null：编辑模式，调 getAssetContent(asset.adapter) 拉完整 md 解析 frontmatter + body
 *
 * dirty 契约：本组件用本地 dirty state 自管，弹关闭确认；不向父级上报（与
 * ClaudeMdEditor 不同，那个是嵌在设置里的常驻 textarea，本编辑器只在 modal 模式下打开）。
 *
 * **plan §D3 不变量 #4**：codex+agent 组合本组件不会进入（AssetsTab Codex sub-tab Agents 内
 * 不显「+ 新建 Agent」按钮 + bundled 不可编辑;但 IPC 层仍硬拒做 defense in depth）。
 */

interface Props {
  kind: AssetKind;
  /** plan §D5：adapter 必传（由 sub-tab 锁定）。 */
  adapter: 'claude-code' | 'codex-cli';
  /** null = 新建模式；AssetMeta = 编辑模式（来源固定为 user）。 */
  asset: AssetMeta | null;
  onClose: () => void;
  /** 保存成功后回调，让父级刷新列表。 */
  onSaved: () => void;
}

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];

export function AssetEditor({ kind, adapter, asset, onClose, onSaved }: Props): JSX.Element {
  const isEdit = asset !== null;
  const [name, setName] = useState(asset?.name ?? '');
  const [description, setDescription] = useState(asset?.description ?? '');
  const [tools, setTools] = useState(asset?.tools ?? '');
  const [model, setModel] = useState(asset?.model ?? (kind === 'agent' ? 'opus' : ''));
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(isEdit); // 编辑模式 mount 时 fetch 加载
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /** mounted ref 防 save/remove 后 finally 写孤儿 state（CHANGELOG_57 R1·F14）：
   *  成功路径 onSaved+onClose 让父级 unmount，finally 里 setBusy(false) 是无效写。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isEdit || !asset) return;
    // CHANGELOG_57 R1·F13：mount fetch 加 cancel flag，防 strict mode dev 双跑 / 快速切换 asset
    // 时孤儿 then 写到旧 body。fetch 失败也算 cancel scope 内（防写孤儿 error）。
    let cancelled = false;
    void window.api
      // plan §D7：getAssetContent 第 4 参数 adapter 必传（user 资产也按 adapter narrow 派发）
      .getAssetContent(asset.kind, asset.name, 'user', asset.adapter)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          // 拆 frontmatter / body
          const m = r.content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
          setBody(m ? m[2].replace(/^\n+/, '') : r.content);
        } else {
          setError(`读取失败：${r.reason ?? '未知'}`);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isEdit, asset]);

  // 校验链与 main 端 ipc/assets.ts:parseUserAssetInput 完全对齐（CHANGELOG_57 R1·F8 收口）：
  // - name slug 用共享 ASSET_NAME_REGEX（首字符 a-z/0-9 + 后续 a-z/0-9/-，长度 1-64）
  // - description / model / tools 单行长字符串：禁含 \n 与 ---（防 F2 round-trip 丢 + F3 frontmatter 注入）
  // - 长度上限来自共享 ASSET_LIMITS
  const nameError = !isEdit
    ? name.length === 0
      ? '名称不能为空'
      : name.length > ASSET_LIMITS.name
        ? `名称太长（最多 ${ASSET_LIMITS.name} 字）`
        : !ASSET_NAME_REGEX.test(name)
          ? '名称只能用小写字母、数字和短横线，首字符必须是字母或数字'
          : null
    : null;
  const descError = description.trim().length === 0
    ? '说明不能为空'
    : description.length > ASSET_LIMITS.description
      ? `说明太长（最多 ${ASSET_LIMITS.description} 字）`
      : /[\r\n]/.test(description)
        ? '说明必须写在一行内'
        : description.includes('---')
          ? '说明不能包含「---」字符'
          : null;
  const modelError = kind === 'agent'
    ? model.trim().length === 0
      ? '模型不能为空'
      : model.length > ASSET_LIMITS.model
        ? `模型名太长（最多 ${ASSET_LIMITS.model} 字）`
        : /[\r\n]/.test(model)
          ? '模型名必须写在一行内'
          : model.includes('---')
            ? '模型名不能包含「---」字符'
            : null
    : null;
  const toolsError = kind === 'agent' && tools.length > 0
    ? tools.length > ASSET_LIMITS.tools
      ? `工具列表太长（最多 ${ASSET_LIMITS.tools} 字）`
      : /[\r\n]/.test(tools)
        ? '工具列表必须写在一行内（逗号分隔）'
        : tools.includes('---')
          ? '工具列表不能包含「---」字符'
          : null
    : null;
  const bodyError = body.length > ASSET_LIMITS.body
    ? `正文太长（最多 ${ASSET_LIMITS.body} 字，约 256KB）`
    : body.split('\n', 1)[0].trim() === '---'
      ? '正文首行不能是「---」'
      : null;
  const hasError = !!(nameError || descError || modelError || toolsError || bodyError);

  const handleChange = <T,>(setter: (v: T) => void) => (v: T): void => {
    setter(v);
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (hasError) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.saveUserAsset({
        kind,
        adapter,
        name,
        description: description.trim(),
        tools: kind === 'agent' ? tools.trim() || undefined : undefined,
        model: kind === 'agent' ? model.trim() || undefined : undefined,
        body,
      });
      if (r.ok) {
        onSaved();
        onClose();
      } else if (mountedRef.current) {
        setError(`保存失败：${r.reason ?? '未知'}`);
      }
    } catch (err) {
      if (mountedRef.current) setError(`保存失败：${(err as Error).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!asset) return;
    // plan §不变量 #8 + Step 3.5：codex skill 删除 confirmDialog detail 含 restart codex 提示
    // （删除后 codex CLI in-memory cache 残留场景，让用户在确认前就知道）。claude skill 不需提示。
    const codexSkillHint =
      asset.kind === 'skill' && asset.adapter === 'codex-cli'
        ? '\n注意：已经在跑的 Codex 会话需重启后才能加载新内容。'
        : '';
    const ok = await window.api.confirmDialog({
      title: `删除${kind === 'agent' ? ' Agent' : ' Skill'}`,
      message: `确定要删除「${asset.name}」吗？`,
      detail: (kind === 'skill'
        ? `将递归删除目录 ${asset.absPath} 所在的 Skill 子目录。`
        : `将删除文件 ${asset.absPath}。`) + codexSkillHint,
      okLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      // plan §D7 + reviewer-codex MED-D：deleteUserAsset 三参（含 adapter，只删当前 root）
      const r = await window.api.deleteUserAsset(asset.kind, asset.name, asset.adapter);
      if (r.ok) {
        onSaved();
        onClose();
      } else if (mountedRef.current) {
        setError(`删除失败：${r.reason ?? '未知'}`);
      }
    } catch (err) {
      if (mountedRef.current) setError(`删除失败：${(err as Error).message}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleClose = async (): Promise<void> => {
    if (!dirty) {
      onClose();
      return;
    }
    const ok = await window.api.confirmDialog({
      title: '关闭编辑器',
      message: '有未保存改动，确定要丢弃吗？',
      okLabel: '丢弃并关闭',
      cancelLabel: '继续编辑',
      destructive: true,
    });
    if (ok) onClose();
  };

  // plan §D5 + reviewer-claude R2 LOW-2：modal header 加 adapter chip,与 ContentViewerModal 对齐
  const adapterLabel = adapter === 'claude-code' ? '[claude]' : '[codex]';
  const adapterChipClass =
    adapter === 'claude-code'
      ? 'bg-status-working/20 text-status-working'
      : 'bg-status-running/20 text-status-running';

  // placeholder 文案 sub-tab 切换：claude → ~/.claude/{agents,skills}/ / codex → ~/.codex/skills/
  const pathHint = !isEdit
    ? adapter === 'claude-code'
      ? `保存后即文件名(Agent → ~/.claude/agents/${name || '<名称>'}.md;Skill → ~/.claude/skills/${name || '<名称>'}/SKILL.md)`
      : `保存后即文件名(Skill → ~/.codex/skills/${name || '<名称>'}/SKILL.md;Codex 不支持自定义 Agent)`
    : '';

  const title = isEdit
    ? `编辑${kind === 'agent' ? ' Agent' : ' Skill'}:${asset?.name}`
    : `新建${kind === 'agent' ? ' Agent' : ' Skill'}`;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[400px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <code className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${adapterChipClass}`}>{adapterLabel}</code>
            <h3 className="truncate text-[13px] font-medium">{title}</h3>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            ✕
          </button>
        </header>

        {error && (
          <div className="mb-2 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto scrollbar-deck flex flex-col gap-2 pr-1">
          <Field label="名称" error={nameError}>
            <input
              type="text"
              value={name}
              onChange={(e) => handleChange(setName)(e.target.value)}
              disabled={isEdit || busy}
              placeholder="my-skill"
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
            />
            {!isEdit && <div className="text-[10px] text-deck-muted/60">{pathHint}</div>}
          </Field>

          <Field label="说明" error={descError}>
            <textarea
              value={description}
              onChange={(e) => handleChange(setDescription)(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="说明这个 Skill / Agent 的用途和触发场景…"
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-50"
            />
          </Field>

          {kind === 'agent' && (
            <>
              <Field label="模型" error={modelError}>
                <select
                  value={model}
                  onChange={(e) => handleChange(setModel)(e.target.value)}
                  disabled={busy}
                  className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field label="工具（逗号分隔，可留空）" error={toolsError}>
                <input
                  type="text"
                  value={tools}
                  onChange={(e) => handleChange(setTools)(e.target.value)}
                  disabled={busy}
                  placeholder="Read, Grep, Glob, Bash"
                  className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
                />
              </Field>
            </>
          )}

          <Field label="正文（Markdown）" error={bodyError}>
            <textarea
              value={body}
              onChange={(e) => handleChange(setBody)(e.target.value)}
              disabled={busy}
              spellCheck={false}
              className="h-48 w-full resize-y rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-50"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              placeholder="# My Skill\n\n写清触发条件、执行步骤和约束…"
            />
          </Field>
        </div>

        <footer className="mt-3 flex items-center justify-between gap-2">
          <div className="text-[10px] text-deck-muted/60">
            {dirty ? '有未保存改动' : '无改动'}
          </div>
          <div className="flex items-center gap-1">
            {isEdit && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="rounded bg-status-waiting/15 px-2 py-1 text-[10px] text-status-waiting hover:bg-status-waiting/25 disabled:opacity-40"
              >
                删除
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || hasError || !dirty}
              className="rounded bg-status-working/20 px-3 py-1 text-[10px] text-status-working hover:bg-status-working/30 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px]">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
      {error && <span className="text-[10px] text-status-waiting/90">{error}</span>}
    </label>
  );
}
