import { useEffect, useRef, useState, type JSX } from 'react';
import type { AssetKind, AssetMeta } from '@shared/types';
import { ASSET_LIMITS, ASSET_NAME_REGEX } from '@shared/types';

/**
 * 用户自定义 agent / skill 编辑器（CHANGELOG_57 C3）。
 *
 * 字段（按 kind 分流）：
 * - 共用：name (slug，仅新建时可填) / description (必填) / body (markdown 正文)
 * - agent only：model (必填，opus/sonnet/haiku 下拉) / tools (逗号分隔，可空)
 *
 * mount 行为：
 * - asset === null：新建模式，全部空字段
 * - asset !== null：编辑模式，调 getAssetContent 拉完整 md 解析 frontmatter + body 填入
 *
 * dirty 契约：本组件用本地 dirty state 自管，弹关闭确认；不向父级上报（与
 * ClaudeMdEditor 不同，那个是嵌在设置里的常驻 textarea，本编辑器只在 modal 模式下打开）。
 */

interface Props {
  kind: AssetKind;
  /** null = 新建模式；AssetMeta = 编辑模式（来源固定为 user）。 */
  asset: AssetMeta | null;
  onClose: () => void;
  /** 保存成功后回调，让父级刷新列表。 */
  onSaved: () => void;
}

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];

export function AssetEditor({ kind, asset, onClose, onSaved }: Props): JSX.Element {
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
      .getAssetContent(asset.kind, asset.name, 'user')
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
      ? 'name 必填'
      : name.length > ASSET_LIMITS.name
        ? `name 长度需 ≤ ${ASSET_LIMITS.name}`
        : !ASSET_NAME_REGEX.test(name)
          ? `name 必须匹配 ${ASSET_NAME_REGEX}（首字符 a-z/0-9，后续 a-z/0-9/-）`
          : null
    : null;
  const descError = description.trim().length === 0
    ? 'description 必填'
    : description.length > ASSET_LIMITS.description
      ? `description 长度需 ≤ ${ASSET_LIMITS.description}`
      : /[\r\n]/.test(description)
        ? 'description 必须单行（不能含换行）'
        : description.includes('---')
          ? 'description 不能含 "---"（防 frontmatter 注入）'
          : null;
  const modelError = kind === 'agent'
    ? model.trim().length === 0
      ? 'model 必填'
      : model.length > ASSET_LIMITS.model
        ? `model 长度需 ≤ ${ASSET_LIMITS.model}`
        : /[\r\n]/.test(model)
          ? 'model 必须单行'
          : model.includes('---')
            ? 'model 不能含 "---"'
            : null
    : null;
  const toolsError = kind === 'agent' && tools.length > 0
    ? tools.length > ASSET_LIMITS.tools
      ? `tools 长度需 ≤ ${ASSET_LIMITS.tools}`
      : /[\r\n]/.test(tools)
        ? 'tools 必须单行（逗号分隔）'
        : tools.includes('---')
          ? 'tools 不能含 "---"'
          : null
    : null;
  const bodyError = body.length > ASSET_LIMITS.body
    ? `body 长度需 ≤ ${ASSET_LIMITS.body}（≈ 256KB）`
    : body.split('\n', 1)[0].trim() === '---'
      ? 'body 起首不能是 "---"（防 frontmatter 嵌套）'
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
    const ok = await window.api.confirmDialog({
      title: `删除${kind === 'agent' ? ' Agent' : ' Skill'}`,
      message: `确定要删除「${asset.name}」吗？`,
      detail: kind === 'skill'
        ? `将递归删除目录 ${asset.absPath} 所在的 skill 子目录。`
        : `将删除文件 ${asset.absPath}。`,
      okLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await window.api.deleteUserAsset(asset.kind, asset.name);
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

  const title = isEdit
    ? `编辑${kind === 'agent' ? ' Agent' : ' Skill'}：${asset?.name}`
    : `新建${kind === 'agent' ? ' Agent' : ' Skill'}`;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex h-[80%] w-[400px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-[13px] font-medium">{title}</h3>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
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
          <Field label="name" error={nameError}>
            <input
              type="text"
              value={name}
              onChange={(e) => handleChange(setName)(e.target.value)}
              disabled={isEdit || busy}
              placeholder="my-skill"
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
            />
            {!isEdit && (
              <div className="text-[10px] text-deck-muted/60">
                slug 格式 [a-z0-9-]+；保存后即文件名（agent: ~/.claude/agents/{name || '<name>'}.md；skill: ~/.claude/skills/{name || '<name>'}/SKILL.md）
              </div>
            )}
          </Field>

          <Field label="description" error={descError}>
            <textarea
              value={description}
              onChange={(e) => handleChange(setDescription)(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="这个 skill / agent 是干啥的，何时触发..."
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-50"
            />
          </Field>

          {kind === 'agent' && (
            <>
              <Field label="model" error={modelError}>
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
              <Field label="tools（逗号分隔，可空）" error={toolsError}>
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

          <Field label="body（markdown 正文）" error={bodyError}>
            <textarea
              value={body}
              onChange={(e) => handleChange(setBody)(e.target.value)}
              disabled={busy}
              spellCheck={false}
              className="h-48 w-full resize-y rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-white/20 disabled:opacity-50"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              placeholder="# My Skill\n\n说明触发条件 / 步骤 / 约束..."
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
