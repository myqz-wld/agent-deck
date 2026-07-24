import { useState, type JSX } from 'react';
import type { GrokAuthProbeResult } from '@shared/types';
import { PlayIcon } from '../../icons';
import { Section } from '../controls';

export function GrokAuthenticationSection(): JSX.Element {
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
    <Section title="ACP 认证" storageKey="grok-auth" defaultOpen>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        新建或恢复会话前，Agent Deck 会读取 ACP <code>authMethods</code>，优先使用
        <code> xai.api_key</code>，其次使用 <code>cached_token</code>，并调用
        <code> authenticate</code>。不会保存或显示 API Key。
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px]">认证检测</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void probe()}
          className="no-drag rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20 disabled:opacity-50"
        >
          <PlayIcon className="mr-1 inline h-3 w-3" />
          {busy ? '检测中…' : '检测'}
        </button>
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        检测只执行 initialize / authenticate，不创建会话，也不发送模型 prompt。
      </div>
      {result?.ok && (
        <div className="rounded border border-status-working/30 bg-status-working/10 p-2 text-[10px] leading-snug text-status-working">
          <div>
            认证可用：<code>{result.methodId ?? '无需显式认证'}</code>
            {result.usedLoginShell ? '；已通过用户登录 shell 继承环境。' : '。'}
          </div>
          {result.methods.length > 0 && (
            <div className="mt-1 text-deck-muted/80">
              ACP 提供：{result.methods.map((method) => method.id).join('、')}
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
