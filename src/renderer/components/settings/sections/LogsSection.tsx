import { type JSX, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { Section } from '../controls';
import { LogViewerModal } from './LogViewerModal';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

type LogLevel = AppSettings['logLevel'];

const LEVEL_OPTIONS: { value: LogLevel; label: string; description: string }[] = [
  { value: 'error', label: 'ERROR', description: '只记录错误' },
  { value: 'warn', label: 'WARN', description: '错误和警告' },
  { value: 'info', label: 'INFO（默认）', description: '推荐设置' },
  { value: 'verbose', label: 'VERBOSE', description: '排查问题时使用' },
  { value: 'debug', label: 'DEBUG', description: '需要更多细节时使用' },
  { value: 'silly', label: 'SILLY', description: '最详细，通常只在排查复杂问题时使用' },
];

/**
 * 「日志」section — Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2.1.
 *
 * 包含 4 个交互元素:
 * - 日志级别下拉 (logLevel: error / warn / info / verbose / debug / silly, 默认 info; 只控
 *   file transport, console 永远 silly 保 dev terminal 全输出 — D4 修订; IPC SettingsSet
 *   handler 调 applyLogLevel(next.logLevel) 即改即生效 — Step 3.1.3)
 * - 打开日志目录按钮 — main 端 shell.openPath(app.getPath('logs'))
 * - 查看日志按钮 — 打开应用内 Monaco 只读 modal 展示当天 main-YYYY-MM-DD.log
 *   (window.api.logsReadToday(); 文件不存在 → 空态; > 2MB → 尾部 2MB + truncated banner)
 * - 清空今天日志按钮 — main 端 fs.truncateSync 当天 log 文件; 文件不存在时弹 toast「今天还
 *   没有日志可清空」
 */
export function LogsSection({ settings, update }: Props): JSX.Element {
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error' } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  function flashToast(msg: string, kind: 'info' | 'error' = 'info'): void {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleOpenDirectory(): Promise<void> {
    const res = await window.api.logsOpenDirectory();
    if (!res.ok) {
      flashToast(`打开失败: ${res.error ?? 'unknown'}`, 'error');
    }
  }

  async function handleTruncateToday(): Promise<void> {
    const res = await window.api.logsTruncateToday();
    if (!res.ok) {
      flashToast(`清空失败: ${res.error ?? 'unknown'}`, 'error');
      return;
    }
    flashToast(res.existed ? '已清空今天日志' : '今天还没有日志可清空');
  }

  return (
    <Section title="日志" storageKey="logs" defaultOpen={false}>
      <div className="flex flex-col gap-1 text-[11px]">
        <div>日志详细程度（仅影响写入文件的日志）</div>
        <DeckSelect
          value={settings.logLevel}
          onChange={(next) => void update({ logLevel: next })}
          options={LEVEL_OPTIONS}
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] outline-none focus:border-white/20"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5 no-drag">
          <button
            type="button"
            onClick={() => void handleOpenDirectory()}
            className="flex-1 rounded bg-white/10 px-2 py-1 text-[11px] text-deck-text hover:bg-white/20"
          >
            打开日志目录
          </button>
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            className="flex-1 rounded bg-white/10 px-2 py-1 text-[11px] text-deck-text hover:bg-white/20"
          >
            查看日志
          </button>
        </div>
        <button
          type="button"
          onClick={() => void handleTruncateToday()}
          className="no-drag self-start rounded bg-status-waiting/15 px-2 py-1 text-[11px] text-status-waiting hover:bg-status-waiting/25"
        >
          清空今天日志
        </button>
      </div>

      {toast && (
        <div
          className={`rounded border px-2 py-1 text-[10px] ${
            toast.kind === 'error'
              ? 'border-red-500/30 bg-red-500/10 text-red-200'
              : 'border-deck-border bg-white/[0.04] text-deck-muted'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="text-[10px] leading-snug text-deck-muted/70">
        按天分文件，保留 14 天。位置 <code className="rounded bg-white/5 px-1">~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log</code> (macOS) /
        <code className="rounded bg-white/5 px-1">%APPDATA%/Agent Deck/logs/</code> (Win) /
        <code className="rounded bg-white/5 px-1">~/.config/Agent Deck/logs/</code> (Linux).
      </div>

      <LogViewerModal open={logOpen} onClose={() => setLogOpen(false)} />
    </Section>
  );
}
