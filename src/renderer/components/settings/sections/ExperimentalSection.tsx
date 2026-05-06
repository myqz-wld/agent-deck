import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';
import { IS_DARWIN, IS_LINUX } from '@renderer/lib/platform';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「实验功能」section。包含：
 * - Agent Teams toggle + Teammate 权限自动放行档位
 * - SDK Task Manager toggle（in-process MCP）
 * - Claude Code 沙盒档位（B3 #2 平台分流：mac/linux 显示 Seatbelt/bubblewrap 详情，
 *   win 显示「不支持」短句）
 * - Codex 沙盒档位（跨平台一致，由 codex CLI 自身 OS 隔离实现，不分流）
 *
 * 描述区瘦身（CHANGELOG_57 B5）：
 * - Teammate 权限说明：白名单工具列表浓缩为「所有内置只读工具 + mcp__tasks__*」
 * - Task Manager 说明：删 5 个 mcp__tasks__* 工具罗列，留下 Agent Teams 联动 +
 *   ~/.claude/tasks/ 自然语言任务并行两段；末尾补「完整工具清单见 header 资产库」
 *
 * 全局术语收口（CHANGELOG_57 B4）：「Teammate / teammate」改为标题大写 Teammate，
 * 描述里的 teammate 用 <strong> 加粗表示是术语。
 */
export function ExperimentalSection({ settings, update }: Props): JSX.Element {
  // mac/linux 走「OS 沙盒可用」分支；win 走「不支持」短句分支
  const sandboxNativeAvailable = IS_DARWIN || IS_LINUX;

  return (
    <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
      <Toggle
        label="启用 Agent Teams（实验特性）"
        value={settings.agentTeamsEnabled}
        onChange={(v) => void update({ agentTeamsEnabled: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        开启后新建会话对话框会出现 Team 名输入框；填了 team 名的 SDK 会话在 spawn 时
        注入 <code className="rounded bg-white/5 px-1">CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1</code>。
        需 Claude Code CLI ≥ v2.1.32 / 推荐 Opus 4.6+。
        <br />
        <strong className="text-deck-text/85">已知限制</strong>：不支持 /resume 与 /rewind；
        一个会话只能管一个 team；lead 终身固定。
        <br />
        <strong className="text-amber-300/90">⚠ 仅下次新建会话生效</strong>——已在跑的 team
        会话不受影响（env 是 spawn 时一次性传入）。
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span>Teammate 权限自动放行</span>
        <select
          value={settings.autoApproveTeammateMode}
          onChange={(e) =>
            void update({
              autoApproveTeammateMode: e.target
                .value as AppSettings['autoApproveTeammateMode'],
            })
          }
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          <option value="off">关闭（每次都弹）</option>
          <option value="read-only">只读工具自动允许（默认）</option>
          <option value="follow-lead">跟随 lead 权限模式</option>
        </select>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        <strong>Teammate</strong> 调工具时，按此规则在弹给你审批前先尝试自动允许。
        <strong>teammate</strong> 走 inbox 协议而非 SDK canUseTool，所以 lead 的
        permissionMode / settings.json 白名单对 <strong>teammate</strong> 失效——本档位补这道口子。
        <br />· <strong>read-only</strong>（默认）：与 lead 自身白名单一致——所有内置只读工具 +
        <code className="rounded bg-white/5 px-1">mcp__tasks__*</code> 自动允许；其他（Bash / Edit / Write…）仍弹给你
        <br />· <strong>follow-lead</strong>：以上 + 跟随 lead 当前 permissionMode（acceptEdits → 加放行
        <code className="rounded bg-white/5 px-1">Edit / Write / MultiEdit / NotebookEdit</code>；
        bypassPermissions → 全放行；default / plan → 降回 read-only）
        <br />· <strong>关闭</strong>：<strong>teammate</strong> 每次工具调用都弹给你（旧行为）
        <br />
        <strong className="text-deck-text/85">运行时即时生效</strong>——切档位下条 <strong>teammate</strong>
        请求就走新规则，不像 sandbox 那样要等下次新建会话。完整白名单见
        <code className="rounded bg-white/5 px-1">src/shared/constants/read-only-tools.ts</code>。
      </div>
      <div className="mt-3 border-t border-deck-border/50 pt-3">
        <Toggle
          label="启用 SDK Task Manager（in-process MCP）"
          value={settings.enableTaskManager}
          onChange={(v) => void update({ enableTaskManager: v })}
        />
        <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
          开启后 SDK 会话注入 <code className="rounded bg-white/5 px-1">mcp__tasks__*</code> 系列结构化任务工具，让多个 SDK Agent 跨会话协作管理结构化任务。
          <br />
          <strong className="text-deck-text/85">与 Agent Teams 联动</strong>：会话所属 team 会自动闭包注入到任务工具，写操作（create/update/delete）锁在自己 team；只读（list/get）允许跨 team 协调。无 team 的会话只能操作全局任务。
          <br />
          与 <code className="rounded bg-white/5 px-1">~/.claude/tasks/&lt;team&gt;/&lt;list&gt;.md</code> 自然语言任务并行存在、互不覆盖（前者 Claude 内部协作用、后者结构化可被工具调用）。完整工具清单见 header「📚 资产库」。
          <br />
          <strong className="text-amber-300/90">⚠ 仅下次新建会话生效</strong>——已在跑的会话已固化 mcpServers 列表。
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]">
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
            网络默认禁，model 可用 <code className="rounded bg-white/5 px-1">dangerouslyDisableSandbox</code>
            重试（会弹框给你审批）
            <br />· <strong>Strict</strong>：cwd 也只读 + 完全封死逃逸路径；
            沙盒不可用（旧 {IS_DARWIN ? 'macOS' : 'Linux 无 bubblewrap'}）直接报错退出
            <br />
            常用工具（<code className="rounded bg-white/5 px-1">git / pnpm / npm / yarn / bun / pip / cargo / go</code>）
            默认豁免不进沙盒。需 Claude Code SDK ≥ v0.2.118。
            <br />
            <strong className="text-amber-300/90">⚠ 切档仅下次新建会话生效</strong>——已在跑的会话已按当前档位 spawn，不会被撤销。
          </>
        ) : (
          <>
            Windows 当前不支持 OS 级沙盒（Claude SDK 在 Windows 走应用层 canUseTool 兜底）。
            本档位仅在 macOS / Linux 生效；Windows 下保持「关闭」即可，切其他档位等同 off。
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
