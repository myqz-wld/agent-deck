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
        <span>Claude Code 沙盒(系统级隔离)</span>
        <select
          value={settings.claudeCodeSandbox}
          onChange={(e) =>
            void update({
              claudeCodeSandbox: e.target.value as AppSettings['claudeCodeSandbox'],
            })
          }
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="off" title="系统不会限制 Claude；仅靠应用内授权弹窗管控">⚠️ 关闭（无系统沙盒）</option>
          <option value="workspace-write" title="工作目录可写；敏感目录禁读；网络默认禁">工作目录可写</option>
          <option value="strict" title="工作目录也只读，最严格">严格只读</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {sandboxNativeAvailable ? (
          <>
            开启后会限制 Claude 访问敏感目录、降低误操作风险。
            Codex 默认已启用<strong>工作目录可写</strong>,本设置补齐 Claude 这一侧。
            <br />· <strong>关闭</strong>:仅用应用内授权弹窗管控(默认行为)
            <br />· <strong>工作目录可写</strong>:工作目录可写,网络默认禁止;
            <code className="rounded bg-white/5 px-1">~/.ssh</code> /
            <code className="rounded bg-white/5 px-1">~/.aws</code> /
            <code className="rounded bg-white/5 px-1">~/.config</code> /
            <code className="rounded bg-white/5 px-1">~/.kube</code> /
            <code className="rounded bg-white/5 px-1">~/.gnupg</code> 等敏感目录禁读
            <br />· <strong>严格只读</strong>:工作目录也只读,彻底防越权
            <br />
            <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
          </>
        ) : (
          <>
            Windows 当前不支持系统级沙盒,本设置仅在 macOS / Linux 生效。
          </>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px]">
        <span>Codex 沙盒(系统级隔离)</span>
        <select
          value={settings.codexSandbox}
          onChange={(e) =>
            void update({
              codexSandbox: e.target.value as AppSettings['codexSandbox'],
            })
          }
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="workspace-write" title="工作目录可写；网络默认禁；其他目录只读">工作目录可写（默认）</option>
          <option value="read-only" title="所有文件只读，包括工作目录">完全只读</option>
          <option value="danger-full-access" title="没有任何限制：可以读写任意文件、访问网络、运行任意命令">⚠️ 完全开放（可改任意文件 / 联网 / 运行任意命令）</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        Codex 的沙盒档位(Codex 原生三档,跨平台一致)。
        默认<strong>工作目录可写</strong>与 Claude 默认对齐;
        <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
      </div>
    </Section>
  );
}
