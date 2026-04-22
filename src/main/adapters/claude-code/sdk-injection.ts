/**
 * Agent Deck 自带的 CLAUDE.md + skill 注入工具。
 *
 * 设计要点：
 * 1. 资源走 package.json 的 build.extraResources（不放 asar 内），与 resources/bin 同模式。
 *    SDK CLI 子进程会扫描 plugin 目录下的 SKILL.md / plugin.json 等文件；
 *    asar 内 fs 行为依赖 Electron 自带 patch，在 spawn 出来的子进程里
 *    不一定可靠（子进程不是 Electron Node），走 extraResources 最稳。
 *
 * 2. 路径分流：
 *    - dev 模式（`pnpm dev`）：<repo>/resources/claude-config/...
 *    - prod (.app)：<app>/Contents/Resources/claude-config/...
 *
 * 3. CLAUDE.md 注入位置：通过 SDK 的
 *    `systemPrompt: { type: 'preset', preset: 'claude_code', append }` 字段，
 *    实际位置在 user/project/local 三层 CLAUDE.md 全部加载完之后追加。
 *    LLM 上下文末尾位置 instruction following 最强。
 *
 * 4. Skill 注入位置：通过 SDK 的 `plugins: [{ type: 'local', path }]`，
 *    skill 自动以 `agent-deck:<skill-name>` 命名空间注册，与用户
 *    `~/.claude/skills/` 不冲突。
 *
 * 5. 缓存：CLAUDE.md 内容只读一次缓存到内存。文件在 .app 内是 read-only，
 *    改了也得重新打包，无需每次会话重读。
 */
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedClaudeMdAppend: string | null = null;

/**
 * 返回 agent-deck 自带 plugin 根的绝对路径，传给 SDK 的 `plugins[].path`。
 * SDK 会读 `<plugin>/.claude-plugin/plugin.json` + 扫 `<plugin>/skills/`。
 */
export function getAgentDeckPluginPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'claude-config', 'agent-deck-plugin');
  }
  return join(app.getAppPath(), 'resources', 'claude-config', 'agent-deck-plugin');
}

/**
 * 读取 agent-deck 自带 CLAUDE.md，返回追加到 SDK preset system prompt 末尾的文本。
 *
 * 失败兜底：返回空字符串 + console.warn，让会话照常起来（不阻塞用户操作）。
 * SDK 接受 append 为空字符串等价于不追加。
 */
export function getAgentDeckSystemPromptAppend(): string {
  if (cachedClaudeMdAppend !== null) {
    return cachedClaudeMdAppend;
  }
  try {
    const path = app.isPackaged
      ? join(process.resourcesPath, 'claude-config', 'CLAUDE.md')
      : join(app.getAppPath(), 'resources', 'claude-config', 'CLAUDE.md');
    const raw = readFileSync(path, 'utf8');
    cachedClaudeMdAppend = `\n\n--- Agent Deck 应用约定（随应用打包，独立于 user/project/local CLAUDE.md）---\n\n${raw}`;
  } catch (err) {
    console.warn('[sdk-injection] 读取 agent-deck CLAUDE.md 失败，跳过注入:', err);
    cachedClaudeMdAppend = '';
  }
  return cachedClaudeMdAppend;
}
