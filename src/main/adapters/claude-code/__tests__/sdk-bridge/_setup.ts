/**
 * sdk-bridge 单测共享 fixture（CHANGELOG_105 拆分）。
 *
 * 抽出 TestBridge 子类 + emits 数组 + makeBridge factory，让 recovery 与 consume-fork 两组
 * test 复用。**vi.mock 必须**在每个 .test.ts 文件顶部独立声明（hoisted 到文件顶部生效），
 * 不能从此 helper 导出 —— 所以每个 sub-test 文件自己写一份 vi.mock。
 *
 * 但 import ClaudeSdkBridge 时只要 caller 已 hoisted vi.mock，sessionRepo / sessionManager
 * 等都是 mock 实例，安全。
 *
 * `emits` 是 module-level mutable array：vitest 默认 worker isolation 保证每个 test 文件
 * 独立 module instance，两个 sub-test 文件互不污染；每个 test 自己 beforeEach 清空。
 */

import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import type { AgentEvent } from '@shared/types';

export interface CreateSessionCall {
  cwd: string;
  prompt?: string;
  resume?: string;
  permissionMode?: string;
}

export class TestBridge extends ClaudeSdkBridge {
  /** 替身：每次调记录参数；resolved 控制是否立刻完成 */
  public createCalls: CreateSessionCall[] = [];
  /** 测试时控制 createSession 是否阻塞 / 抛错；undefined = 立刻 resolve */
  public createBehavior: 'resolve' | 'block' | 'reject' = 'resolve';
  public unblock?: () => void;
  public rejectWith?: Error;
  /** 默认让 jsonl "存在"，测试 fallback 路径时设 false */
  public jsonlExistsOverride = true;
  /**
   * CHANGELOG_99：cwd 存在性 mock。默认 boolean(true 让现有 case cwd precheck 不触发 fallback)。
   * 测试 fallback 真实行为时改用 Map<path, boolean> 让启发式按路径返回不同值,
   * 测启发式 1 (worktrees regex 命中) / 启发式 2 (parent walk) 真实算法路径,不直接 spy
   * findFallbackCwd 私有方法。
   */
  public cwdExistsOverride: boolean | Map<string, boolean> = true;

  override async createSession(opts: {
    cwd: string;
    prompt?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    resume?: string;
  }): Promise<{ sessionId: string; abort: () => void }> {
    this.createCalls.push({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      permissionMode: opts.permissionMode,
    });
    if (this.createBehavior === 'block') {
      await new Promise<void>((res) => {
        this.unblock = res;
      });
    } else if (this.createBehavior === 'reject') {
      throw this.rejectWith ?? new Error('mock create reject');
    }
    return { sessionId: opts.resume ?? 'new-sid', abort: () => undefined };
  }

  // 预检 jsonl 文件存在性是 main 进程实文件查询，单测环境下没有真 ~/.claude/projects/...
  // 默认返回 true 让测试走 resume 主路径；fallback case 显式设 false 验证降级路径
  protected resumeJsonlExists(_cwd: string, _sessionId: string): boolean {
    return this.jsonlExistsOverride;
  }

  /**
   * CHANGELOG_99 cwd 失效 fallback test seam(同 jsonl override 模式)。
   * 默认 true 让现有 case 不受 cwd precheck 影响;新加的 cwd fallback case 显式设 false 或
   * Map 触发降级 + 测启发式行为。Map 形式让启发式 walk 算法按路径返回不同值,测真实路径。
   */
  protected cwdExists(cwd: string): boolean {
    if (typeof this.cwdExistsOverride === 'boolean') return this.cwdExistsOverride;
    return this.cwdExistsOverride.get(cwd) ?? false;
  }
}

export const emits: AgentEvent[] = [];

export function makeBridge(): TestBridge {
  return new TestBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}
