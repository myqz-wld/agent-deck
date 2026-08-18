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
  readOnly?: boolean;
}

interface SandboxDescriptionOption {
  value: string;
  label: string;
  title?: string;
}

function SandboxModeDescriptions({
  options,
}: {
  options: readonly SandboxDescriptionOption[];
}): JSX.Element {
  return (
    <>
      <div>默认档位：<strong>工作目录可写</strong>。</div>
      {options.map((option) => (
        <div key={option.value}>
          · <strong>{option.label.replace(/^⚠️\s*/, '')}：</strong>{option.title}
        </div>
      ))}
    </>
  );
}

/**
 * Keeps global sandbox defaults together. These values apply to new sessions;
 * Grok Build sessions may also request an idle-time override in SessionDetail.
 */
export function ExperimentalSection({ settings, update, readOnly = false }: Props): JSX.Element {
  const sandboxNativeAvailable = IS_DARWIN || IS_LINUX;

  return (
    <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
      <div data-settings-field="Claude Code 沙盒（系统隔离）" className="flex flex-col gap-1 text-[11px]">
        <div>Claude Code 沙盒（系统隔离）</div>
        <DeckSelect
          value={settings.claudeCodeSandbox}
          onChange={(next) =>
            void update({
              claudeCodeSandbox: next,
            })
          }
          options={CLAUDE_SANDBOX_MODE_OPTIONS}
          disabled={readOnly}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {sandboxNativeAvailable ? (
          <>
            <SandboxModeDescriptions options={CLAUDE_SANDBOX_MODE_OPTIONS} />
            <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
          </>
        ) : (
          <>
            Windows 暂不支持系统沙盒，此设置仅在 macOS 和 Linux 生效。
          </>
        )}
      </div>
      <div data-settings-field="Codex CLI 沙盒（系统隔离）" className="mt-3 flex flex-col gap-1 text-[11px]">
        <div>Codex CLI 沙盒（系统隔离）</div>
        <DeckSelect
          value={settings.codexSandbox}
          onChange={(next) =>
            void update({
              codexSandbox: next,
            })
          }
          options={CODEX_SANDBOX_MODE_OPTIONS}
          disabled={readOnly}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        <SandboxModeDescriptions options={CODEX_SANDBOX_MODE_OPTIONS} />
        <strong className="text-amber-300/90">⚠️ 仅对新建会话生效</strong>。
      </div>
      <div data-settings-field="Grok Build 沙盒（请求档位）" className="mt-3 flex flex-col gap-1 text-[11px]">
        <div>Grok Build 沙盒（请求档位）</div>
        <GrokSandboxPicker
          value={settings.grokSandbox}
          onChange={(profile) =>
            void update({ grokSandbox: profile.trim() })
          }
          allowUnset={false}
          disabled={readOnly}
          profileOptions={GROK_SETTINGS_SANDBOX_MODE_OPTIONS}
        />
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        <SandboxModeDescriptions options={GROK_SETTINGS_SANDBOX_MODE_OPTIONS} />
        <div>
          · <strong>自定义配置：</strong>使用{' '}
          <code className="rounded bg-white/5 px-1">sandbox.toml</code>{' '}
          中定义的配置名称；企业托管要求仍可能覆盖这里的请求
        </div>
        <div>权限弹窗决定工具是否执行；沙盒限制获准工具能够访问的系统资源。</div>
        <strong className="text-amber-300/90">⚠️ 全局设置仅用于新建会话；已有会话可在详情中空闲切换</strong>。
      </div>
    </Section>
  );
}
