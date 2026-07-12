import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { Section } from '../controls';
import { IS_DARWIN, IS_LINUX } from '@renderer/lib/platform';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

const CLAUDE_SANDBOX_OPTIONS: {
  value: AppSettings['claudeCodeSandbox'];
  label: string;
  title: string;
}[] = [
  { value: 'off', label: '⚠️ 关闭（无系统沙盒）', title: '系统不会限制 Claude；仅靠应用内授权弹窗管控' },
  { value: 'workspace-write', label: '工作目录可写（默认）', title: '工作目录可写；敏感目录禁读；网络默认禁' },
  { value: 'strict', label: '严格只读', title: '工作目录也只读，最严格' },
];

const CODEX_SANDBOX_OPTIONS: {
  value: AppSettings['codexSandbox'];
  label: string;
  title: string;
}[] = [
  { value: 'workspace-write', label: '工作目录可写（默认）', title: '工作目录可写；网络默认禁；其他目录只读' },
  { value: 'read-only', label: '完全只读', title: '所有文件只读，包括工作目录' },
  { value: 'danger-full-access', label: '⚠️ 完全开放（无限制）', title: '没有任何限制：可以读写任意文件、访问网络、运行任意命令' },
];

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
 * plan prancy-forging-penguin：删 autoSummariseOnFallback toggle（字段曾保留 default:true 当
 * 孤儿不可配）。plan resume-inject-raw-messages-20260601 §不变量 7 **彻底删字段**：fallback 路径
 * (jsonl missing / cwdFellBack=true) 改为**无条件注入历史**（DB 有历史就注「LLM 总结 + 最近原始
 * 对话」），autoSummariseOnFallback 进 settings-store REMOVED_KEYS 清孤儿 —— settings.json 手动
 * set false 也不再生效（字段已不存在）。原始历史容量由「会话续接上下文」section 的 token 预算控制。
 */
export function ExperimentalSection({ settings, update }: Props): JSX.Element {
  const sandboxNativeAvailable = IS_DARWIN || IS_LINUX;

  return (
    <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
      <div className="flex flex-col gap-1 text-[11px]">
        <div>Claude Code 沙盒（系统隔离）</div>
        <DeckSelect
          value={settings.claudeCodeSandbox}
          onChange={(next) =>
            void update({
              claudeCodeSandbox: next,
            })
          }
          options={CLAUDE_SANDBOX_OPTIONS}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {sandboxNativeAvailable ? (
          <>
            默认保护敏感目录并减少误操作，与 Codex 的默认档位一致。
            <br />· <strong>关闭：</strong>仅由应用内授权弹窗管控
            <br />· <strong>工作目录可写：</strong>可写工作目录，默认禁用网络；
            <code className="rounded bg-white/5 px-1">~/.ssh</code> /
            <code className="rounded bg-white/5 px-1">~/.aws</code> /
            <code className="rounded bg-white/5 px-1">~/.config</code> /
            <code className="rounded bg-white/5 px-1">~/.kube</code> /
            <code className="rounded bg-white/5 px-1">~/.gnupg</code> 等敏感目录禁读
            <br />· <strong>严格只读：</strong>工作目录也只读
            <br />
            <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
          </>
        ) : (
          <>
            Windows 暂不支持系统沙盒，此设置仅在 macOS 和 Linux 生效。
          </>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-1 text-[11px]">
        <div>Codex 沙盒（系统隔离）</div>
        <DeckSelect
          value={settings.codexSandbox}
          onChange={(next) =>
            void update({
              codexSandbox: next,
            })
          }
          options={CODEX_SANDBOX_OPTIONS}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        Codex 原生提供三档沙盒，默认选择<strong>工作目录可写</strong>。
        <br />· <strong>工作目录可写：</strong>可写工作目录，默认禁用网络，其他目录只读
        <br />· <strong>完全只读：</strong>包括工作目录在内的所有文件都只读
        <br />· <strong>完全开放：</strong>可读写任意文件、联网并运行任意命令
        <br />
        <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
      </div>
    </Section>
  );
}
