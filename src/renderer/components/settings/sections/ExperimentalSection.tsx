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
 * plan prancy-forging-penguin：删 autoSummariseOnFallback toggle（字段曾保留 default:true 当
 * 孤儿不可配）。plan resume-inject-raw-messages-20260601 §不变量 7 **彻底删字段**：fallback 路径
 * (jsonl missing / cwdFellBack=true) 改为**无条件注入历史**（DB 有历史就注「LLM 总结 + 最近原始
 * 对话」），autoSummariseOnFallback 进 settings-store REMOVED_KEYS 清孤儿 —— settings.json 手动
 * set false 也不再生效（字段已不存在）。注入条数由「会话生命周期」section 的 resumeRecentMessagesCount 控制。
 */
export function ExperimentalSection({ settings, update }: Props): JSX.Element {
  const sandboxNativeAvailable = IS_DARWIN || IS_LINUX;

  return (
    <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
      <div className="flex flex-col gap-1 text-[11px]">
        <div>Claude Code 沙盒(系统级隔离)</div>
        <select
          value={settings.claudeCodeSandbox}
          onChange={(e) =>
            void update({
              claudeCodeSandbox: e.target.value as AppSettings['claudeCodeSandbox'],
            })
          }
          className="no-drag w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="off" title="系统不会限制 Claude；仅靠应用内授权弹窗管控">⚠️ 关闭（无系统沙盒）</option>
          <option value="workspace-write" title="工作目录可写；敏感目录禁读；网络默认禁">工作目录可写（默认）</option>
          <option value="strict" title="工作目录也只读，最严格">严格只读</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {sandboxNativeAvailable ? (
          <>
            默认限制 Claude 访问敏感目录、降低误操作风险,并与 Codex 的默认沙盒档位对齐。
            <br />· <strong>关闭</strong>:仅用应用内授权弹窗管控
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
      <div className="mt-3 flex flex-col gap-1 text-[11px]">
        <div>Codex 沙盒(系统级隔离)</div>
        <select
          value={settings.codexSandbox}
          onChange={(e) =>
            void update({
              codexSandbox: e.target.value as AppSettings['codexSandbox'],
            })
          }
          className="no-drag w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="workspace-write" title="工作目录可写；网络默认禁；其他目录只读">工作目录可写（默认）</option>
          <option value="read-only" title="所有文件只读，包括工作目录">完全只读</option>
          <option value="danger-full-access" title="没有任何限制：可以读写任意文件、访问网络、运行任意命令">⚠️ 完全开放（无限制）</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        Codex 的沙盒档位(Codex 原生三档,跨平台一致)。默认<strong>工作目录可写</strong>与 Claude 默认对齐。
        <br />· <strong>工作目录可写</strong>:工作目录可写,网络默认禁,其他目录只读
        <br />· <strong>完全只读</strong>:所有文件只读,包括工作目录
        <br />· <strong>完全开放</strong>:无任何限制(读写任意文件 / 联网 / 运行任意命令)
        <br />
        <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
      </div>
    </Section>
  );
}
