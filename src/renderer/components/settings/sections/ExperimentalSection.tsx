import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { Section } from '../controls';
import { IS_DARWIN, IS_LINUX } from '@renderer/lib/platform';
import {
  CLAUDE_SANDBOX_MODE_OPTIONS,
  CODEX_SANDBOX_MODE_OPTIONS,
  GROK_SETTINGS_SANDBOX_MODE_OPTIONS,
} from '@renderer/lib/sandbox-options';
import { GrokSandboxPicker } from '@renderer/components/GrokSandboxPicker';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * Keeps global sandbox defaults together. These values apply to new sessions;
 * Grok Build sessions may also request an idle-time override in SessionDetail.
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
          options={CLAUDE_SANDBOX_MODE_OPTIONS}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {sandboxNativeAvailable ? (
          <>
            默认档位为<strong>工作目录可写</strong>。
            <br />· <strong>完全只读：</strong>工作目录只读，且禁止绕过系统沙盒
            <br />· <strong>工作目录可写：</strong>可写工作目录，默认禁用网络；
            <code className="rounded bg-white/5 px-1">~/.ssh</code> /
            <code className="rounded bg-white/5 px-1">~/.aws</code> /
            <code className="rounded bg-white/5 px-1">~/.config</code> /
            <code className="rounded bg-white/5 px-1">~/.kube</code> /
            <code className="rounded bg-white/5 px-1">~/.gnupg</code> 等敏感目录禁读
            <br />· <strong>完全开放：</strong>关闭系统沙盒，仍受 Claude Code 权限设置约束
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
        <div>Codex CLI 沙盒（系统隔离）</div>
        <DeckSelect
          value={settings.codexSandbox}
          onChange={(next) =>
            void update({
              codexSandbox: next,
            })
          }
          options={CODEX_SANDBOX_MODE_OPTIONS}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        默认档位为<strong>工作目录可写</strong>。
        <br />· <strong>完全只读：</strong>包括工作目录在内的所有文件都只读
        <br />· <strong>工作目录可写：</strong>可写工作目录，默认禁用网络，其他目录只读
        <br />· <strong>完全开放：</strong>可读写任意文件、联网并运行任意命令
        <br />
        <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
      </div>
      <div className="mt-3 flex flex-col gap-1 text-[11px]">
        <div>Grok Build 沙盒（请求档位）</div>
        <GrokSandboxPicker
          value={settings.grokSandbox}
          onChange={(profile) =>
            void update({ grokSandbox: profile.trim() })
          }
          allowUnset={false}
          profileOptions={GROK_SETTINGS_SANDBOX_MODE_OPTIONS}
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        默认档位为<strong>工作目录可写</strong>。
        <br />可选广泛只读、工作目录可写、完全开放，或输入{' '}
        <code className="rounded bg-white/5 px-1">sandbox.toml</code>{' '}
        中定义的配置名称；企业托管要求仍可能覆盖这里的请求。
        <br />权限弹窗决定工具是否执行，沙盒限制获准工具能够访问的系统资源。
        {IS_DARWIN && (
          <>
            <br />macOS 上 Grok Build 的 strict / read-only 子进程网络限制当前不生效。
          </>
        )}
        <br />
        <strong className="text-amber-300/90">⚠️ 全局值仅用于新建会话；已有会话可在详情中空闲切换</strong>。
      </div>
    </Section>
  );
}
