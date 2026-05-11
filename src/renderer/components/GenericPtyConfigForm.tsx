/**
 * GenericPtyConfigForm —— NewSessionDialog 内嵌的子组件，让用户配 GenericPtyConfig
 * （command / args / env / cwd / idleQuietMs / promptSuffixRegex），用 preset 下拉
 * 提供「Aider preset / Continue preset / 自定义」三档默认值起点（R4·F5）。
 *
 * 提交前 zod parse 防脏：invalid → onChange(null) + inline error 提示；valid → onChange(config)。
 *
 * 与 generic-pty / aider adapter 的关系：
 * - aider adapter（NewSessionDialog 选 'aider'）：默认 preset='aider'，但用户可改任何字段
 *   （含 command — 让用户填自己的 aider wrapper 路径）
 * - generic-pty adapter（NewSessionDialog 选 'generic-pty'）：默认 preset='custom'，
 *   用户必填 command（schema min(1) 强制）
 */

import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  GENERIC_PTY_PRESETS,
  parseGenericPtyConfig,
  type GenericPtyConfig,
} from '@shared/types';

interface Props {
  /** 适配器 id，用于决定默认 preset：'aider' → 自动选 'aider' preset；其它 → 'custom'（空白） */
  adapterId: 'aider' | 'generic-pty';
  /** valid 时返回 config，invalid 时返回 null（让父级 dialog 灰掉「创建」按钮） */
  onChange: (config: GenericPtyConfig | null) => void;
}

type PresetSlug = 'aider' | 'continue' | 'custom';

const CUSTOM_BLANK: GenericPtyConfig = {
  command: '',
  args: [],
  env: {},
  cwd: '',
  idleQuietMs: 3000,
  promptSuffixRegex: '',
};

/** key=value 多行 → Record；空行跳过；line 不含 '=' 跳过（容错） */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1);
    if (key) out[key] = val;
  }
  return out;
}

function stringifyEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** "--no-stream --no-pretty" → ['--no-stream', '--no-pretty']。
 *
 * REVIEW_24 codex LOW 9：仅按空白拆，**不支持引号包裹**（`--msg "hello world"` 会被
 * 拆成 `["--msg","\"hello","world\""]`）。如未来用户需要复杂 args（含空格 / 转义），
 * 改用 sh-like quote-aware parser；当下 90% PTY case 简单 args 已足够（aider /
 * continue 等都没有引号需求）。UI placeholder 已注明此限制让用户预期对齐。
 */
function parseArgsText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function stringifyArgs(args: string[]): string {
  return args.join(' ');
}

export function GenericPtyConfigForm({ adapterId, onChange }: Props): JSX.Element {
  // adapter='aider' → 默认选 'aider' preset；'generic-pty' → 'custom'（用户必填）
  const initialPreset: PresetSlug = adapterId === 'aider' ? 'aider' : 'custom';
  const [presetId, setPresetId] = useState<PresetSlug>(initialPreset);
  const initialConfig =
    initialPreset === 'aider'
      ? GENERIC_PTY_PRESETS.find((p) => p.id === 'aider')!.config
      : CUSTOM_BLANK;

  const [command, setCommand] = useState(initialConfig.command);
  const [argsText, setArgsText] = useState(stringifyArgs(initialConfig.args));
  const [envText, setEnvText] = useState(stringifyEnv(initialConfig.env));
  const [cwd, setCwd] = useState(initialConfig.cwd);
  const [idleQuietMs, setIdleQuietMs] = useState(String(initialConfig.idleQuietMs));
  const [promptSuffixRegex, setPromptSuffixRegex] = useState(initialConfig.promptSuffixRegex);
  const [error, setError] = useState<string | null>(null);

  // 选 preset → 重新填字段
  const selectPreset = (id: PresetSlug): void => {
    setPresetId(id);
    if (id === 'custom') {
      // 留当前字段不动，让用户在已有基础上调整
      return;
    }
    const preset = GENERIC_PTY_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setCommand(preset.config.command);
    setArgsText(stringifyArgs(preset.config.args));
    setEnvText(stringifyEnv(preset.config.env));
    setCwd(preset.config.cwd);
    setIdleQuietMs(String(preset.config.idleQuietMs));
    setPromptSuffixRegex(preset.config.promptSuffixRegex);
  };

  // 任一字段变 → 重新拼 config + zod parse + onChange + 更新 error
  const config = useMemo<GenericPtyConfig | null>(() => {
    const idleNum = Number(idleQuietMs);
    if (!Number.isFinite(idleNum)) {
      setError('idleQuietMs 必须是非负整数');
      return null;
    }
    try {
      return parseGenericPtyConfig({
        command: command.trim(),
        args: parseArgsText(argsText),
        env: parseEnvText(envText),
        cwd: cwd.trim(),
        idleQuietMs: Math.floor(idleNum),
        promptSuffixRegex,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [command, argsText, envText, cwd, idleQuietMs, promptSuffixRegex]);

  useEffect(() => {
    if (config) setError(null);
    onChange(config);
  }, [config, onChange]);

  return (
    <div className="flex flex-col gap-2 rounded border border-deck-border bg-white/[0.02] p-2">
      <Field label="Preset">
        <select
          value={presetId}
          onChange={(e) => selectPreset(e.target.value as PresetSlug)}
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        >
          {GENERIC_PTY_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName} — {p.description}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
      </Field>

      <Field label="命令 *">
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={adapterId === 'aider' ? 'aider' : '/usr/local/bin/foo 或 PATH 内可执行名'}
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
      </Field>

      <Field label="命令参数（空格分隔，不支持引号）">
        <input
          type="text"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder="--no-stream --no-pretty"
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
      </Field>

      <Field label="环境变量（KEY=VALUE 每行一条）">
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          rows={2}
          placeholder="OPENAI_API_KEY=sk-xxx&#10;NODE_ENV=production"
          className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 font-mono text-[11px] outline-none focus:border-white/20"
        />
      </Field>

      <Field label="工作目录（留空跟随 session 主 cwd）">
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="留空 = 使用上方「工作目录 cwd」字段"
          className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
      </Field>

      <div className="flex gap-2">
        <Field label="idle 阈值 (ms)">
          <input
            type="number"
            min={0}
            step={500}
            value={idleQuietMs}
            onChange={(e) => setIdleQuietMs(e.target.value)}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
          />
        </Field>
        <Field label="prompt 末尾 regex（可空）">
          <input
            type="text"
            value={promptSuffixRegex}
            onChange={(e) => setPromptSuffixRegex(e.target.value)}
            placeholder={'\\>\\s*$'}
            className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 font-mono text-[11px] outline-none focus:border-white/20"
          />
        </Field>
      </div>

      <div className="text-[10px] text-deck-muted/70">
        最终命令预览：<span className="font-mono">{command || '(empty)'} {argsText}</span>
      </div>

      {error && (
        <div className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          ⚠ 配置无效：{error}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
    </label>
  );
}
