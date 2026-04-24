import { useEffect, useState, type JSX } from 'react';

/**
 * 显示 summarizer 最近一次失败原因（by sessionId），在「间歇总结」section 末尾。
 * 用户能直接看到「为什么这个会话没总结」（CHANGELOG_20 / G），不必去 Console / 主进程 stderr 翻。
 *
 * 行为：
 * - mount 时拉一次。不订阅事件——错误数量低，开/关设置面板就重新拉够用
 * - 按 ts desc 显示前 5 条；空时显示「最近无 LLM 错误」
 * - 不带"清空"按钮：成功 summarize 后 main 端会自动清掉对应 sessionId
 */
export function SummarizerErrorsDiagnostic(): JSX.Element {
  const [errors, setErrors] = useState<Record<string, { message: string; ts: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void window.api
      .summarizerLastErrors()
      .then(setErrors)
      .catch((err: unknown) => setError(`拉取失败：${(err as Error).message ?? String(err)}`));
  }, []);

  if (error) {
    return <div className="text-[10px] text-status-waiting leading-snug">{error}</div>;
  }

  if (errors === null) {
    return <div className="text-[10px] text-deck-muted leading-snug">读取诊断中…</div>;
  }

  const entries = Object.entries(errors).sort((a, b) => b[1].ts - a[1].ts);
  if (entries.length === 0) {
    return (
      <div className="text-[10px] text-deck-muted/70 leading-snug">最近无 LLM 总结错误</div>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-[10px] leading-snug">
      <div className="text-deck-muted/70">最近 LLM 总结错误（前 5 条）</div>
      <ul className="flex flex-col gap-0.5">
        {entries.slice(0, 5).map(([sid, info]) => (
          <li
            key={sid}
            className="flex flex-col gap-0.5 rounded border border-status-waiting/30 bg-status-waiting/10 p-1.5"
          >
            <div className="text-[9px] text-status-waiting/80">
              {new Date(info.ts).toLocaleTimeString()} · {sid.slice(0, 12)}…
            </div>
            <div className="break-all text-status-waiting/90" title={info.message}>
              {info.message.slice(0, 200)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
