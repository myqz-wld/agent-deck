/**
 * archive_plan INDEX.md sync helpers（CHANGELOG_169 F1 Step 1.3 从 archive-plan-impl.ts 抽出）。
 *
 * 含 markdown table cell escape / changelog 列 link 格式化 / INDEX 行级 smart update / 老 2 列
 * header 升级 4 列 4 段独立逻辑。原文件 archive-plan-impl.ts 通过 `export { ... } from
 * './archive-plan/index-sync-helpers'` re-export 保 test seam（多个 test 文件直接 import
 * 这些函数做单元测试，import path 零改动）。
 */

/**
 * archive-plan-tool-ux-followup-20260515 (c) HIGH-5 (claude HIGH-5 / codex LOW-2 共识):
 * markdown table cell escape — frontmatter description / changelog 列含 `|` 或换行会破表 (列被切错
 * / 多行 row)。写入 INDEX 表前必经此 escape。
 */
export function escapeTableCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Follow-up #8: 从 plan 文件正文(已 stripFrontmatter)提取 INDEX 概要列 description。
 *
 * plan 文件 frontmatter 几乎从不带 `description` key(plan 模板用 `## 总目标` / `## Context`
 * 节承载概要),所以旧 fallback 链 `freshFm.description ?? freshFm.plan_id ?? planId` 恒落到
 * planId,INDEX 概要列只显示 plan-id(与文件名列重复,无信息量)。本 helper 提取首个 `## ` section
 * 标题下的首行非空正文文本作为概要,让 INDEX 概要列有实际内容。
 *
 * **提取规则**:
 * - 找首个 `## ` 开头的 section 标题行(`#` / `###`+ 不算,只认恰好二级标题)
 * - 取该标题之后首行**非空、非标题(不以 `#` 开头)、非纯分隔/引用**的文本行
 * - 找到 → trim 返回(caller 端再 escape + slice 200);找不到(无 `## ` section / section 下全空)→ null
 *
 * 纯文本启发式,不解析 markdown 语义;`- ` list item / `> ` quote / ``` ``` fence 行都跳过
 * (这些不是「一句话概要」),保守只取自然段首行。
 */
export function extractPlanSummaryFromBody(body: string): string | null {
  const lines = body.split('\n');
  let inFirstSection = false;
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inFirstSection) {
      // 找首个恰好二级标题 `## xxx`(不匹配 `###`+ / `#`)
      if (/^##\s+\S/.test(line) && !line.startsWith('###')) {
        inFirstSection = true;
      }
      continue;
    }
    // fence 状态机:``` 开/闭 fence,fence 内全跳过(避免 fence 内代码被当概要)
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // section 内:跳过空行 / 标题行 / list / quote / 表格 / 分隔线,取首个自然段文本
    if (line === '') continue;
    if (line.startsWith('#')) {
      // 撞到下一个标题仍没正文 → 放弃(该 section 无自然段文本)
      return null;
    }
    if (
      line.startsWith('-') ||
      line.startsWith('*') ||
      line.startsWith('>') ||
      line.startsWith('|') ||
      /^\d+\.\s/.test(line)
    ) {
      continue;
    }
    return line;
  }
  return null;
}

/**
 * archive-plan-tool-ux-followup-20260515 (b) LOW-1 (codex) / claude MED-5: caller 传 changelogId
 * (string + csv 解析,schema 已 regex 守门 `^\d+(,\d+)*$`) → 拼成 markdown link 单值或 ` / ` 分隔多值。
 * - "122" → "[122](../changelogs/CHANGELOG_122.md)"
 * - "121,122" → "[121](../changelogs/CHANGELOG_121.md) / [122](../changelogs/CHANGELOG_122.md)"
 * - undefined / 空串 → null (caller 不传,smart update 时按 fallback 处理)
 *
 * markdown link 不需 escape (`(` `)` `[` `]` 是 markdown link 语法本身,但 `|` 会破表 — link
 * url/text 都是纯数字 + 斜杠 + 下划线无 pipe,安全)。
 */
export function formatChangelogCell(changelogId: string | undefined): string | null {
  if (!changelogId) return null;
  const ids = changelogId
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  return ids.map((id) => `[${id}](../changelogs/CHANGELOG_${id}.md)`).join(' / ');
}

/**
 * archive-plan-tool-ux-followup-20260515 (b)+(c) syncPlansIndex helper(双方 reviewer 共识 HIGH:
 * INDEX 行 smart update 不能 naive split,必须行级匹配锚定行首)。
 *
 * **行为契约**:
 * - existingContent === null → action='created':写带 4 列 header 的初始 INDEX(`| 文件 | 状态 |
 *   关联 changelog | 概要 |`) + 第一行 4 列 row
 * - existingContent 已含 planId 行(行首 `^| [<planId>.md](`)→ action='updated':canonical
 *   rewrite 该行为 4 列(status='completed' / changelog 列按规则 / description 列覆盖);完全相同 →
 *   action='unchanged'(caller 端可跳过 writeFile)
 * - existingContent 不含 planId 行 → action='appended':append 一行 4 列 row 到 INDEX 末尾
 *
 * **caller 不传 changelogId 时(opts.changelogCell === null)**:smart update 已存在 4 列 row 时
 * 保留原 changelog 列(避免清空已有);旧 2 列 row 或新 append 用 `—` placeholder。
 *
 * **行级 regex 锚定行首 `^| [<planId>.md](`** 而非 `indexContent.includes('(${planId}.md)')` —
 * 后者会撞 description / changelog 列含同款 substring 误命中(罕见但可能,如 description 引用其他
 * plan link)。锚定行首 + 文件链接前缀语法保证只匹配 row 第一列。
 */
export type PlansIndexAction = 'created' | 'appended' | 'updated' | 'unchanged';
export interface SyncPlansIndexOptions {
  planId: string;
  /** 已 escape + slice 200 char 的 description,直接写 INDEX 第 4 列。 */
  description: string;
  /**
   * caller 传 changelogId 时拼成的 markdown link string (formatChangelogCell 输出);
   * caller 不传时 null,smart update 时保留老 4 列 changelog 列 / append 时用 `—` placeholder。
   */
  changelogCell: string | null;
}
export interface SyncPlansIndexResult {
  newContent: string;
  action: PlansIndexAction;
}

export function syncPlansIndex(
  existingContent: string | null,
  opts: SyncPlansIndexOptions,
): SyncPlansIndexResult {
  const { planId, description, changelogCell } = opts;
  const fileLink = `[${planId}.md](${planId}.md)`;
  // regex 锚定行首 + 文件链接前缀:`^| [<planId>.md](` 转义 planId 中 regex 特殊字符
  // (按 schema planId charset `[A-Za-z0-9._-]` 含 `.`)
  const escapedPlanId = planId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const planLineRegex = new RegExp(`^\\| \\[${escapedPlanId}\\.md\\]\\(`);

  // case 1: 不存在 INDEX → 创建 4 列 header + 4 列 row
  if (existingContent === null) {
    const initial =
      '# Plans 索引\n\n' +
      '> 已归档 plan 一行表（archive_plan tool 自动维护)。\n\n' +
      '| 文件 | 状态 | 关联 changelog | 概要 |\n' +
      '|------|------|---------------|------|\n' +
      `| ${fileLink} | completed | ${changelogCell ?? '—'} | ${description} |\n`;
    return { newContent: initial, action: 'created' };
  }

  // archive-plan-tool-ux-followup-20260515 R1 fix codex MED-1:旧 2 列 header
  // (`| 文件 | 概要 |` + `|---|---|`)在 (b)+(c) 升级为 4 列 row 后会与 row 错位
  // (4 列 row 挂 2 列 header 下,markdown 渲染破损)。修法:syncPlansIndex 在 case 2 /
  // case 3 路径前先 detect + canonicalize 升级 header,让 archive_plan 自动平滑迁移
  // 老 INDEX 而非要求 caller 手工 fix。upgrade 自身 idempotent(第二次跑无 2 列
  // header 检测不到即 no-op)。
  const headerUpgrade = upgradeIndexHeader(existingContent);
  const workingContent = headerUpgrade.content;

  const lines = workingContent.split('\n');
  const targetIdx = lines.findIndex((line) => planLineRegex.test(line));

  // case 2: 已含 planId 行 → smart update canonical rewrite 4 列
  if (targetIdx >= 0) {
    // parse 老行用 split('|') 拿 cells;`split('|')` 第一段空(行首 `|`)+ 中间 cells + 末尾空
    // (行尾 `|`)。slice(1, -1) 拿 cells 部分,trim 去 padding。caller 不传 changelogId 时
    // 用老 4 列的第 3 列(index 2)作 fallback。
    //
    // **invariant**(R1 fix codex MED-3 / claude MED-4):**只用 oldCols[2] 作 changelog
    // fallback,严禁扩展用 oldCols[3+]**(后续列若含 escaped `\|` 会被 naive split 误切;
    // 当前 impl 仅读 oldCols[2]=changelog 列在 description 之前,不受 description escape
    // 影响,故安全)。任何未来扩展涉及 oldCols[3+] 必须先实现 escape-aware splitter。
    const oldCols = lines[targetIdx]
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    let newChangelog: string;
    if (changelogCell !== null) {
      newChangelog = changelogCell;
    } else if (oldCols.length >= 3 && oldCols[2]) {
      // 老 4 列 row: oldCols = [fileLink, status, changelog, description, ...]
      newChangelog = oldCols[2];
    } else {
      newChangelog = '—';
    }
    const newLine = `| ${fileLink} | completed | ${newChangelog} | ${description} |`;
    if (lines[targetIdx] === newLine && !headerUpgrade.upgraded) {
      // unchanged 仅当 row 自身相同 AND header 未升级两者都满足
      return { newContent: existingContent, action: 'unchanged' };
    }
    lines[targetIdx] = newLine;
    return { newContent: lines.join('\n'), action: 'updated' };
  }

  // case 3: 不含 planId 行 → append 4 列 row(若 header 已升级,workingContent 反映新 header)
  const appendLine = `| ${fileLink} | completed | ${changelogCell ?? '—'} | ${description} |`;
  const sep = workingContent.endsWith('\n') ? '' : '\n';
  return { newContent: workingContent + sep + appendLine + '\n', action: 'appended' };
}

/**
 * archive-plan-tool-ux-followup-20260515 R1 fix codex MED-1:detect 老 2 列 header
 * `| 文件 | 概要 |` + 紧接 separator `|---|---|`(或类似 2 列 separator)→ 替换为 4 列
 * canonical header `| 文件 | 状态 | 关联 changelog | 概要 |` + `|------|------|---------------|------|`。
 *
 * 保守 detect:必须 header 行只含「文件 / 概要」两列(允许 padding)+ 紧跟 2 列 separator
 * (避免误改用户自定义 header / 多列 header)。idempotent:已是 4 列 header 时 detect 不到 2 列
 * 模式即 no-op。
 *
 * 仅扫描首个匹配的 header(避免一份 INDEX 含多个 table 的极端 case 全部被改 — 不太合理)。
 *
 * **invariant(R2 codex LOW-1)**:本 helper 假设 INDEX **单 table**(本应用约定 ref/plans/INDEX.md
 * 单一表格);多 table INDEX 边角下 target row 可能在第 2+ table,而本 helper 只升级首 table
 * header → 出现 4 列 row 挂 2 列 header。本应用不建议多 table INDEX 模式;后续如要支持需要
 * 「按 target row 找最近上方 table header」精细化升级。
 */
function upgradeIndexHeader(content: string): { content: string; upgraded: boolean } {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const headerMatch = lines[i].match(/^\|\s*文件\s*\|\s*概要\s*\|\s*$/);
    const sepMatch = lines[i + 1].match(/^\|[-:\s]+\|[-:\s]+\|\s*$/);
    if (headerMatch && sepMatch) {
      lines[i] = '| 文件 | 状态 | 关联 changelog | 概要 |';
      lines[i + 1] = '|------|------|---------------|------|';
      return { content: lines.join('\n'), upgraded: true };
    }
  }
  return { content, upgraded: false };
}
