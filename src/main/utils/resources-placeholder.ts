/**
 * Shared helper for substituting `{{AGENT_DECK_RESOURCES}}` placeholder with the absolute path
 * to bundled resources root (CHANGELOG_168 deep-review R3 + post-R3 follow-up).
 *
 * **Why one shared module**: 5 prompt-injection paths each need to substitute placeholder
 * before the text reaches an agent. Originally, each path had its own private copy of the same
 * 3 helpers (`RESOURCES_PLACEHOLDER` + `resolveAgentDeckResourcesRoot` + `substituteResourcesPlaceholder`).
 * R3 reviewer-claude flagged the latent maintenance trap (and the matching latent gap in
 * `bundled-assets.ts` reading codex agent body raw without substitute). Centralising into one
 * module removes the trap, makes adding a 6th caller trivial, and aligns with §提示词资产维护
 * 约束 1「同款规则只在一处其他位置引用」.
 *
 * **The 5 callers and why their cache strategies are deliberately different** (closes R3
 * reviewer-claude MED follow-up "cache pattern asymmetry"):
 *
 * 1. `adapters/claude-code/sdk-injection.ts:getAgentDeckSystemPromptAppend`
 *    — **substitute-then-cache (in-memory)**.
 *    Why: every claude SDK spawn injects the same system prompt append, so caching the
 *    substituted result avoids redundant disk read + substitute. Invalidated on user copy
 *    save / settings toggle. Per-process state, no cross-process leak.
 *
 * 2. `adapters/claude-code/sdk-injection.ts:ensurePluginMirrorInstalled`
 *    — **substitute-on-install (filesystem mirror at `<userData>/agent-deck-plugin/`)**.
 *    Why: claude SDK directly scans plugin root via `plugins[].path` — there is no runtime
 *    injection hook; the SDK reads SKILL.md / agent body files itself. So we materialise a
 *    substituted copy at startup. Module flag avoids re-install per spawn.
 *
 * 3. `codex-config/agents-md-installer.ts:syncAgentDeckSection`
 *    — **substitute-on-write (filesystem write to `~/.codex/AGENTS.md`)**.
 *    Why: codex CLI reads `~/.codex/AGENTS.md` as a static file; there is no in-process
 *    substitution opportunity for codex SDK runtime. The substituted text must already be
 *    on disk by the time codex spawns. Cache uses raw with placeholder (the file is small,
 *    re-substitute on every sync is cheap and avoids dev/prod cache poisoning).
 *
 * 4. `codex-config/skills-installer.ts:syncSkills`
 *    — **substitute-on-write (filesystem write to `~/.codex/skills/agent-deck/<X>/SKILL.md`)**.
 *    Why: same as 3 — codex CLI scans the skills dir as static files. Note this is NOT a
 *    directory mirror like 2: skills-installer iterates each skill subdir individually
 *    (preserves user-managed `~/.codex/skills/` siblings). So the "abstract `mirrorAndSubstituteDir`
 *    helper" suggested in R3 INFO-1 has only one consumer (caller 2) and was deferred — abstracting
 *    a single-use helper violates §提示词资产维护 约束 2「不写预测未来用例代码」.
 *
 * 5. `bundled-assets.ts:getBundledAssetContent`
 *    — **substitute-on-read (no cache)**.
 *    Why: defense-in-depth wrap at the read boundary. Adapter-agnostic — claude side is
 *    already a substituted mirror (caller 2's output), so substitute is a no-op via the
 *    `text.includes` guard. Codex side reads source raw, so substitute catches any future
 *    placeholder added to `resources/codex-config/agent-deck-plugin/agents/*.md` (currently
 *    0 placeholders, this is latent gap protection — see R3 reviewer-claude MED-1).
 *
 * **Why the 5 strategies should NOT be unified**: each strategy is the natural fit for that
 * caller's surrounding mechanism (in-memory cache for repeated SDK injection / disk mirror
 * for SDK direct-scan / static-file write for codex / read-time wrap for defense). Unifying
 * them would force unnatural caching (e.g. caching disk mirror output in-memory adds nothing
 * because SDK reads disk anyway, but adds an invalidation footgun). Keep substitute logic
 * shared via this module; let each caller's caching layer stay bespoke.
 *
 * **Resolved values**:
 * - dev (`!app.isPackaged`):  `<app.getAppPath()>/resources`
 * - prod (`app.isPackaged`):  `process.resourcesPath` (= `Contents/Resources/`)
 *
 * `package.json` extraResources flattens `resources/SOPs → SOPs` and `resources/templates →
 * templates`, so the placeholder must resolve to **resources root** (not `resources/` subdir).
 * Both dev and prod resolve to a directory containing `SOPs/` and `templates/` subdirectories.
 *
 * **Safety**: `substituteResourcesPlaceholder` is idempotent for already-substituted strings —
 * the `text.includes` check returns the input unchanged when no placeholder remains. Calling
 * this on text that has already been substituted (e.g. claude side feeding through
 * `bundled-assets.ts` after `ensurePluginMirrorInstalled` already substituted it) is safe.
 *
 * **Typo detection** (post-R3 follow-up of LOW finding): scans for any literal that matches
 * `{{AGENT_DECK_<UPPERCASE_UNDERSCORES>}}` but is NOT the canonical `RESOURCES_PLACEHOLDER`,
 * and emits a single console.warn naming the offenders. Catches dev-time typos like
 * `{{AGENT_DECK_RES}}` / `{{AGENT_DECK_RESOURCE}}` (singular) before they reach an agent and
 * silently ENOENT at runtime. Currently 0 hits in checked-in assets; warning is dev-time
 * defensive only and never throws.
 */
import { app } from 'electron';
import { join } from 'node:path';
import log from '@main/utils/logger';

const logger = log.scope('utils-resources-placeholder');

export const RESOURCES_PLACEHOLDER = '{{AGENT_DECK_RESOURCES}}';

/**
 * Matches any `{{AGENT_DECK_<UPPERCASE_UNDERSCORES>}}` literal — used to detect typos like
 * `{{AGENT_DECK_RES}}` / `{{AGENT_DECK_RESOURCE}}` (singular) in caller text. Compared against
 * the canonical `RESOURCES_PLACEHOLDER` set; non-matching hits are warned to console, never thrown.
 *
 * Note: `{{ AGENT_DECK_RESOURCES }}` with surrounding spaces is intentionally NOT matched here
 * because the regex is strict-bracket; such a typo would also fail to substitute and appear in
 * the eventual ENOENT, but the warning won't fire. We keep the regex strict to avoid false
 * positives on unrelated `{{ ... }}` Mustache-like syntax authors might add elsewhere.
 */
const TYPO_DETECTOR = /\{\{AGENT_DECK_[A-Z_]*\}\}/g;
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set([RESOURCES_PLACEHOLDER]);

/** Returns absolute path to bundled resources root. dev/prod auto-dispatch. */
export function resolveAgentDeckResourcesRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return join(app.getAppPath(), 'resources');
}

/**
 * Replace every `{{AGENT_DECK_RESOURCES}}` occurrence in `text` with the absolute path returned
 * by `resolveAgentDeckResourcesRoot`. Returns the input unchanged if no placeholder is found
 * (idempotent + cheap fast-path).
 *
 * Also scans `text` for typo placeholders (`{{AGENT_DECK_*}}` not in `KNOWN_PLACEHOLDERS`) and
 * console.warns once per call listing the offenders. This is dev-time defence; production
 * checked-in assets have 0 typos. Warning never throws — caller flow is unaffected.
 */
export function substituteResourcesPlaceholder(text: string): string {
  warnOnUnknownPlaceholders(text);
  if (!text.includes(RESOURCES_PLACEHOLDER)) return text;
  return text.split(RESOURCES_PLACEHOLDER).join(resolveAgentDeckResourcesRoot());
}

function warnOnUnknownPlaceholders(text: string): void {
  const matches = text.match(TYPO_DETECTOR);
  if (!matches) return;
  const unknown = [...new Set(matches)].filter((m) => !KNOWN_PLACEHOLDERS.has(m));
  if (unknown.length === 0) return;
  logger.warn(
    `[resources-placeholder] unknown placeholder(s) detected (won't be substituted, likely typo): ${unknown.join(', ')}. ` +
      `Known placeholder: ${RESOURCES_PLACEHOLDER}.`,
  );
}
