/**
 * Generic-PTY adapter 的 file-watcher（R4·F4）。
 *
 * 用 chokidar 监听 session.cwd 下的文件改动，emit `file-changed` AgentEvent，让 SessionDetail
 * 能看到 PTY 子进程（aider / continue / 自管 wrapper）真实写盘的文件清单。
 *
 * 与 claude-code adapter 的对比：
 * - claude-code emit file-changed 时**带 before/after diff**（来自 Edit/Write 工具入参）
 * - generic-pty 不知道子进程写盘的语义，只能从 fs event 推断「这个文件改了 / 创建了 / 删了」，
 *   **不读 file content**。before/after = null；UI 想看 diff 用 git diff 兜底
 *
 * 设计：
 * - ignored 列表 hardcode 常见噪音（node_modules / .git / dist / build / log / .DS_Store / *.swp）
 * - ignoreInitial: true（不报启动时已存在文件，否则首次启动 emit 几千条 add）
 * - awaitWriteFinish 100ms（防 partial write 触发多次 change，aider 等 atomic write 风格友好）
 * - 不主动跑 cwd === homedir 的 watch（chokidar 在 ~ 下扫描 1-3s + 高 fd 占用，UX 差）
 * - close() 必须 await：与 R3 老 team-watcher 同教训，否则 fs handle 阻塞 process exit
 */

import { watch, type FSWatcher } from 'chokidar';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { AgentEvent } from '@shared/types';

/** 默认忽略的目录 / 文件 pattern（基于 chokidar 的 picomatch glob 语法）。 */
export const DEFAULT_IGNORED_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/out/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.log',
  '**/*.swp',
  '**/*.tmp',
  '**/__pycache__/**',
];

export interface PtyFileWatcherOptions {
  /** 监听根目录（绝对路径）。 */
  cwd: string;
  /** sessionId — 写入 emit event 的 sessionId 字段。 */
  sessionId: string;
  /** 适配器 id — 写入 emit event 的 agentId 字段。 */
  adapterId: 'generic-pty' | 'aider';
  /** AgentEvent 派发回调。 */
  emit: (event: AgentEvent) => void;
  /**
   * 自定义 ignored pattern 追加（用户配置 / 测试覆盖）。空数组 = 仅默认忽略。
   * 与 DEFAULT_IGNORED_PATTERNS 合并；不替换。
   */
  extraIgnored?: readonly string[];
  /**
   * 是否主动跳过 cwd = homedir 的 watch。默认 true（防止扫描 ~ 卡 1-3s）。
   * 用户可在测试 / 特殊场景设 false 覆盖。
   */
  skipHomedirWatch?: boolean;
  /**
   * 自定义 watch factory（vitest 测试注入 mock chokidar）。默认 chokidar.watch。
   */
  watchFactory?: typeof watch;
}

/**
 * 用法（GenericPtyBridge.createSession）：
 * ```
 * const watcher = new PtyFileWatcher({ cwd, sessionId, adapterId: 'generic-pty', emit });
 * await watcher.start();
 * // ... 子进程跑期间 emit file-changed
 * await watcher.close(); // 必 await（与 R3 team-watcher 同教训）
 * ```
 */
export class PtyFileWatcher {
  private watcher: FSWatcher | null = null;
  private closed = false;

  constructor(private readonly opts: PtyFileWatcherOptions) {}

  /**
   * 启动 watch。
   * - cwd = homedir 且 skipHomedirWatch=true → 直接 noop（不报错，watcher 字段保持 null）
   * - chokidar 启动是异步的（fsevents init），但本方法不等 ready；调用方 fire-and-forget
   *   即可（chokidar 内部会在 ready 后开始 emit add/change/unlink）
   */
  async start(): Promise<void> {
    if (this.watcher || this.closed) return;
    const skipHome = this.opts.skipHomedirWatch ?? true;
    const cwdAbs = path.resolve(this.opts.cwd);
    if (skipHome && cwdAbs === path.resolve(homedir())) {
      // 跳过 ~ 的 watch（chokidar 扫描 home 目录会很慢且高 fd 占用）
      console.log(
        `[generic-pty:file-watcher] skip homedir watch for session ${this.opts.sessionId}`,
      );
      return;
    }

    const ignored = [
      ...DEFAULT_IGNORED_PATTERNS,
      ...(this.opts.extraIgnored ?? []),
    ];
    const factory = this.opts.watchFactory ?? watch;
    let watcher: FSWatcher;
    try {
      watcher = factory(cwdAbs, {
        ignored,
        ignoreInitial: true, // 必须：否则首次启动 emit 几千条 add 淹没 UI
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50,
        },
        followSymlinks: false, // 防 symlink 循环 / 大目录穿越
      });
    } catch (err) {
      console.warn(
        `[generic-pty:file-watcher] start failed for ${cwdAbs} (session ${this.opts.sessionId})`,
        err,
      );
      return;
    }
    this.watcher = watcher;

    watcher.on('add', (filePath) => this.emitFsEvent(filePath, 'add'));
    watcher.on('change', (filePath) => this.emitFsEvent(filePath, 'change'));
    watcher.on('unlink', (filePath) => this.emitFsEvent(filePath, 'unlink'));
    watcher.on('error', (err) => {
      console.warn(
        `[generic-pty:file-watcher] error for ${cwdAbs} (session ${this.opts.sessionId})`,
        err,
      );
    });
  }

  /**
   * 关闭 watcher 并释放 fs handle。**必须 await**（chokidar.close 是 async；
   * 不 await 的话 fs handle 阻塞 Electron 进程退出 / Node test process 卡住）。
   *
   * 多次调用安全（已 closed 直接 noop）。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        console.warn(
          `[generic-pty:file-watcher] close failed for session ${this.opts.sessionId}`,
          err,
        );
      } finally {
        this.watcher = null;
      }
    }
  }

  /** 测试便利方法。 */
  __debugIsClosed(): boolean {
    return this.closed;
  }

  private emitFsEvent(filePath: string, fsEvent: 'add' | 'change' | 'unlink'): void {
    if (this.closed) return;
    this.opts.emit({
      sessionId: this.opts.sessionId,
      agentId: this.opts.adapterId,
      kind: 'file-changed',
      payload: {
        cwd: this.opts.cwd,
        filePath,
        // file_changes.kind: 用 'fs-event' 标识来源（区别于 claude-code 的 'text'/'image'，
        // UI 据此可选择不渲染 diff（before/after 都 null）只显文件名 + fsEvent 类型）
        kind: 'fs-event',
        before: null,
        after: null,
        metadata: { source: 'pty-fs-watch', fsEvent },
      },
      ts: Date.now(),
      source: 'sdk',
    });
  }
}
