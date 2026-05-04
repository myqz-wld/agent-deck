/**
 * Agent Teams M2 — fs 监听单例。
 *
 * 模式：renderer 通过 IPC `TeamSubscribe` 订阅某个 team 的 fs 变化（用 chokidar 监听
 * `~/.claude/teams/<name>/` + `~/.claude/tasks/<name>/`），引用计数 +1；`TeamUnsubscribe`
 * 时引用计数 -1，到 0 后**等 60s grace** 才真 close（防快速切换 TeamDetail 反复 close/reopen
 * 的开销 / 漏掉变化）。
 *
 * 任一目录的文件 add / change / unlink / 整目录 unlinkDir → 通过 eventBus emit
 * `'team-data-changed'`，main bootstrap 桥接到 IPC `IpcEvent.TeamDataChanged` 推 renderer。
 *
 * **chokidar 而不是原生 fs.watch**：
 * - Linux 不支持 recursive；macOS recursive 事件去重不可靠
 * - 原子替换（mv tmp final）触发 rename 而非 change，原生 fs.watch 漏报
 * - 文件锁 / 写入中状态，原生 fs.watch 早 emit 一堆中间态
 * - chokidar 内部按平台选合适后端 + `awaitWriteFinish` 防抖，是社区共识
 *
 * **进程退出**：调用 `teamWatcher.shutdownAll()`，立即 close 所有 watcher（不等 grace）。
 * main/index.ts 的 before-quit listener 应该调用一次。
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { TeamDataChangedEvent } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { getTasksRoot, getTeamsRoot } from './team-fs';

/**
 * 引用计数到 0 后再等 60s 才真 close watcher。
 * 选 60s 是因为：
 * - 快速切换 TeamDetail（用户在多个 team 之间切）每次都重建 watcher，开销大
 * - 60s 远长于任何 UI 切换间隔，长于绝大多数「再开同一 team」场景
 * - 不会无限增长（最多 = 已访问过的 team 数 × watcher size，可接受）
 */
const GRACE_MS = 60_000;

/** chokidar awaitWriteFinish 配置：250ms 内文件不再变化才 emit，防写入中多次触发。 */
const AWAIT_WRITE_FINISH = { stabilityThreshold: 250, pollInterval: 100 } as const;

interface Entry {
  watcher: FSWatcher;
  refCount: number;
  /** 引用计数到 0 后启动；clearTimeout 后置 null。 */
  graceTimer: NodeJS.Timeout | null;
}

class TeamWatcherManager {
  private entries = new Map<string, Entry>();

  /** 当前活跃 watcher 数（debug / 验证用，确认 unsubscribe 后真清掉）。 */
  size(): number {
    return this.entries.size;
  }

  /**
   * 引用计数 +1。第一次订阅时建 chokidar watcher。
   * 如果 watcher 处于 grace（refCount=0 但还没真 close），重新 +1 并取消 grace timer
   * （复用既有 watcher，避免无意义关闭再重开）。
   */
  subscribe(name: string): void {
    let entry = this.entries.get(name);
    if (entry) {
      entry.refCount += 1;
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
      return;
    }
    // realpath 化 teams/tasks root：~/.claude 在常见 dotfile 场景是 symlink，chokidar 在
    // macOS fsevents 下回 dispatchByPath 的 p 是 realpath 路径，与 raw symlink path 严格
    // 比较永远 false → emit 永远不 fire（实测踩过）。
    // root 不存在时 fallback raw（chokidar 等目录创建；事后 subscribe 重启时修正）。
    const teamsRootReal = existsSync(getTeamsRoot()) ? realpathSync(getTeamsRoot()) : getTeamsRoot();
    const tasksRootReal = existsSync(getTasksRoot()) ? realpathSync(getTasksRoot()) : getTasksRoot();
    const teamDir = join(teamsRootReal, name);
    const tasksDir = join(tasksRootReal, name);
    // chokidar 对不存在的目录默认会等待其出现 (ignoreInitial: true 跳过启动时已存在的项的 add 事件)。
    // 监听 teamDir + tasksDir 两个目录及其内容的所有变化。
    const watcher = chokidar.watch([teamDir, tasksDir], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: AWAIT_WRITE_FINISH,
    });
    const emit = (kind: TeamDataChangedEvent['kind']): void => {
      eventBus.emit('team-data-changed', { name, kind });
    };
    const dispatchByPath = (p: string): void => {
      // chokidar emit 的路径已被 normalize（绝对路径，无尾斜杠），可直接 startsWith 比对。
      // Win 用反斜杠 `\`，POSIX 用正斜杠 `/`，统一走 `path.sep`。
      if (p === teamDir || p.startsWith(teamDir + sep)) emit('config');
      else if (p === tasksDir || p.startsWith(tasksDir + sep)) emit('task-list');
    };
    watcher.on('add', dispatchByPath);
    watcher.on('change', dispatchByPath);
    watcher.on('unlink', dispatchByPath);
    watcher.on('unlinkDir', (p) => {
      // teamDir 或 tasksDir 自身被删（典型：用户手动 rm -rf 残留 / Claude cleanup）
      // → 整个 team 视图失效，让 renderer 隐藏
      if (p === teamDir || p === tasksDir) {
        emit('unlinked');
      } else {
        // 子目录被删（不太可能，team 内部不嵌套子目录）→ 当 task-list 变更处理
        dispatchByPath(p);
      }
    });
    watcher.on('error', (err) => {
      console.warn(`[team-watcher] error for "${name}":`, err);
    });
    entry = { watcher, refCount: 1, graceTimer: null };
    this.entries.set(name, entry);
    console.log(`[team-watcher] subscribe "${name}" (size=${this.entries.size})`);
  }

  /**
   * 引用计数 -1。到 0 后启动 60s grace 计时器，触发时再次确认 refCount===0 才真 close。
   * 不立刻 close 是为了防快速切换 TeamDetail 反复重建 watcher 的开销。
   */
  unsubscribe(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return; // 容错：renderer 可能在 subscribe 失败后仍调 unsubscribe
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    if (entry.graceTimer) clearTimeout(entry.graceTimer); // 防御重复 unsub
    entry.graceTimer = setTimeout(() => {
      // grace 期内如果有人重新 subscribe，refCount 已 +1，这里二次确认
      const cur = this.entries.get(name);
      if (!cur || cur.refCount > 0) return;
      void cur.watcher.close().catch((err) => {
        console.warn(`[team-watcher] close failed for "${name}":`, err);
      });
      this.entries.delete(name);
      console.log(`[team-watcher] grace-close "${name}" (size=${this.entries.size})`);
    }, GRACE_MS);
  }

  /**
   * 进程退出钩子：立即 close 所有 watcher，不等 grace。
   * main/index.ts 的 before-quit listener 调用一次（chokidar 持有 fs handle，不 close 会让进程退不干净）。
   */
  async shutdownAll(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [, entry] of this.entries) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      closes.push(entry.watcher.close());
    }
    this.entries.clear();
    await Promise.allSettled(closes);
  }
}

export const teamWatcher = new TeamWatcherManager();
