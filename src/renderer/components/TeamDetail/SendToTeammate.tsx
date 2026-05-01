import { useState, type JSX } from 'react';
import type { TeamSnapshot } from '@shared/types';

/**
 * 给 teammate 下指令面板（M3）。
 *
 * 关键护栏（不要破坏 / REVIEW_17 R3 / M1-R3）：
 * - 原来 `Tell teammate ${target}: ${text}` 字符串拼接，用户输入含 newline
 *   仿造下一条指令即可让 lead LLM 把整段解析成多条 SendMessage（典型 prompt-injection）
 * - 改结构化包装（fenced code block 让 lead 一目了然看到边界）+ target 名走与
 *   normalizeTeamName 同款 charset 限制
 */
export function SendToTeammate({
  leadSession,
  members,
}: {
  leadSession: { id: string; agentId: string; title: string } | null;
  members: TeamSnapshot['config'] extends infer C ? (C extends { members: infer M } ? M : never) : never;
}): JSX.Element {
  const [target, setTarget] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!leadSession) {
    return (
      <div className="text-[10px] text-deck-muted/70">没有 lead session 可用，无法发送。</div>
    );
  }

  const send = async (): Promise<void> => {
    setError(null);
    if (!text.trim()) {
      setError('指令不能为空');
      return;
    }
    if (!target.trim()) {
      setError('请填 teammate 名字（或直接选下面成员列表中的一个）');
      return;
    }
    setBusy(true);
    try {
      // REVIEW_17 R3 / M1-R3：原来 `Tell teammate ${target}: ${text}` 字符串拼接，
      // 用户输入含 newline / 仿造下一条 "Tell teammate evil: ..." 即可让 lead LLM 把整段
      // 解析成多条 SendMessage（典型 prompt-injection），手动 UI 风险有限但未来 CLI/API
      // 拼 wrapper 时意外行为概率高。改结构化包装（fenced code block 让 lead 一目了然
      // 看到边界，不会把 text 当指令解析）+ target 名走与 normalizeTeamName 同款 charset
      // 限制（防 target 字段同样被注入 newline）。
      const safeTarget = target.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(safeTarget)) {
        setError('teammate 名字含非法字符（仅字母 / 数字 / . _ - 允许，长度 ≤ 64）');
        setBusy(false);
        return;
      }
      const wrapped = [
        `Send the following message to teammate "${safeTarget}":`,
        '',
        '```',
        text.trim(),
        '```',
      ].join('\n');
      await window.api.sendAdapterMessage(leadSession.agentId, leadSession.id, wrapped);
      setText('');
    } catch (e) {
      setError(`发送失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] text-deck-muted/70">
        发往 lead session：<span className="font-mono text-deck-text/85">{leadSession.title}</span>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="teammate 名字（如 reviewer-1）"
          className="flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
      </div>
      {(members as Array<{ name: string }>).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(members as Array<{ name: string }>).map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => setTarget(m.name)}
              className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="给 teammate 的指令"
        rows={2}
        className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
      />
      {error && (
        <div className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !text.trim() || !target.trim()}
          className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
        >
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
