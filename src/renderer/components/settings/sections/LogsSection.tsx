import { type JSX, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { Section } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

type LogLevel = AppSettings['logLevel'];

const LEVEL_OPTIONS: { value: LogLevel; label: string; description: string }[] = [
  { value: 'error', label: '只记 error', description: '最低噪音，仅 logger.error(...) 落盘' },
  { value: 'warn', label: 'warn 及以上', description: 'error + warn (常规生产)' },
  { value: 'info', label: 'info 及以上 (默认)', description: 'error + warn + info (推荐)' },
  { value: 'verbose', label: 'verbose 及以上', description: '+ verbose (诊断详情)' },
  { value: 'debug', label: 'debug 及以上', description: '+ debug (深度排查)' },
  { value: 'silly', label: 'silly 全开', description: '所有级别 (调试 SDK / IPC 细节)' },
];

/**
 * 「日志」section — Plan runtime-logging-electron-log-20260529 §D9 §Step 3.2.1.
 *
 * 包含 4 个交互元素:
 * - 日志级别下拉 (logLevel: error / warn / info / verbose / debug / silly, 默认 info; 只控
 *   file transport, console 永远 silly 保 dev terminal 全输出 — D4 修订; IPC SettingsSet
 *   handler 调 applyLogLevel(next.logLevel) 即改即生效 — Step 3.1.3)
 * - 打开日志目录按钮 — main 端 shell.openPath(app.getPath('logs'))
 * - 在 Finder 中显示当前日志按钮 — main 端 shell.showItemInFolder(main-YYYY-MM-DD.log);
 *   文件不存在时 fallback 退化为 openPath LOG_DIR (UI 透明无感, 防 macOS showItemInFolder
 *   不存在路径行为不可靠)
 * - 清空今天日志按钮 — main 端 fs.truncateSync 当天 log 文件; 文件不存在时弹 toast「今天还
 *   没有日志可清空」
 */
export function LogsSection({ settings, update }: Props): JSX.Element {
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error' } | null>(null);

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

  async function handleShowCurrentInFinder(): Promise<void> {
    const res = await window.api.logsShowCurrentInFinder();
    if (!res.ok) {
      flashToast(`显示失败: ${res.error ?? 'unknown'}`, 'error');
      return;
    }
    if (res.fallback) {
      flashToast('今天还没有日志文件,已打开日志目录');
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
        <div>日志级别（仅控落盘文件，console 永远 silly 保 dev 终端全输出）</div>
        <select
          value={settings.logLevel}
          onChange={(e) =>
            void update({ logLevel: e.target.value as LogLevel })
          }
          className="no-drag w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] outline-none focus:border-white/20"
        >
          {LEVEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} title={opt.description}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => void handleOpenDirectory()}
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[11px] hover:bg-white/[0.08]"
        >
          打开日志目录
        </button>
        <button
          type="button"
          onClick={() => void handleShowCurrentInFinder()}
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[11px] hover:bg-white/[0.08]"
        >
          在 Finder 中显示当前日志
        </button>
        <button
          type="button"
          onClick={() => void handleTruncateToday()}
          className="no-drag rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[11px] hover:bg-white/[0.08]"
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
        日志按天拆 + 保留 14 天 (logger.ts §D3). 位置 <code className="rounded bg-white/5 px-1">~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log</code> (macOS) /
        <code className="rounded bg-white/5 px-1">%APPDATA%/Agent Deck/logs/</code> (Win) /
        <code className="rounded bg-white/5 px-1">~/.config/Agent Deck/logs/</code> (Linux).
      </div>
    </Section>
  );
}
