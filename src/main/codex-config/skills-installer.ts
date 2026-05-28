/**
 * Codex `~/.codex/skills/agent-deck/<X>/SKILL.md` 同步管理（CHANGELOG_<X> D2）。
 *
 * 设计目标：把 Agent Deck 自带 plugin 的 skills（resources/claude-config/agent-deck-plugin/
 * skills/<X>/SKILL.md）镜像到 codex 一侧的 ~/.codex/skills/agent-deck/<X>/，让 codex
 * 会话也能 / agent-deck:<skill-name> 触发同名 skill。codex 与 claude 的 SKILL.md
 * frontmatter 几乎同构（name + description），可直接复制。
 *
 * 路径策略：
 * - 内置 skills 镜像到 `~/.codex/skills/agent-deck/<skill-name>/SKILL.md`
 *   - `agent-deck/` 命名空间前缀：避免与用户手写的 `~/.codex/skills/<X>/` 撞名
 *   - 与 `<plugin-root>/skills/` 同结构（每个 skill 一个目录 + SKILL.md，可含 references/）
 * - 用户在 ~/.claude/skills/ 自定义的 skills 不镜像（codex 那边对应 ~/.codex/skills/
 *   是用户自管区域，应用不动）
 *
 * **同步策略**：
 * - 启动时 / settings 改 toggle 时调一次 syncSkills()
 * - **每次启动覆盖写入**（不依赖 mtime 对比；CHANGELOG_169 / REVIEW R3 deep-review fix 后,
 *   syncSkills() 内部对每个 SKILL.md 先 raw → substituteResourcesPlaceholder → write,因为
 *   substitute 输出依赖 runtime constants（app.isPackaged）,source mtime 不是权威 staleness 判据;
 *   raw placeholder / 旧绝对路径残留会让 codex agent invoke skill 时 ENOENT。plugin 总量 ~10 KB
 *   IO 成本忽略不计）
 * - 删除规则：源里删了的 skill 在目标也删（保持镜像一致）
 * - **不**同步 user 副本（resources/ 本身就是只读快照，不需要副本机制）
 *
 * 不实现：
 * - 外部 watch / hot reload monitor 监听 source skills 目录（dev 模式 hot reload 暂不需要，启动同步即可）
 * - skill 内 references/ 子目录递归同步（当前 deep-review / hello-from-deck 都没有
 *   references；新增 references 时先实现递归同步再发布该 skill）
 * - 跨平台路径处理（codex 默认用 ~/.codex 与 macOS 同模式，Win/Linux 同样 homedir）
 */
import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';

/** ~/.codex/skills/agent-deck 绝对路径（与 toml-writer / agents-md-installer 同模式不依赖 app.getPath）。 */
export function getCodexSkillsAgentDeckDir(): string {
  return join(homedir(), '.codex', 'skills', 'agent-deck');
}

/** 内置 plugin skills 源目录绝对路径（dev / prod 自动分流，与 sdk-injection.getClaudeAgentDeckPluginPath 同模式）。 */
function getBuiltinSkillsSourceDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'claude-config', 'agent-deck-plugin', 'skills');
  }
  return join(app.getAppPath(), 'resources', 'claude-config', 'agent-deck-plugin', 'skills');
}

/**
 * 同步 Agent Deck 内置 skills 到 ~/.codex/skills/agent-deck/。
 *
 * 行为：
 * - settings.injectAgentDeckCodexSkills === false → 移除 ~/.codex/skills/agent-deck/
 *   整个目录（保留用户在 ~/.codex/skills/ 自管的其他目录）
 * - true（默认）→ 镜像内置 skills
 *
 * 失败 warn 不阻断（与 D1 同模式）。
 *
 * @returns 写入的 skill 名列表（用于测试 / 调试）；跳过 / 失败返回 null
 */
export function syncSkills(): string[] | null {
  const enabled = settingsStore.get('injectAgentDeckCodexSkills');
  const targetDir = getCodexSkillsAgentDeckDir();

  if (!enabled) {
    // 移除整个 agent-deck/ 目录，保留 ~/.codex/skills/ 其他用户内容
    if (existsSync(targetDir)) {
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[codex-skills] 移除 ${targetDir} 失败`, err);
        return null;
      }
    }
    return [];
  }

  const sourceDir = getBuiltinSkillsSourceDir();
  if (!existsSync(sourceDir)) {
    console.warn(`[codex-skills] 内置 skills 源目录不存在：${sourceDir}`);
    return null;
  }

  let sourceSkills: string[] = [];
  try {
    sourceSkills = readdirSync(sourceDir).filter((name) => {
      const path = join(sourceDir, name);
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    console.warn(`[codex-skills] 读源目录失败：${sourceDir}`, err);
    return null;
  }

  mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];

  // 1) 镜像源 skills（mtime 对比避免每次都写）
  for (const name of sourceSkills) {
    const srcSkillMd = join(sourceDir, name, 'SKILL.md');
    if (!existsSync(srcSkillMd)) continue; // 不是 skill 目录跳过
    const dstSkillDir = join(targetDir, name);
    const dstSkillMd = join(dstSkillDir, 'SKILL.md');

    try {
      // CHANGELOG_169 / REVIEW R2 codex HIGH: substitute {{AGENT_DECK_RESOURCES}} before write.
      // **No mtime skip optimization** — substitute output depends on runtime constants
      // (app.isPackaged), so source mtime is NOT authoritative for target staleness. After
      // upgrading from raw → substituted SKILL, source mtime might still be older than target
      // (which has stale raw cp), and mtime check would falsely skip. Always overwrite.
      mkdirSync(dstSkillDir, { recursive: true });
      const raw = readFileSync(srcSkillMd, 'utf8');
      const content = substituteResourcesPlaceholder(raw);
      writeFileSync(dstSkillMd, content, 'utf8');
      written.push(name);
    } catch (err) {
      console.warn(`[codex-skills] 同步 ${name} 失败`, err);
    }
  }

  // 2) 删除源里没有但目标存在的 skill 目录（保持镜像一致）
  try {
    const dstNames = readdirSync(targetDir).filter((name) => {
      try {
        return statSync(join(targetDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
    for (const name of dstNames) {
      if (!sourceSkills.includes(name)) {
        try {
          rmSync(join(targetDir, name), { recursive: true, force: true });
        } catch (err) {
          console.warn(`[codex-skills] 删除孤儿 ${name} 失败`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[codex-skills] 扫目标目录失败（孤儿清理跳过）', err);
  }

  return written;
}
