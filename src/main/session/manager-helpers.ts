import { realpathSync } from 'node:fs';
import { basename, resolve as resolvePath, sep } from 'node:path';
import type { ActivityState, AgentEvent } from '@shared/types';

/**
 * SessionManager 用到的 pure helpers。
 *
 * 之所以独立成文件：保持 manager.ts 内 SessionManagerClass 的方法体不被
 * 字符串 / 状态机 / 路径化等无副作用工具稀释（class 主体已被多次 review
 * 加固 race / lifecycle / claim 路径，不动 class 主体即风险最小）。
 *
 * 4 个 helper 均无 mutable state、无写入副作用；其中 `normalizeCwd` 会**读 FS**
 * 做 realpath 标准化（消化 macOS `/private/var ↔ /var` 等符号链接别名），
 * 失败 fallback 到 `resolvePath` + 去尾 `/`：
 * - normalizeCwd：读 FS realpath（消化符号链接 / `.`/`..` / 尾斜杠）
 * - nextActivityState：activity 状态机推进（waiting-for-user 子类型分流）
 * - extractCwd / deriveTitle：从 event payload / cwd 路径段抽 string
 */

/** 路径标准化：消化 `.`/`..`、尾斜杠、符号链接，让两端 cwd 比较稳定。 */
export function normalizeCwd(cwd: string): string {
  if (!cwd) return '';
  try {
    return realpathSync(resolvePath(cwd));
  } catch {
    // 兜底用 path.sep 去尾分隔符（Win 反斜杠 + POSIX 正斜杠）
    return resolvePath(cwd).replace(new RegExp(`[${sep === '\\' ? '\\\\/' : '/'}]+$`), '');
  }
}

/**
 * activity 状态机推进。
 *
 * 注意 `waiting-for-user` 这个 kind 在两条通路上语义并不统一：
 * - SDK 通道 emit 的 `permission-cancelled` / `ask-question-cancelled` /
 *   `exit-plan-cancelled` 也用这个 kind，但它本质是「请把那条 pending 撤掉」
 *   而不是「又一次需要用户输入」。如果按 kind 一律切到 'waiting'，会出现
 *   「按完按钮后状态卡在 waiting + 弹一条多余的等待提醒」。
 * - 因此这里需要看 payload.type：以 `-cancelled` 结尾的视为「取消」事件，
 *   activity 不动（保持 current）。
 */
export function nextActivityState(
  current: ActivityState,
  kind: AgentEvent['kind'],
  payload: unknown,
): ActivityState {
  switch (kind) {
    case 'session-start':
      return 'idle';
    case 'tool-use-start':
    case 'message':
    case 'thinking':
    case 'file-changed':
      return 'working';
    case 'tool-use-end': {
      const clearsTerminalPermission = (
        payload as { clearsTerminalPermission?: boolean } | null | undefined
      )?.clearsTerminalPermission === true;
      if (current === 'waiting' && clearsTerminalPermission) return 'working';
      return current === 'waiting' ? 'waiting' : 'working';
    }
    case 'waiting-for-user': {
      const type = (payload as { type?: string } | null | undefined)?.type;
      if (typeof type === 'string' && type.endsWith('-cancelled')) {
        // SDK 自己撤掉的 pending：不切状态，保留之前的 activity。
        // 真实的 pending Map 是否清空由 store / pendingMap 自己维护。
        return current;
      }
      return 'waiting';
    }
    case 'finished':
      return 'finished';
    case 'session-end':
      return current;
    default:
      return current;
  }
}

export function extractCwd(event: AgentEvent): string | undefined {
  const p = event.payload as { cwd?: string } | null | undefined;
  return p?.cwd;
}

export function deriveTitle(cwd: string): string {
  if (!cwd) return '未命名会话';
  // path.basename 跨平台处理尾分隔符 + 平台分隔符（Win `\` / POSIX `/`）
  return basename(cwd) || cwd;
}
