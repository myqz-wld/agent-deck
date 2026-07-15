/**
 * plan codex-handoff-team-alignment-20260518 §P3 Step 3.9 测试矩阵 TC1+TC2 —
 * bundled-assets.ts 双 root multi-adapter scan + getBundledAssetContent narrow 验证。
 *
 * 覆盖：
 * - TC1: loadBundledAssets() 双 root scan（claude-config + codex-config） → snapshot
 *   含两 adapter 各自 agents/skills，adapter 字段正确 + qualifiedName 形态
 *   `agent-deck:<adapter>:<name>` + 排序 (adapter asc, name asc)
 * - TC2: getBundledAssetContent('agent', 'reviewer-claude', 'claude-code') vs
 *   ('agent', 'reviewer-claude', 'codex-cli') 返回**不同**文件内容（双 root 同名不同内容）
 *
 * 测试策略（plan §P3 Step 3.9 fixture-based）：
 * - tmp dir 写两份 fixture plugin tree（claude-config / codex-config 各一），
 *   同名 reviewer-claude.md 内容刻意不同 + 各自专有 agent
 * - mock 双 root path helper 返 fixture 路径（不依赖真实 resources/）
 * - mock electron app.isPackaged=false 让 loadBundledAssets dev 路径每次重扫（避免缓存）
 * - P3 阶段 codex-config/agent-deck-plugin/agents/ 真实 fs 是空的（P4 才填），fixture-based
 *   策略让 TC2 在 P3 就能 verify multi-root 数据模型，不依赖 P4 真实内容
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── fixture root（每次跑测试用独立 tmp dir，避免 CI 并发干扰） ─────────
const FIXTURE_ROOT = join(tmpdir(), `bundled-assets-multi-root-${process.pid}-${Date.now()}`);
const CLAUDE_PLUGIN_ROOT = join(FIXTURE_ROOT, 'claude-config', 'agent-deck-plugin');
const CODEX_PLUGIN_ROOT = join(FIXTURE_ROOT, 'codex-config', 'agent-deck-plugin');

// fixture 文件内容（TC2 关键：同名 reviewer-claude.md 双 root 内容不同）
const CLAUDE_REVIEWER_CLAUDE_BODY =
  '---\nname: reviewer-claude\ndescription: claude-config 视角 reviewer-claude SDK teammate\nmodel: opus\neffort: xhigh\n---\n\n# claude-config reviewer-claude body\n这是 claude SDK 直接跑的 reviewer。';

const CODEX_REVIEWER_CLAUDE_BODY =
  '---\nname: reviewer-claude\ndescription: codex-config 视角 reviewer-claude wrapper (Bash spawn 外部 claude)\nmodel: gpt-5\n---\n\n# codex-config reviewer-claude wrapper body\n这是 codex SDK 子 session 通过 Bash 起外部 claude CLI 拿 oneshot 的 wrapper。';

const CLAUDE_REVIEWER_CODEX_BODY =
  '---\nname: reviewer-codex\ndescription: claude-config 视角 reviewer-codex wrapper (Bash spawn 外部 codex)\nmodel: sonnet\n---\n\n# claude-config reviewer-codex wrapper body';

const CODEX_REVIEWER_CODEX_BODY =
  'name = "reviewer-codex"\ndescription = "codex-config 视角 reviewer-codex SDK teammate"\nmodel = "gpt-5"\nmodel_reasoning_effort = "max"\n\ndeveloper_instructions = \'\'\'\n# codex-config reviewer-codex body\n\'\'\'';

const CLAUDE_SAMPLE_SKILL =
  '---\nname: claude-only-skill\ndescription: claude-config 专有 skill\n---\n# claude-only-skill SKILL';

const CODEX_SAMPLE_SKILL =
  '---\nname: codex-only-skill\ndescription: codex-config 专有 skill\n---\n# codex-only-skill SKILL';

beforeAll(() => {
  // 建 fixture plugin tree
  mkdirSync(join(CLAUDE_PLUGIN_ROOT, 'agents'), { recursive: true });
  mkdirSync(join(CLAUDE_PLUGIN_ROOT, 'skills', 'claude-only-skill'), { recursive: true });
  mkdirSync(join(CODEX_PLUGIN_ROOT, 'agents'), { recursive: true });
  mkdirSync(join(CODEX_PLUGIN_ROOT, 'skills', 'codex-only-skill'), { recursive: true });

  writeFileSync(join(CLAUDE_PLUGIN_ROOT, 'agents', 'reviewer-claude.md'), CLAUDE_REVIEWER_CLAUDE_BODY);
  writeFileSync(join(CLAUDE_PLUGIN_ROOT, 'agents', 'reviewer-codex.md'), CLAUDE_REVIEWER_CODEX_BODY);
  writeFileSync(join(CLAUDE_PLUGIN_ROOT, 'skills', 'claude-only-skill', 'SKILL.md'), CLAUDE_SAMPLE_SKILL);

  writeFileSync(join(CODEX_PLUGIN_ROOT, 'agents', 'reviewer-claude.md'), CODEX_REVIEWER_CLAUDE_BODY);
  writeFileSync(join(CODEX_PLUGIN_ROOT, 'agents', 'reviewer-codex.toml'), CODEX_REVIEWER_CODEX_BODY);
  writeFileSync(join(CODEX_PLUGIN_ROOT, 'skills', 'codex-only-skill', 'SKILL.md'), CODEX_SAMPLE_SKILL);
});

afterAll(() => {
  if (existsSync(FIXTURE_ROOT)) {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }
});

// ─── mock electron.app + 双 root path helper ───────────────────────────
// electron 在 vitest node 环境会拉 native 模块爆「failed to install」，必须 mock；
// app.isPackaged=false 让 loadBundledAssets 走 dev 分支每次重扫（避免 cache 影响）。
//
// **runtime-logging-electron-log-20260529 Step 3.3.5 后**:bundled-assets.ts 间接 import
// resources-placeholder.ts → logger.ts → 调 `app.setName('Agent Deck')` + `app.getPath('logs')`,
// local mock factory 必须返回这些 method,否则 import 时 TypeError。补全与 vitest-setup.ts
// 全局 mock 同款的 stub set,getAppPath 仍指向 FIXTURE_ROOT 让 bundled-assets dev 分支 fixture
// scan 行为不变。
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => FIXTURE_ROOT, // 不被本测试直接消费(path helper 已 mock),保兜底
    getPath: (_name: string) => tmpdir(), // logger.ts 调 app.getPath('logs')
    getName: () => 'Agent Deck',
    setName: () => undefined, // logger.ts top-level 调
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en-US',
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => undefined,
    hasSingleInstanceLock: () => true,
    quit: () => undefined,
    exit: () => undefined,
    focus: () => undefined,
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
    setLoginItemSettings: () => undefined,
    setAboutPanelOptions: () => undefined,
    setAppUserModelId: () => undefined,
    disableHardwareAcceleration: () => undefined,
  },
}));

vi.mock('@main/adapters/claude-code/sdk-injection', () => ({
  getClaudeAgentDeckPluginSourcePath: () => CLAUDE_PLUGIN_ROOT,
}));

vi.mock('@main/adapters/codex-cli/codex-config-paths', () => ({
  getCodexAgentDeckPluginPath: () => CODEX_PLUGIN_ROOT,
}));

// ─── 动态 import 必须放在 mock 之后 ──────────────────────────────────────
let loadBundledAssets: typeof import('@main/bundled-assets').loadBundledAssets;
let getBundledAssetContent: typeof import('@main/bundled-assets').getBundledAssetContent;
let getBundledAssetPath: typeof import('@main/bundled-assets').getBundledAssetPath;

beforeAll(async () => {
  const mod = await import('@main/bundled-assets');
  loadBundledAssets = mod.loadBundledAssets;
  getBundledAssetContent = mod.getBundledAssetContent;
  getBundledAssetPath = mod.getBundledAssetPath;
});

describe('bundled-assets multi-root scan (plan §P3 Step 3.9 TC1+TC2)', () => {
  it('TC1: loadBundledAssets() 扫描双 root 合并 snapshot，含 claude-code + codex-cli 各自 agents/skills', () => {
    const snapshot = loadBundledAssets();

    // ─── agents: 双 root 各 2 = 4 ───
    expect(snapshot.agents).toHaveLength(4);

    // adapter 字段必填正确 + bundled source
    for (const a of snapshot.agents) {
      expect(a.source).toBe('bundled');
      expect(a.kind).toBe('agent');
      expect(['claude-code', 'codex-cli']).toContain(a.adapter);
    }

    // qualifiedName 形态 `agent-deck:<adapter>:<name>`（plan §P3 Step 3.3 防双 root 同名冲突）
    const claudeReviewerClaude = snapshot.agents.find(
      (a) => a.adapter === 'claude-code' && a.name === 'reviewer-claude',
    );
    const codexReviewerClaude = snapshot.agents.find(
      (a) => a.adapter === 'codex-cli' && a.name === 'reviewer-claude',
    );
    expect(claudeReviewerClaude).toBeDefined();
    expect(codexReviewerClaude).toBeDefined();
    expect(claudeReviewerClaude!.qualifiedName).toBe('agent-deck:claude-code:reviewer-claude');
    expect(codexReviewerClaude!.qualifiedName).toBe('agent-deck:codex-cli:reviewer-claude');
    expect(claudeReviewerClaude!.thinking).toBe('xhigh');
    expect(
      snapshot.agents.find(
        (a) => a.adapter === 'codex-cli' && a.name === 'reviewer-codex',
      )?.thinking,
    ).toBe('max');

    // 排序 (adapter asc claude→codex, name asc) — claude 4 agents 在前 / codex 在后
    const adapters = snapshot.agents.map((a) => a.adapter);
    const claudeIdx = adapters.lastIndexOf('claude-code');
    const codexIdx = adapters.indexOf('codex-cli');
    expect(claudeIdx).toBeLessThan(codexIdx); // 所有 claude 在所有 codex 之前

    // ─── skills: claude-only + codex-only = 2 ───
    expect(snapshot.skills).toHaveLength(2);
    const claudeSkill = snapshot.skills.find((s) => s.adapter === 'claude-code');
    const codexSkill = snapshot.skills.find((s) => s.adapter === 'codex-cli');
    expect(claudeSkill?.name).toBe('claude-only-skill');
    expect(codexSkill?.name).toBe('codex-only-skill');
    expect(claudeSkill?.qualifiedName).toBe('agent-deck:claude-code:claude-only-skill');
    expect(codexSkill?.qualifiedName).toBe('agent-deck:codex-cli:codex-only-skill');
  });

  it('TC2: getBundledAssetContent("agent", "reviewer-claude", adapter) 双 adapter 返回不同内容', () => {
    const claudeRes = getBundledAssetContent('agent', 'reviewer-claude', 'claude-code');
    const codexRes = getBundledAssetContent('agent', 'reviewer-claude', 'codex-cli');

    expect(claudeRes.ok).toBe(true);
    expect(codexRes.ok).toBe(true);
    if (!claudeRes.ok || !codexRes.ok) throw new Error('unreachable'); // narrow for TS

    // 内容真不同（不是 fallback 取了同一份）
    expect(claudeRes.content).toBe(CLAUDE_REVIEWER_CLAUDE_BODY);
    expect(codexRes.content).toBe(CODEX_REVIEWER_CLAUDE_BODY);
    expect(claudeRes.content).not.toBe(codexRes.content);

    // adapter 字段语义区分明确：description 不同也证 frontmatter 各扫各的
    expect(claudeRes.content).toContain('claude-config 视角');
    expect(codexRes.content).toContain('codex-config 视角');
  });

  it('TC2b: getBundledAssetPath narrow 返回各自 root 下绝对路径', () => {
    const claudePath = getBundledAssetPath('agent', 'reviewer-claude', 'claude-code');
    const codexPath = getBundledAssetPath('agent', 'reviewer-claude', 'codex-cli');

    expect(claudePath).toBe(join(CLAUDE_PLUGIN_ROOT, 'agents', 'reviewer-claude.md'));
    expect(codexPath).toBe(join(CODEX_PLUGIN_ROOT, 'agents', 'reviewer-claude.md'));
    expect(claudePath).not.toBe(codexPath);
  });

  it('TC2c: getBundledAssetContent 找不到时返回 ok:false + reason 含 adapter narrow 信息', () => {
    const res = getBundledAssetContent('agent', 'nonexistent-name', 'codex-cli');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('codex-cli');
    expect(res.reason).toContain('nonexistent-name');
  });
});
