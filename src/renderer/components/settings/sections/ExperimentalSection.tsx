import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section } from '../controls';
import { IS_DARWIN, IS_LINUX } from '@renderer/lib/platform';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「实验功能」section。包含：
 * - Claude Code 沙盒档位
 * - Codex 沙盒档位
 *
 * R3.E7：删 Agent Teams toggle + Teammate 权限自动放行档位（老 inbox 协议下线）。
 * 新 universal team backend 不需要这两个开关 —— 默认开启，跨 adapter team UI 直接进入。
 *
 * plan task-mcp-merge-into-agent-deck-mcp-20260521：删 enableTaskManager toggle —
 * 5 个 task tool 合并入 agent-deck-mcp namespace 后跟随 enableAgentDeckMcp 开关（详
 * AgentDeckMcpSection），settings-store smart migration 自动 carry 老用户 ON 值。
 *
 * plan prancy-forging-penguin：删 autoSummariseOnFallback toggle — 字段保留默认 true
 * 不可配，让 fallback 路径(jsonl missing / cwdFellBack=true)永远自动 LLM 摘要(成本
 * 敏感时改 settings.json 手动 set false 仍生效;UI 不再暴露避免新用户误关错过续聊体感)。
 */
export function ExperimentalSection({ settings, update }: Props): JSX.Element {
  const sandboxNativeAvailable = IS_DARWIN || IS_LINUX;

  return (
    <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
      <div className="flex items-center justify-between text-[11px]">
        <span>Claude Code 沙盒（OS 级隔离）</span>
        <select
          value={settings.claudeCodeSandbox}
          onChange={(e) =>
            void update({
              claudeCodeSandbox: e.target.value as AppSettings['claudeCodeSandbox'],
            })
          }
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="off">关闭（默认）</option>
          <option value="workspace-write">Workspace Write</option>
          <option value="strict">Strict</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {sandboxNativeAvailable ? (
          <>
            开启后 Claude SDK 子进程走 OS 级沙盒（{IS_DARWIN ? 'macOS Seatbelt' : 'Linux bubblewrap'}）。
            Codex 子进程已默认 <code className="rounded bg-white/5 px-1">workspace-write</code>，本设置补齐 Claude
            这一侧。
            <br />· <strong>关闭</strong>：仅应用层 canUseTool 弹框决策（与现状一致）
            <br />· <strong>Workspace Write</strong>：cwd 可写；
            <code className="rounded bg-white/5 px-1">~/.ssh</code> /
            <code className="rounded bg-white/5 px-1">~/.aws</code> /
            <code className="rounded bg-white/5 px-1">~/.config</code> /
            <code className="rounded bg-white/5 px-1">~/.kube</code> /
            <code className="rounded bg-white/5 px-1">~/.gnupg</code> 等敏感目录禁读；
            网络默认禁
            <br />· <strong>Strict</strong>：cwd 也只读 + 完全封死逃逸路径
            <br />
            <strong className="text-amber-300/90">⚠ 切档仅下次新建会话生效</strong>。
          </>
        ) : (
          <>
            Windows 当前不支持 OS 级沙盒。本档位仅在 macOS / Linux 生效。
          </>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px]">
        <span>Codex 沙盒（OS 级隔离）</span>
        <select
          value={settings.codexSandbox}
          onChange={(e) =>
            void update({
              codexSandbox: e.target.value as AppSettings['codexSandbox'],
            })
          }
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="workspace-write">Workspace Write（默认）</option>
          <option value="read-only">Read Only</option>
          <option value="danger-full-access">⚠ Danger Full Access</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        Codex CLI 子进程的沙盒档位（codex SDK 原生三档，由 codex 自身 OS 隔离实现，跨平台一致）。
        默认 <code className="rounded bg-white/5 px-1">workspace-write</code> 与 Claude 默认对齐；
        切档仅下次新建会话生效。
      </div>
    </Section>
  );
}
