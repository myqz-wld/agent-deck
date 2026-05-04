import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildSandboxOptions,
  SANDBOX_EXCLUDED_COMMANDS,
  SANDBOX_MODE_VALUES,
  type SandboxMode,
} from '../sandbox-config';

/**
 * sandbox-config 是纯函数（输入档位 + cwd → 输出 SDK options 片段），
 * 所有逻辑分支和默认值都可以纯断言验证。
 *
 * 重点：
 * - 'off' 必须返回空对象（不传 sandbox 字段，行为同现状）
 * - 'workspace-write' / 'strict' 返回顶层 sandbox 字段（managedSettings.sandbox 路径
 *   被 spike 阶段实测证伪，回归测必须挡住「再换回 managedSettings」的回退）
 * - workspace-write `allowUnsandboxedCommands: true` + strict `false` 是双弹框 UX 收口的关键
 *   决策（sdk-bridge canUseTool 顶部 SandboxNetworkAccess 自动 deny 分支配套），如果改回
 *   两边对齐就破坏现有 UX 假设
 * - 未知 mode 必须 console.warn + 返回空对象（防御性兜底，settings store 入了脏数据时）
 */

describe('SANDBOX_MODE_VALUES', () => {
  it('恰好枚举三档（增减档位必须改 ipc parseSandboxMode + UI 下拉框 + 本测试）', () => {
    expect(SANDBOX_MODE_VALUES).toEqual(['off', 'workspace-write', 'strict']);
  });
});

describe('SANDBOX_EXCLUDED_COMMANDS', () => {
  it('包含常见包管理 / 编译器 + CHANGELOG_54 扩的 OS-level 容器/监视/构建工具', () => {
    // 用 Set 比对避免名单顺序锁太死（顺序无语义，调整顺序不该挂测试）
    const set = new Set(SANDBOX_EXCLUDED_COMMANDS);
    // 原 9 个（CHANGELOG_41）
    for (const cmd of ['git', 'pnpm', 'npm', 'yarn', 'bun', 'pip', 'cargo', 'go']) {
      expect(set.has(cmd)).toBe(true);
    }
    // CHANGELOG_54 扩名单（保守版）
    for (const cmd of ['docker', 'watchman', 'orb', 'lima', 'colima', 'make', 'xcodebuild']) {
      expect(set.has(cmd)).toBe(true);
    }
    // 不应包含 node/npx/brew（设计决策：直接 spawn JS / 写 /usr/local 太宽，等于通用 backdoor）
    for (const cmd of ['node', 'npx', 'brew']) {
      expect(set.has(cmd)).toBe(false);
    }
  });
});

describe("buildSandboxOptions('off')", () => {
  it('返回空对象（不传 sandbox 字段）', () => {
    expect(buildSandboxOptions('off', '/tmp/foo')).toEqual({});
  });

  it('undefined 也按 off 处理（settings store 缺字段 / 老版本兜底）', () => {
    expect(buildSandboxOptions(undefined, '/tmp/foo')).toEqual({});
  });
});

describe("buildSandboxOptions('workspace-write')", () => {
  const cwd = '/Users/test/project';
  const home = homedir();

  it('返回顶层 sandbox 字段（不是 managedSettings.sandbox，spike 实证证伪过）', () => {
    const result = buildSandboxOptions('workspace-write', cwd);
    expect(result).toHaveProperty('sandbox');
    expect(result).not.toHaveProperty('managedSettings');
  });

  it('enabled = true + autoAllowBashIfSandboxed = true', () => {
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    expect(sandbox?.enabled).toBe(true);
    expect(sandbox?.autoAllowBashIfSandboxed).toBe(true);
  });

  it('failIfUnavailable = false（沙盒不可用降级为无沙盒运行）', () => {
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    expect(sandbox?.failIfUnavailable).toBe(false);
  });

  it('allowUnsandboxedCommands = true（保留 model dangerouslyDisableSandbox 逃逸路径）', () => {
    // 这是双弹框 UX 收口的关键决策：与 sdk.d.ts:4664 默认一致，让 model 能 fallback，
    // canUseTool 把 SandboxNetworkAccess 自动 deny + Bash + dangerouslyDisableSandbox 弹给用户审批
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    expect(sandbox?.allowUnsandboxedCommands).toBe(true);
  });

  it('excludedCommands 是 SANDBOX_EXCLUDED_COMMANDS 的拷贝', () => {
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    expect(sandbox?.excludedCommands).toEqual([...SANDBOX_EXCLUDED_COMMANDS]);
    // 必须是拷贝而不是 reference，避免某次 query 修改了名单影响下一次
    expect(sandbox?.excludedCommands).not.toBe(SANDBOX_EXCLUDED_COMMANDS);
  });

  it('filesystem.allowWrite 包含 cwd / /tmp / ~/.cache/claude-code', () => {
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    expect(sandbox?.filesystem?.allowWrite).toEqual([
      cwd,
      '/tmp',
      join(home, '.cache', 'claude-code'),
    ]);
  });

  it('filesystem.denyRead 包含 ~/.ssh / ~/.aws 等敏感目录 + CHANGELOG_54 扩的 shell history / Keychains', () => {
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    const denyRead = sandbox?.filesystem?.denyRead ?? [];
    expect(denyRead).toContain(join(home, '.ssh'));
    expect(denyRead).toContain(join(home, '.aws'));
    expect(denyRead).toContain(join(home, '.gnupg'));
    expect(denyRead).toContain(join(home, '.npmrc'));
    // CHANGELOG_54 扩
    expect(denyRead).toContain(join(home, '.zsh_history'));
    expect(denyRead).toContain(join(home, 'Library', 'Keychains'));
  });

  it('不传 network 子对象（让 SDK 走 SandboxNetworkAccess 工具回路而非 HTTP_PROXY 注入）', () => {
    // 关键回归挡板：spike 阶段实测发现传 network: {} 会让 SDK 切换到 HTTP_PROXY 模式，
    // 让 model 必须靠概率性 reasoning 推断「沙盒拦的」，UX 不稳。删 network: {} 让 SDK
    // 走 SandboxNetworkAccess 工具回路 → canUseTool 顶部自动 deny + 结构化 message →
    // model 100% fallback dangerouslyDisableSandbox（仅 1 次弹框）。
    const { sandbox } = buildSandboxOptions('workspace-write', cwd);
    expect(sandbox?.network).toBeUndefined();
  });
});

describe("buildSandboxOptions('strict')", () => {
  const cwd = '/Users/test/project';
  const home = homedir();

  it('返回顶层 sandbox 字段', () => {
    const result = buildSandboxOptions('strict', cwd);
    expect(result).toHaveProperty('sandbox');
    expect(result).not.toHaveProperty('managedSettings');
  });

  it('enabled = true + failIfUnavailable = true（沙盒必须可用，否则 query 报错）', () => {
    const { sandbox } = buildSandboxOptions('strict', cwd);
    expect(sandbox?.enabled).toBe(true);
    expect(sandbox?.failIfUnavailable).toBe(true);
  });

  it('allowUnsandboxedCommands = false（完全封死 model 逃逸路径）', () => {
    // 关键决策：strict 档下 model 想用 dangerouslyDisableSandbox 也会被 SDK 直接忽略，
    // 最终 model 报「无法联网」给用户，是档位区别于 workspace-write 的核心特征
    const { sandbox } = buildSandboxOptions('strict', cwd);
    expect(sandbox?.allowUnsandboxedCommands).toBe(false);
  });

  it('autoAllowBashIfSandboxed = true（沙盒已 OS 兜底，Bash 不需要再走 canUseTool 弹框）', () => {
    const { sandbox } = buildSandboxOptions('strict', cwd);
    expect(sandbox?.autoAllowBashIfSandboxed).toBe(true);
  });

  it('filesystem 不给 allowWrite（cwd 也只读）', () => {
    const { sandbox } = buildSandboxOptions('strict', cwd);
    expect(sandbox?.filesystem?.allowWrite).toBeUndefined();
  });

  it('filesystem.denyRead 同 workspace-write 包含敏感目录 + CHANGELOG_54 扩名单', () => {
    const { sandbox } = buildSandboxOptions('strict', cwd);
    const denyRead = sandbox?.filesystem?.denyRead ?? [];
    expect(denyRead).toContain(join(home, '.ssh'));
    expect(denyRead).toContain(join(home, '.aws'));
    // CHANGELOG_54 扩（strict 与 workspace-write 共用同一份 sensitiveDenyReadPaths）
    expect(denyRead).toContain(join(home, '.bash_history'));
    expect(denyRead).toContain(join(home, 'Library', 'Cookies'));
  });

  it('不传 network 子对象（同 workspace-write 走 SandboxNetworkAccess 工具回路）', () => {
    const { sandbox } = buildSandboxOptions('strict', cwd);
    expect(sandbox?.network).toBeUndefined();
  });
});

describe('buildSandboxOptions 未知 mode 防御性兜底', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('未知字符串 mode 返回空对象 + console.warn（settings store 入了脏数据时）', () => {
    // settings store 入了脏数据 / 旧版本字段重命名后没清掉等场景，要降级而非崩
    const result = buildSandboxOptions('weird-mode' as unknown as SandboxMode, '/tmp/foo');
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown mode "weird-mode"'),
    );
  });

  it("'off' 不触发 warn（这是合法档位）", () => {
    buildSandboxOptions('off', '/tmp/foo');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('undefined 不触发 warn（这是合法 fallback）', () => {
    buildSandboxOptions(undefined, '/tmp/foo');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
