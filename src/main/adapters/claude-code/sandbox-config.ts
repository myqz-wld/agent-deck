/**
 * Claude Code SDK 子进程的 OS 级沙盒配置（REVIEW_14 阶段 2 接入）。
 *
 * 三档语义见 `AppSettings.claudeCodeSandbox` 的 JSDoc。本文件负责把 settings 字段
 * 转成 SDK `query()` options 中的 `sandbox` + `managedSettings` 子对象。
 *
 * 关键决策（plan 文件 effervescent-zooming-mccarthy.md + spike 阶段实证）：
 *
 * 1. **顶层 sandbox 字段而非 managedSettings.sandbox**：
 *    spike 阶段实证有效的写法是 `query.options.sandbox = {enabled, ...}`（sdk.d.ts:1562）。
 *    `managedSettings` 是 policy 层 Settings 对象，**仅承载 policy-only 字段**（如
 *    `sandbox.network.allowManagedDomainsOnly`、`sandbox.filesystem.allowManagedReadPathsOnly`），
 *    不会被 SDK 翻译为「整套 sandbox 装载配置」。本文件最初尝试用 managedSettings.sandbox 包装
 *    被实测证伪：用户报「sandbox 没启」+ settings store 里 claudeCodeSandbox 确认是
 *    workspace-write + curl 走到 proxy 403 而不是被 OS 拦下，改回顶层字段。
 *    阶段 3 如需 policy-only 约束（user/project 不可放宽），可在返回值另加
 *    `managedSettings.sandbox` 字段（与顶层并存）。
 * 2. **`workspace-write` 默认 `allowUnsandboxedCommands: true`**：与 sdk.d.ts:4664 默认一致，
 *    让 model 能用 `dangerouslyDisableSandbox: true` 重试，第二次走 canUseTool 给用户审批
 *    （配套：sdk-bridge canUseTool 顶部加 `SandboxNetworkAccess` 自动 deny + message，让
 *    第一次弹框透明吞，仅留第二次给用户审批）
 * 3. **`strict` 默认 `allowUnsandboxedCommands: false` + `failIfUnavailable: true`**：
 *    完全封死 model 逃逸路径；沙盒不可用时 query 直接 emit error result（不静默降级）
 * 4. **`excludedCommands` 默认名单**：常见开发工具（git / pnpm / npm / yarn / bun / pip /
 *    cargo / go），保护用户常规 dev flow 不被 OS 沙盒误拦
 * 5. **网络 / 文件系统默认黑名单**：
 *    - network：默认无 allowedDomains（model 想联网走 SandboxNetworkAccess → canUseTool 自动 deny → fallback dangerouslyDisableSandbox → 用户审批）
 *    - filesystem.denyRead：~/.ssh / ~/.aws / ~/.config / ~/.kube / ~/.npmrc 等敏感目录
 *    - workspace-write 的 allowWrite：cwd 内 + /tmp + ~/.cache/claude-code（SDK 缓存）
 *    - strict：不给 allowWrite，cwd 也只读
 *
 * 已知未解决项（REVIEW_14 阶段 3 候选）：
 * - 用户自定义 allowedDomains UI（阶段 3 视反馈再加）
 * - 默认 'off' → 'workspace-write'（用户决策暂不切，等更长观察期）
 *
 * CHANGELOG_54 已落地：
 * - excludedCommands 扩 docker/watchman/orb/lima/colima/make/xcodebuild（保守版，
 *   不含 node/npx/brew —— 前两者直接 spawn JS 等于通用 backdoor，brew 写 /usr/local 太宽）
 * - denyRead 扩 shell history (~/.zsh_history, ~/.bash_history) + macOS Keychains/Cookies
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

export type SandboxMode = 'off' | 'workspace-write' | 'strict';

export const SANDBOX_MODE_VALUES: ReadonlyArray<SandboxMode> = [
  'off',
  'workspace-write',
  'strict',
];

/**
 * 默认 excludedCommands 名单。这些命令在沙盒启用时**不进沙盒**（直接执行），
 * 避免常规开发 flow（pnpm install 写 node_modules / git fetch 联网 / cargo build 写 target）被误拦。
 *
 * CHANGELOG_54 扩名单（保守版）：在原 9 个包管理 / 编译器基础上补 OS-level 容器 / 监视 / 构建工具。
 * **不加** node / npx（agent 直接 spawn JS 等于通用 backdoor，npm/pnpm 已豁免间接路径仍有效）；
 * **不加** brew（写 /usr/local 太宽）。
 */
export const SANDBOX_EXCLUDED_COMMANDS: readonly string[] = [
  'git',
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'cargo',
  'go',
  // CHANGELOG_54 扩名单
  'docker',
  'watchman',
  'orb',
  'lima',
  'colima',
  'make',
  'xcodebuild',
];

/**
 * 默认 filesystem.denyRead 名单。任何档位（workspace-write / strict）都拦这些路径，
 * 避免 agent 偷读用户敏感凭据。
 *
 * 注意：路径在调用时会被展开（拼 homedir）。SDK 内部走 OS 级 path canonicalize，符号链接
 * 不能绕过（macOS Seatbelt path-validate）。
 *
 * CHANGELOG_54 扩名单：除原凭据目录外补 shell 历史 + macOS Keychains / Cookies。
 * macOS-only 路径在 Linux 上不存在 SDK 会忽略（denyRead 对不存在的路径无副作用）。
 */
function buildSensitiveDenyReadPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.config'),
    join(home, '.kube'),
    join(home, '.npmrc'),
    join(home, '.netrc'),
    join(home, '.pypirc'),
    join(home, '.gnupg'),
    join(home, '.docker'),
    // CHANGELOG_54 扩名单：shell 历史 + macOS 系统级凭据 / cookies
    join(home, '.zsh_history'),
    join(home, '.bash_history'),
    join(home, 'Library', 'Keychains'),
    join(home, 'Library', 'Cookies'),
  ];
}

/**
 * 把 settings.claudeCodeSandbox 档位转成 SDK query() options 片段。
 *
 * 返回值用展开运算符贴到 query options 里：
 *   ```ts
 *   options: { ..., ...buildSandboxOptions(settingsStore.get('claudeCodeSandbox')) }
 *   ```
 *
 * - `'off'` 返回空对象 `{}`（不传 sandbox 字段，行为同现状）
 * - `'workspace-write'` / `'strict'` 返回 `{ sandbox: {...} }`（顶层字段，SDK 直接装载 OS 沙盒）
 *
 * @param mode 档位（'off' / 'workspace-write' / 'strict'）。未知值按 'off' 处理（防御性兜底）。
 * @param cwd 会话 cwd（用于 workspace-write 档的 allowWrite 路径）
 */
export function buildSandboxOptions(
  mode: SandboxMode | undefined,
  cwd: string,
): { sandbox?: SandboxSettings } {
  if (mode === undefined || mode === 'off') return {};
  // 防御性兜底：未知 mode 字符串静默回 'off' 太隐蔽（settings store 入了脏数据 / 旧版本
  // 字段重命名后没清掉等），warn 一下让控制台有迹可循。三档语义见 SandboxMode union。
  if (mode !== 'workspace-write' && mode !== 'strict') {
    console.warn(`[sandbox] unknown mode "${String(mode)}", falling back to 'off'`);
    return {};
  }

  const sensitiveDenyRead = buildSensitiveDenyReadPaths();
  const home = homedir();

  if (mode === 'workspace-write') {
    return {
      sandbox: {
        enabled: true,
        // 沙盒不可用（旧 macOS 无 Seatbelt / Linux 无 bubblewrap）→ 降级为无沙盒运行
        // 而非直接报错，让用户能继续工作；strict 档才硬性要求
        failIfUnavailable: false,
        // 沙盒已 OS 级兜底，Bash 不需要再走应用层 canUseTool 弹框
        autoAllowBashIfSandboxed: true,
        // 保留 model 逃逸路径：与 sdk.d.ts:4664 默认一致；model 用
        // dangerouslyDisableSandbox: true 重试时走 canUseTool 弹给用户审批
        allowUnsandboxedCommands: true,
        excludedCommands: [...SANDBOX_EXCLUDED_COMMANDS],
        filesystem: {
          // 写权限：cwd + /tmp + SDK 缓存目录
          allowWrite: [cwd, '/tmp', join(home, '.cache', 'claude-code')],
          // 用户敏感目录禁读（防偷凭据）
          denyRead: sensitiveDenyRead,
        },
        // **不传 network 子对象**：实测（REVIEW_15 dev 验证 + [canusetool] log 铁证）
        // SDK 沙盒网络拦截是**双层并行**：
        //
        // 1. **应用层 SandboxNetworkAccess 工具回路**：SDK 调内置 `SandboxNetworkAccess`
        //    工具向 canUseTool 申请 host 授权（payload `{host: 'example.com'}`）→
        //    sdk-bridge canUseTool 顶部分支自动 deny + 「请用 dangerouslyDisableSandbox 重试」
        //    message → model 收到结构化指引 100% 走 fallback（**不是** 概率性 reasoning）
        //
        // 2. **OS/proxy 层实际拦截**：SDK 同时启本地 HTTP CONNECT proxy（端口 64521 之类）
        //    + 注入 `https_proxy=http://localhost:64521` env，按 allowedDomains allowlist
        //    实际拦截 → curl 拿到 `403 Forbidden + X-Proxy-Error: blocked-by-allowlist`
        //
        // `dangerouslyDisableSandbox: true` 让 SDK **不走 proxy 直接执行**（沙盒外），所以
        // model fallback 后 curl 真能拿到 HTML。**实际 UX 收口**：仅 1 次弹框（dangerouslyDisableSandbox
        // 那次给用户审批），SandboxNetworkAccess 那次被自动 deny 不弹给用户。
        //
        // 阶段 3 如需用户自定义 allowedDomains UI，再加 `network.allowedDomains` 让 proxy
        // 直接放行常用域名（github.com / api.anthropic.com 等），减少 SandboxNetworkAccess
        // 触发频率（用户配的常用域名不需要每次走 fallback）。
      },
    };
  }

  // mode === 'strict'：完全只读 + 封死逃逸
  return {
    sandbox: {
      enabled: true,
      // 沙盒必须可用，否则 query 直接 emit error result（不静默降级）
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      // 完全禁止 model 用 dangerouslyDisableSandbox 逃逸
      allowUnsandboxedCommands: false,
      excludedCommands: [...SANDBOX_EXCLUDED_COMMANDS],
      filesystem: {
        // 不给 allowWrite，cwd 也只读
        denyRead: sensitiveDenyRead,
      },
      // 同 workspace-write：不传 network 子对象走 SandboxNetworkAccess 工具回路；
      // 由于 allowUnsandboxedCommands: false，model fallback dangerouslyDisableSandbox
      // 也会被 SDK 直接忽略，最终 model 报「无法联网」给用户
    },
  };
}
