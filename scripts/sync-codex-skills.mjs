/**
 * scripts/sync-codex-skills.mjs
 *
 * Plan reviewer-codex-cross-adapter-20260519 §Phase 3 Step 3.1.
 *
 * 同步 SKILL SSOT (`resources/claude-config/agent-deck-plugin/skills/`) 内容到
 * codex-config 端镜像 (`resources/codex-config/agent-deck-plugin/skills/`)。让
 * codex CLI 也能加载同款 SKILL (deep-review / hello-from-deck) — bundled-assets.ts
 * dual-root scan 时 codex root 自然找到镜像内容,资产面板两端均展示;skills-installer
 * 把镜像 cp 到 ~/.codex/skills/agent-deck/ 让 codex CLI runtime 加载。
 *
 * 单一策略 = 纯 build-time cp (RFC 第 2 轮 Q2 + plan review R1 §M3 修订)。
 * 不走 symlink alt — macOS BSD `cp -R src/ symlink-dir/` 会写穿 source 污染。
 *
 * **每次 dev / build / dist 都跑 cp**:
 * - npm/pnpm `predev` / `prebuild` / `predist` hook 自动触发
 * - dev mode 增量 cp 性能不是 bottleneck (skills 总量 ~10KB)
 *
 * **.gitignore enforce**: `resources/codex-config/agent-deck-plugin/skills/` 已
 * 加 .gitignore,cp 产物不入 git,SSOT 仍单源在 claude-config。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const srcSkills = resolve(
  repoRoot,
  'resources/claude-config/agent-deck-plugin/skills',
);
const dstSkills = resolve(
  repoRoot,
  'resources/codex-config/agent-deck-plugin/skills',
);

/**
 * Claude-only SKILL 黑名单(本轮 deep-review R1 M3 修法,prompt-asset-review-optimize-20260527 跟进):
 * - flow-arch-plantuml: SKILL.md 内含 claude builtin tool 名(`AskUserQuestion` / `Read`),
 *   codex 端无对等 tool,镜像到 codex 端会让 codex agent 拿到不可执行流程。
 *   claude-config/README.md L28 明文「仅 claude 端」,本 skip list 与该表述同步 enforce。
 * 后续新增 claude-only SKILL 直接 push 到本列表,**不**需要改其他位置。
 */
const SKIP_SKILLS = new Set(['flow-arch-plantuml']);

if (!existsSync(srcSkills)) {
  console.error(`[sync-codex-skills] ERROR: source not found: ${srcSkills}`);
  process.exit(1);
}

// 先 rm -rf 目标再重 cp,避免 source 删了某 SKILL 后 dst 残留 stale 文件
if (existsSync(dstSkills)) {
  rmSync(dstSkills, { recursive: true, force: true });
}
mkdirSync(dstSkills, { recursive: true });

// 逐个 SKILL 子目录 cp,SKIP_SKILLS 集合内的直接跳过
const skilled = readdirSync(srcSkills);
for (const entry of skilled) {
  const srcEntry = resolve(srcSkills, entry);
  if (!statSync(srcEntry).isDirectory()) continue;
  if (SKIP_SKILLS.has(entry)) {
    console.log(`[sync-codex-skills] - skip claude-only SKILL: ${entry}`);
    continue;
  }
  const dstEntry = resolve(dstSkills, entry);
  cpSync(srcEntry, dstEntry, { recursive: true, force: true });
  console.log(`[sync-codex-skills]   cp ${entry}/`);
}

console.log(
  `[sync-codex-skills] ✓ ${srcSkills.replace(repoRoot, '<repo>')} → ${dstSkills.replace(repoRoot, '<repo>')}`,
);
