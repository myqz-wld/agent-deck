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
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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

if (!existsSync(srcSkills)) {
  console.error(`[sync-codex-skills] ERROR: source not found: ${srcSkills}`);
  process.exit(1);
}

// 先 rm -rf 目标再重 cp,避免 source 删了某 SKILL 后 dst 残留 stale 文件
if (existsSync(dstSkills)) {
  rmSync(dstSkills, { recursive: true, force: true });
}
mkdirSync(dstSkills, { recursive: true });

// cp -R src/. dst/ 等价: 拷贝内容物 + 强制覆盖
cpSync(srcSkills, dstSkills, { recursive: true, force: true });

console.log(
  `[sync-codex-skills] ✓ ${srcSkills.replace(repoRoot, '<repo>')} → ${dstSkills.replace(repoRoot, '<repo>')}`,
);
