/**
 * Codex MCP Servers 设置面板（CHANGELOG_<X> A4b）。
 *
 * 设计：minimal JSON textarea 编辑（用户粘贴 / 编辑 JSON 数组，点保存写到
 * `~/.codex/config.toml` 的 marker 包裹段）。复杂 form（per-field 编辑 / per-server
 * 行 / 切 stdio vs http transport）留 polish follow-up——本次先 ship 可用通路。
 *
 * 与 PluginAssetsSection 类似：核心是 settings update + JSON 校验 + 错误反馈。
 *
 * 不实现：
 * - server-by-server CRUD UI（用户 JSON 编辑足够）
 * - 实时跟踪 `~/.codex/config.toml` 文件外改（用户 / 别的工具改了 toml 后 settings
 *   不会自动重读；需要重启应用 / 或手工写一次让 marker 段同步）
 * - codex CLI 端的实时验证（保存后看 codex 会话的 mcp_tool_call 验证）
 */
import { useState, type JSX } from 'react';
import type { AppSettings, CodexMcpServerConfigShared } from '@shared/types';
import { Section } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function CodexMcpServersSection({ settings, update }: Props): JSX.Element {
  // 把当前 settings.codexMcpServers 序列化为 JSON 文本（pretty 4 空格缩进，便于阅读）
  const initialJson = formatJson(settings.codexMcpServers);
  const [draft, setDraft] = useState<string>(initialJson);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);

  // dirty 检测：拿当前 settings 序列化结果跟 draft 比，避免 ref 比较失败
  const currentJson = formatJson(settings.codexMcpServers);
  const dirty = draft !== currentJson;

  const reset = (): void => {
    setDraft(currentJson);
    setError(null);
    setSaved(null);
  };

  const save = async (): Promise<void> => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const parsed = parseAndValidate(draft);
      await update({ codexMcpServers: parsed });
      setSaved(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Codex MCP Servers" storageKey="codex-mcp" defaultOpen={false}>
      <div className="text-[10px] text-deck-muted leading-snug">
        配置 Codex CLI 接入的外部 MCP server。Agent Deck 把这段配置写到{' '}
        <code className="rounded bg-white/5 px-1">~/.codex/config.toml</code> 的{' '}
        <code className="rounded bg-white/5 px-1">[mcp_servers.X]</code> 段（用 marker
        包裹，**不破坏**用户手写的其他段）。
        <span className="block mt-1 text-deck-muted/70">
          字段：<code>name</code>（必填）+ stdio (<code>command</code>,{' '}
          <code>args</code>, <code>env</code>) 或 http (<code>url</code>,{' '}
          <code>bearerTokenEnvVar</code>)。改后**下次新建 codex 会话**生效。
        </span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
          setSaved(null);
        }}
        spellCheck={false}
        rows={12}
        className="mt-2 w-full rounded border border-deck-border bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text outline-none focus:border-white/20"
        placeholder='[{"name": "my-server", "command": "node", "args": ["server.js"], "env": {"KEY": "value"}}]'
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="rounded bg-white/10 px-2 py-1 text-[10px] hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="rounded bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10 disabled:opacity-40"
          >
            撤销
          </button>
        )}
        {saved && !dirty && (
          <span className="text-[9px] text-status-ok/80">
            ✓ 已写入 ~/.codex/config.toml（marker 段）
          </span>
        )}
      </div>
      {error && (
        <div className="mt-1.5 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          ⚠ {error}
        </div>
      )}
    </Section>
  );
}

function formatJson(servers: CodexMcpServerConfigShared[]): string {
  if (!servers || servers.length === 0) return '[]';
  return JSON.stringify(servers, null, 2);
}

/**
 * 解析 + 基本校验。错误抛出（save 端 catch）。
 *
 * 校验项：
 * - JSON parse 必须成功
 * - 顶层必须是数组
 * - 每条 server 必须有 name（string + 非空 + 合法字符）
 * - 必须有 command 或 url（二选一，stdio vs http transport）
 *
 * 不严格校验：args/env 字段类型（toml-writer 会兜底跳过非法字段）。
 */
function parseAndValidate(text: string): CodexMcpServerConfigShared[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('顶层必须是数组（即便只有一条 server，也要 [{...}] 包起来）');
  }
  const out: CodexMcpServerConfigShared[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as unknown;
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${i + 1} 条不是对象`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) {
      throw new Error(`第 ${i + 1} 条缺 name`);
    }
    if (!/^[\w\-/]+$/.test(o.name)) {
      throw new Error(`第 ${i + 1} 条 name "${o.name}" 含非法字符（仅允许 [\\w-/]）`);
    }
    const hasStdio = typeof o.command === 'string';
    const hasHttp = typeof o.url === 'string';
    if (!hasStdio && !hasHttp) {
      throw new Error(`第 ${i + 1} 条 (${o.name}) 必须提供 command (stdio) 或 url (http)`);
    }
    out.push({
      name: o.name,
      ...(typeof o.command === 'string' ? { command: o.command } : {}),
      ...(Array.isArray(o.args) ? { args: o.args.map(String) } : {}),
      ...(o.env && typeof o.env === 'object' && !Array.isArray(o.env)
        ? { env: Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, String(v)])) }
        : {}),
      ...(typeof o.url === 'string' ? { url: o.url } : {}),
      ...(typeof o.bearerTokenEnvVar === 'string' ? { bearerTokenEnvVar: o.bearerTokenEnvVar } : {}),
    });
  }
  return out;
}
