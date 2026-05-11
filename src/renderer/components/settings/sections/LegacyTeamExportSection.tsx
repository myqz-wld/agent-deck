import { useEffect, useState, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

interface ExportResult {
  destDir: string | null;
  copied: { teams: boolean; tasks: boolean };
}

/**
 * R3.E12 — Legacy team data 导出 section（PR-A 阶段加，PR-B 硬切删老 backend 后仍保留供翻历史）。
 *
 * 详 R3.E0 ADR §6.2 / §11.4。
 *
 * UI 流程：
 * 1. 检测 hasLegacyTeamData 状态显示
 * 2. 「选择目标目录并导出」按钮 → window.api.chooseDirectory() → window.api.legacyTeamsExport()
 * 3. 显示导出结果（destDir + 哪些子集成功）
 *
 * R3 PR-A 上线后：用户首次打开应用时启动 dialog（在 SettingsDialog 顶层 useEffect 检测）会
 * 弹一个不可关闭 alert 引导用户来这里点 export，ack 后写 r3LegacyExportNoticeAcked=true 不再弹。
 */
export function LegacyTeamExportSection({ settings, update }: Props): JSX.Element {
  const [hasData, setHasData] = useState<{ teams: boolean; tasks: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.legacyTeamsHasData().then((r) => {
      if (!cancelled) setHasData(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const noLegacyData = hasData !== null && !hasData.teams && !hasData.tasks;

  async function onExport(): Promise<void> {
    setError(null);
    setLastResult(null);
    const target = await window.api.chooseDirectory();
    if (!target) return;
    setBusy(true);
    try {
      const r = await window.api.legacyTeamsExport(target);
      setLastResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="老 Agent Teams 数据导出 (R3 硬切前必备)" storageKey="legacy-teams-export" defaultOpen={false}>
      <div className="text-[10px] leading-snug text-deck-muted/70">
        <strong className="text-amber-300/90">⚠ R3 阶段硬切提示</strong>：Agent Deck 即将彻底移除老的
        Claude Code Agent Teams 后端（inbox 文件协议 / fs watcher）。下一个版本（PR-B）发布后：
        <ul className="list-disc pl-4">
          <li>Claude 在 CLI 内自然语言起的 team 不再被 agent-deck UI 看到</li>
          <li><code className="rounded bg-white/5 px-1">~/.claude/teams/</code> /
            <code className="rounded bg-white/5 px-1">~/.claude/tasks/</code> 不再被读取</li>
          <li>老的 deep-code-review SKILL 重写为走 mcp__agent_deck__* 5 个 tool</li>
        </ul>
        点下面按钮把这两个目录复制一份到你选定的位置，文件不会被删除（应用不主动 rm），但建议先备份。
      </div>

      <div className="mt-2 space-y-1">
        <div className="text-[10px] text-deck-muted/80">
          <span className="text-deck-text/85">本地数据探测</span>：
          {hasData === null ? '检测中...' : (
            <>
              <code className="ml-1 rounded bg-white/5 px-1">~/.claude/teams/</code> {hasData.teams ? '✓' : '✗'}
              {' / '}
              <code className="rounded bg-white/5 px-1">~/.claude/tasks/</code> {hasData.tasks ? '✓' : '✗'}
            </>
          )}
        </div>
        {noLegacyData && (
          <div className="text-[10px] text-deck-muted/60">无 legacy data 可导出（你之前可能没用过 Claude agent teams）。</div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded border border-white/10 bg-white/5 px-3 py-1 text-xs text-deck-text hover:bg-white/10 disabled:opacity-50"
          onClick={() => void onExport()}
          disabled={busy || noLegacyData}
        >
          {busy ? '导出中...' : '选择目标目录并导出'}
        </button>
        {!settings.r3LegacyExportNoticeAcked && (
          <button
            type="button"
            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-deck-muted hover:bg-white/10"
            onClick={() => void update({ r3LegacyExportNoticeAcked: true })}
          >
            我已知晓（不再弹提示）
          </button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          导出失败：{error}
        </div>
      )}

      {lastResult && (
        <div className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">
          {lastResult.destDir ? (
            <>
              已导出到：<code className="rounded bg-black/20 px-1">{lastResult.destDir}</code>
              <br />
              teams: {lastResult.copied.teams ? '✓' : '✗'} / tasks: {lastResult.copied.tasks ? '✓' : '✗'}
            </>
          ) : (
            <>无 legacy data 可导出。</>
          )}
        </div>
      )}
    </Section>
  );
}
