import { useState, type JSX } from 'react';
import type { GrokAuthProbeResult } from '@shared/types';
import { PlayIcon } from '../../icons';
import { Section } from '../controls';

export function GrokAuthenticationSection({ readOnly = false }: { readOnly?: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GrokAuthProbeResult | null>(null);

  const probe = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await window.api.probeGrokAuth());
    } catch (reason) {
      setResult({
        ok: false,
        methodId: null,
        methods: [],
        usedLoginShell: false,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Grok Build 认证" storageKey="grok-auth" defaultOpen>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        新建或恢复会话前，Agent Deck 会检查 Grok Build 是否已登录。不会保存或显示访问凭据。
      </div>
      <div
        data-settings-field="认证检测"
        className="mt-1 flex items-center justify-between gap-2"
      >
        <span className="text-[11px]">认证检测</span>
        <button
          type="button"
          disabled={readOnly || busy}
          onClick={() => void probe()}
          className="no-drag rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20 disabled:opacity-50"
        >
          <PlayIcon className="mr-1 inline h-3 w-3" />
          {busy ? '检测中…' : readOnly ? '仅可在远端检查' : '检测'}
        </button>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {readOnly
          ? '认证状态由远端环境管理，不会把凭据传到这台电脑。'
          : '检测只验证登录状态，不会创建会话或发送消息。'}
      </div>
      {result?.ok && (
        <div className="rounded border border-status-working/30 bg-status-working/10 p-2 text-[10px] leading-snug text-status-working">
          <div>
            认证可用：<code>{result.methodId ?? '无需显式认证'}</code>
            {result.usedLoginShell ? '；已通过用户登录 shell 继承环境。' : '。'}
          </div>
          {result.methods.length > 0 && (
            <div className="mt-1 text-deck-muted/80">
              可用的登录方式：{result.methods.map((method) => method.id).join('、')}
            </div>
          )}
        </div>
      )}
      {result && !result.ok && (
        <div className="whitespace-pre-wrap rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[10px] leading-snug text-status-waiting">
          {result.reason ?? '认证检测失败'}
        </div>
      )}
    </Section>
  );
}
