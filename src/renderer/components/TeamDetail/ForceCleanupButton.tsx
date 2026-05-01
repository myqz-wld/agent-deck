import { useState, type JSX } from 'react';

export function ForceCleanupButton({
  name,
  onCleaned,
}: {
  name: string;
  onCleaned: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const cleanup = async (): Promise<void> => {
    const ok = await window.api.confirmDialog({
      title: `清理 team "${name}" 残留`,
      message: `确定要 rm -rf ~/.claude/teams/${name} 与 ~/.claude/tasks/${name} 吗？`,
      detail:
        '该操作不可恢复。仅在 Claude 自身 TeamDelete 失败、确认无活跃 teammate 在跑时使用。',
      okLabel: '强制清理',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await window.api.forceCleanupTeam(name);
      // 同时显示 fs 删除数 + DB 解绑数。任一非 0 都算「做了事」；都是 0 说明 fs 早就空 + DB 也没 team_name 残留（罕见）
      const parts: string[] = [];
      if (r.removed.length > 0) parts.push(`已删除 ${r.removed.length} 个目录`);
      if (r.unsetSessions > 0) parts.push(`解绑 ${r.unsetSessions} 个会话`);
      setResult(parts.length > 0 ? parts.join('，') : '没有残留可删');
      // 清理后让上层（TeamHub）刷新列表。延迟 1.2s 让用户看清绿字结果再跳回——
      // 之前用 300ms 太快，加上 chokidar unlinkDir 触发 refresh 让整页重渲染，
      // 用户根本看不到「已删除」反馈就被 onBack 切走了。
      setTimeout(onCleaned, 1200);
    } catch (e) {
      setResult(`清理失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={() => void cleanup()}
        disabled={busy}
        className="rounded bg-status-waiting/20 px-2 py-1 text-[11px] text-status-waiting hover:bg-status-waiting/30 disabled:opacity-50"
      >
        {busy ? '清理中…' : '强制清理 fs 残留'}
      </button>
      {result && (
        <span
          className={`ml-2 text-[11px] font-medium ${
            result.startsWith('清理失败')
              ? 'text-status-waiting'
              : 'text-status-working'
          }`}
        >
          ✓ {result}
        </span>
      )}
    </div>
  );
}
