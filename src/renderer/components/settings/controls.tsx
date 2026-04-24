import { useEffect, useRef, useState, type JSX } from 'react';

/**
 * 通用控件 + 测试 / picker 组件，给 SettingsDialog 内 Section 复用。
 * 拆出动机：SettingsDialog 720 行 god-component，每加一个设置项都要在巨型文件里找位置；
 * 通用控件抽走后主文件只剩外壳 + dirty guard + section 编排（CHANGELOG_20 / I）。
 *
 * 这里只放「不依赖业务 settings 数据 / 不与父级 dirty contract 耦合」的纯展示控件；
 * 业务 Section（Hook 状态 / 提醒列表 / 生命周期阈值等）仍在 SettingsDialog 主文件里编排。
 */

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-4">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">{title}</div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-deck-border bg-white/[0.02] p-2">
        {children}
      </div>
    </section>
  );
}

export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center justify-between text-[11px]">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer"
      />
    </label>
  );
}

export function NumberInput({
  label,
  value,
  min,
  max,
  /** REVIEW_4 M13：默认整数。所有当前 NumberInput 调用都是整数语义（端口/分钟/小时/秒/天/计数）。
   *  Number(draft) 接受小数 1.5 直接进 hookServerPort/summaryEventCount 等是历史 bug。
   *  显式传 integer={false} 才允许浮点。 */
  integer = true,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  integer?: boolean;
  onChange: (v: number) => void;
}): JSX.Element {
  // 用本地 string 草稿允许中间态（清空 / 删字符 / 输负号）；blur 或 Enter 时才提交并 clamp。
  // REVIEW_2 修：原本每次按键直接 Number(...) onChange，清空 = 0、负数 / 超大值都立即生效，
  // hookServerPort=0 / activeWindowMs=0 这种"立即生效但语义违法"的值会污染 settings DB。
  const [draft, setDraft] = useState<string>(String(value));
  // 父级 value 变化时同步草稿（恢复默认 / 异地修改回流），但用户正在编辑时不抢
  const [editing, setEditing] = useState(false);
  // REVIEW_4 M12：editing 用 ref 持有避免进 effect 依赖。原版依赖 [value, editing]
  // → commit 内 setEditing(false) 立即触发 effect 用旧 prop value 覆盖刚 setDraft 的 clamped，
  // 父级 IPC 慢一帧能看到 "输入 1500 → 闪 900 → 变 1500" flicker。
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    if (editingRef.current) return; // 用户编辑中，不抢
    setDraft(String(value));
  }, [value]);

  const commit = (): void => {
    setEditing(false);
    let n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    if (integer) n = Math.trunc(n);
    let clamped = n;
    if (min !== undefined && clamped < min) clamped = min;
    if (max !== undefined && clamped > max) clamped = max;
    if (clamped !== value) onChange(clamped);
    setDraft(String(clamped));
  };

  return (
    <label className="flex items-center justify-between gap-2 text-[11px]">
      <span className="flex-1">{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={integer ? 1 : 'any'}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(String(value));
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        className="w-20 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-right text-[11px] outline-none focus:border-white/20"
      />
    </label>
  );
}

/**
 * 选择本地音频文件作为提示音；提供「试听 / 选择 / 重置」三个动作。
 * path = null 时显示「默认」（系统提示音），否则显示文件名。
 */
export function SoundPicker({
  label,
  kind,
  path,
  onChange,
}: {
  label: string;
  kind: 'waiting' | 'done';
  path: string | null;
  onChange: (path: string | null) => void;
}): JSX.Element {
  const fileName = path ? path.split('/').pop() : null;
  const choose = async (): Promise<void> => {
    const r = await window.api.chooseSoundFile(path ?? undefined);
    if (r) onChange(r);
  };
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="flex-1">{label}</span>
        <div className="flex items-center gap-1 no-drag">
          <button
            type="button"
            onClick={() => void window.api.playTestSound(kind)}
            title="试听当前提示音"
            className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            ▶ 试听
          </button>
          <button
            type="button"
            onClick={() => void choose()}
            className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20"
          >
            选择…
          </button>
          {path && (
            <button
              type="button"
              onClick={() => onChange(null)}
              title="恢复默认（系统提示音）"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-status-waiting/80 hover:bg-status-waiting/20"
            >
              重置
            </button>
          )}
        </div>
      </div>
      <div className="truncate text-[10px] text-deck-muted/70" title={path ?? '使用系统提示音'}>
        {fileName ?? '默认（系统提示音）'}
      </div>
    </div>
  );
}

/**
 * 选择可执行文件路径（用于「Codex 二进制路径」设置项）。与 SoundPicker 同形态但简化：
 * 不带「试听」，按钮只有「选择 / 重置」+ 一行 hint 文字。
 * path = null 时显示「使用内置（默认）」。
 */
export function ExecutablePicker({
  label,
  hint,
  path,
  onChange,
}: {
  label: string;
  hint: string;
  path: string | null;
  onChange: (path: string | null) => void;
}): JSX.Element {
  const choose = async (): Promise<void> => {
    const r = await window.api.chooseExecutableFile(path ?? undefined);
    if (r) onChange(r);
  };
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="flex-1">{label}</span>
        <div className="flex items-center gap-1 no-drag">
          <button
            type="button"
            onClick={() => void choose()}
            className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20"
          >
            选择…
          </button>
          {path && (
            <button
              type="button"
              onClick={() => onChange(null)}
              title="恢复默认（用应用内置 codex）"
              className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-status-waiting/80 hover:bg-status-waiting/20"
            >
              重置
            </button>
          )}
        </div>
      </div>
      <div className="truncate text-[10px] text-deck-muted/70" title={path ?? '使用应用内置 codex'}>
        {path ?? '使用应用内置（默认）'}
      </div>
      <div className="text-[10px] text-deck-muted/60 leading-snug">{hint}</div>
    </div>
  );
}

/**
 * 测试系统通知按钮。点击后调 main 进程的 Notification API。
 * macOS 系统设置里的应用名取自 `app.getName()` —— dev 模式是「Electron」、
 * 生产打包是「Agent Deck」。提示文字读 main 返回的 appName 拼接，避免
 * 装好的 .app 让用户去找「Electron」找不到。
 */
export function NotificationTestRow(): JSX.Element {
  const [result, setResult] = useState<string | null>(null);
  const test = async (): Promise<void> => {
    setResult(null);
    try {
      const r = (await window.api.showTestNotification()) as {
        ok: boolean;
        reason?: string;
        appName?: string;
      };
      if (r.ok) {
        const name = r.appName || 'Agent Deck';
        setResult(`已发送，没看到横幅请到 系统设置 → 通知 → ${name} 检查权限`);
      } else {
        setResult(`失败：${r.reason ?? '未知'}`);
      }
    } catch (err) {
      setResult(`失败：${(err as Error).message}`);
    }
  };
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="flex-1">测试系统通知</span>
        <button
          type="button"
          onClick={() => void test()}
          className="no-drag rounded bg-white/10 px-2 py-0.5 text-[10px] text-deck-text hover:bg-white/20"
        >
          ▶ 弹一条
        </button>
      </div>
      {result && <div className="text-[10px] leading-snug text-deck-muted/80">{result}</div>}
    </div>
  );
}
