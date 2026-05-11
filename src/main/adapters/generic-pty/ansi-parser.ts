/**
 * ANSI escape strip + idle 检测（R4·F3）。
 *
 * 不引入 strip-ansi npm 依赖（ESM-only @ v7、interop 麻烦），
 * 用 inline regex 实现，与 sindresorhus/ansi-regex@6 同源（MIT 许可下的公开标准 regex）。
 *
 * 设计：
 * - stripAnsi(input)：纯函数，移除所有 ANSI escape sequence（CSI / OSC / DCS / SGR ...）
 * - PtyOutputBuffer：环形 buffer，保留最近 N 字节 stripped stdout，给 promptSuffixRegex 二次校验用
 * - IdleDetector：每次 onData reset 定时器；timer fire 时（idleQuietMs 后）触发回调，
 *   如配置 promptSuffixRegex 则同步用 buffer 末尾再 match 一次（不 match → 跳过本次 idle）
 *
 * 选取 strip-ansi vs xterm-headless 的取舍：
 * - 90% 场景 strip-ansi 足够（emit message 文字给 UI，不需要光标 / 终端状态机）
 * - xterm-headless 提供完整 vt100 emulator 但 ~MB 量级依赖 + 状态维护成本 → 不引入
 */

// ────────────────────────────────────────────────────────────────────────────
// stripAnsi
// ────────────────────────────────────────────────────────────────────────────

/**
 * 抄自 sindresorhus/ansi-regex@6.0.1 (MIT)：覆盖 CSI / OSC / 大多数 SGR escape。
 * 不去匹配 BEL / 单字节 control char（保留 \r\n / \t，让上游 UI 自己渲染）。
 */
const ANSI_REGEX = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g',
);

/**
 * 移除所有 ANSI escape sequence；保留 \r\n / \t / 普通字符。
 *
 * 实测覆盖：颜色 (\\x1b[31m...) / 光标移动 (\\x1b[2J) / OSC (\\x1b]0;...\\x07) /
 * 进度条常用的 \\r 重写行 + SGR 组合。
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

// ────────────────────────────────────────────────────────────────────────────
// PtyOutputBuffer — 环形 buffer，保留最近 N 字节 stripped stdout
// ────────────────────────────────────────────────────────────────────────────

/**
 * 环形 buffer：每次 push stripped chunk 追加；总长超 capacity 时从头截断。
 * suffix(N) 返回末尾 N 字节，给 promptSuffixRegex 在「最近输出」上 match 用。
 *
 * capacity 默认 8192 byte：对绝大多数 prompt 检测场景够用（aider / continue / shell）；
 * 防止长时间 session 内存爆。
 */
export class PtyOutputBuffer {
  private chunks: string[] = [];
  private totalLen = 0;

  constructor(private readonly capacity = 8192) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    // REVIEW_24 HIGH-1（reviewer-claude 实测复现）：单 chunk 长度 ≥ capacity 时
    // 必须截尾保留 capacity 字符直接替换 chunks，**不**走下面的 while shift 路径 ——
    // 否则 while 把刚 push 的超大 chunk 自己 shift 走，buffer 归零，promptSuffixRegex
    // 末尾匹配彻底失效（aider 实测：--no-stream 模式下一次性 emit 5-15KB chunk + 末尾 `> `
    // → idle 不 emit waiting-for-user）。
    if (chunk.length >= this.capacity) {
      this.chunks = [chunk.slice(chunk.length - this.capacity)];
      this.totalLen = this.capacity;
      return;
    }
    this.chunks.push(chunk);
    this.totalLen += chunk.length;
    // 总长超 capacity → 从头丢 chunk，直到满足
    while (this.totalLen > this.capacity && this.chunks.length > 0) {
      const head = this.chunks.shift()!;
      this.totalLen -= head.length;
    }
  }

  /** 返回当前 buffer 完整字符串（最近 ≤ capacity 字节）。 */
  toString(): string {
    return this.chunks.join('');
  }

  /** 当前 buffered 字符总长（≤ capacity）。 */
  size(): number {
    return this.totalLen;
  }

  clear(): void {
    this.chunks.length = 0;
    this.totalLen = 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// IdleDetector — stdout 静默 N ms 后触发 callback，可选 promptSuffix 二次校验
// ────────────────────────────────────────────────────────────────────────────

export interface IdleDetectorOptions {
  /** 静默阈值（毫秒）；onData 后超过这么久没新 chunk 触发 fire callback。 */
  idleQuietMs: number;
  /**
   * 可选 prompt suffix regex（buffer 末尾 match）。空字符串 / 解析失败 → 不做二次校验
   * （纯 idleQuietMs 触发）。
   *
   * 设计：用 buffer.toString() 末尾匹配，因为 prompt 通常出现在最末几个字节。
   * 长 buffer 也能 match（regex 自带 $ anchor 时尤其稳）。
   */
  promptSuffixRegex: string;
  /** idle 触发回调；fire 后定时器停（不重复 fire），下次 reset 重新启动。 */
  onIdle: () => void;
  /**
   * 可选自定义定时器函数（vitest fake timers 注入；默认 globalThis.setTimeout / clearTimeout）。
   * 测试用。
   */
  setTimerFn?: typeof setTimeout;
  clearTimerFn?: typeof clearTimeout;
}

/**
 * 用法：
 * ```
 * const detector = new IdleDetector({ idleQuietMs: 3000, promptSuffixRegex: '> $', onIdle: () => emit(...) });
 * pty.onData((chunk) => {
 *   const stripped = stripAnsi(chunk);
 *   buffer.push(stripped);
 *   detector.onData(buffer);
 * });
 * pty.onExit(() => detector.dispose());
 * ```
 *
 * 不在内部维护 buffer：让 caller 持有 PtyOutputBuffer（也可以同 instance 共享给其他用途）。
 */
/**
 * promptSuffixRegex 最大允许长度。超出直接 fallback 不编译，防 ReDoS / 灾难回溯
 * （REVIEW_24 codex MED 3：用户配置的 regex 在 main process timer callback 中同步
 * test()，恶意或意外的灾难回溯可阻塞主进程）。200 char 够覆盖正常 prompt suffix
 * pattern（aider `\\>\\s*$` / 通用 `\\$\\s*$`），异常长 regex 直接拒绝。
 */
const MAX_PROMPT_SUFFIX_REGEX_LENGTH = 200;

export class IdleDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private regex: RegExp | null = null;
  private setTimerFn: typeof setTimeout;
  private clearTimerFn: typeof clearTimeout;

  constructor(private readonly opts: IdleDetectorOptions) {
    this.setTimerFn = opts.setTimerFn ?? setTimeout;
    this.clearTimerFn = opts.clearTimerFn ?? clearTimeout;
    if (opts.promptSuffixRegex && opts.promptSuffixRegex.length > 0) {
      // REVIEW_24 codex MED 3：长度上限拒绝，防 ReDoS 在 main process timer 中阻塞
      if (opts.promptSuffixRegex.length > MAX_PROMPT_SUFFIX_REGEX_LENGTH) {
        console.warn(
          `[idle-detector] promptSuffixRegex too long ` +
            `(${opts.promptSuffixRegex.length} > ${MAX_PROMPT_SUFFIX_REGEX_LENGTH})，` +
            `已退回纯 idleQuietMs 触发`,
        );
        this.regex = null;
      } else {
        try {
          // 不加 'g' flag：只 match 一次（末尾），与「prompt suffix」语义一致
          this.regex = new RegExp(opts.promptSuffixRegex);
        } catch (err) {
          // invalid regex → 退回纯 idleQuietMs（warn but don't crash）
          console.warn(
            `[idle-detector] invalid promptSuffixRegex ${JSON.stringify(opts.promptSuffixRegex)}`,
            err,
          );
          this.regex = null;
        }
      }
    }
  }

  /**
   * 每次 onData 后调；reset 定时器。
   * buffer 用于 fire 时的 promptSuffix 二次校验。
   */
  onData(buffer: PtyOutputBuffer): void {
    this.cancel();
    this.timer = this.setTimerFn(() => {
      this.timer = null;
      // promptSuffixRegex 配置了 → buffer 末尾不 match 时跳过本次 idle
      if (this.regex) {
        const tail = buffer.toString();
        if (!this.regex.test(tail)) return;
      }
      try {
        this.opts.onIdle();
      } catch (err) {
        console.warn('[idle-detector] onIdle callback threw', err);
      }
    }, this.opts.idleQuietMs);
  }

  /** 主动取消未到期定时器（如 close / exit 时）。 */
  cancel(): void {
    if (this.timer) {
      this.clearTimerFn(this.timer);
      this.timer = null;
    }
  }

  /** 停定时器 + 不可再用（与 close 同义）。 */
  dispose(): void {
    this.cancel();
  }
}
