/**
 * **shared/** category: **policy**（跨进程业务规则 — 模型 id 归一 + 实时窗口常量）。
 *
 * plan model-token-stats-and-dashboard-20260602 §Phase 0 (M)。token 统计的「模型归一」单一
 * 真源（SSOT，§不变量 4）：main 端写库算 bucketKey + renderer 端显示 displayName 都 import
 * 本模块，禁止各处各写 model id 解析 regex。
 *
 * **为什么归一**：同一基础模型有多个变体后缀（`-thinking` / `-thinking-max` / `[1m]` /
 * reasoning 等级），用户语义上是「同一个模型」。token 统计按 bucketKey 聚合（Top3 / 每模型每天），
 * 把变体合并为一个 bucket + 稳定显示名（如 `opus-4.8`）。DB 同时存原始 model id（model_raw 列）
 * 保粒度，bucket 仅用于聚合维度。
 *
 * **shared/ 边界约定**（详 ipc-channels.ts 顶部）：本文件属 **policy**（model 归一规则；
 * 改动同步影响 main 写 bucket + renderer 显示名 + 聚合统计口径）。
 */

/**
 * 实时 token/s 滑动窗口时长（ms）。plan §不变量 6：单一 export，main 查询（ratesSince sinceMs
 * 计算）与 renderer 文案（"60秒"）共用，不做设置项（RFC 第2轮决策）。
 */
export const WINDOW_MS = 60_000;

/** 归一结果：bucketKey（聚合维度，GROUP BY 用）+ displayName（UI 显示）。 */
export interface NormalizedModel {
  /** 聚合 bucket key（稳定标识，写入 token_usage.model_bucket）。 */
  bucketKey: string;
  /** UI 显示名（renderer 渲染用，不入库——改文案无需迁移）。 */
  displayName: string;
}

/**
 * codex 未显式指定 model 的占位 bucket（session-finalize effective model 兜底值）。
 * plan §已知踩坑 1：交互式 codex 走 ~/.codex/config.toml 默认时，effective model resolve
 * 不到具体值 → 落此占位，UI 显示「Codex (默认模型)」让用户理解统计合并局限。
 */
export const CODEX_DEFAULT_BUCKET = 'codex-default';
/**
 * Claude 未显式指定 model 的占位 bucket（实时 tok/s / 极端 SDK usage 缺 model 兜底值）。
 * 与 Codex 默认模型占位对齐：避免 Claude-family session.model 为空时 UI 显示通用「未知模型」。
 */
export const CLAUDE_DEFAULT_BUCKET = 'claude-default';
/** 完全无 model 信息的兜底 bucket（理论极端：raw 为空且非 codex-default 占位）。 */
export const UNKNOWN_BUCKET = 'unknown';

/**
 * 把明确的尾部变体标记迭代剥掉，得到归一用的核心 model 串。
 *
 * 这些 token 只在 model id **尾部**被视为变体；出现在中间时可能属于未来或第三方
 * provider 的真实 slug，不能删除。例如 `gpt-5.6-thinking-preview` 必须保留完整身份，而
 * `gpt-5.6-sol-thinking-max[1m]` 应归到 `gpt-5.6-sol`。
 */
const VARIANT_SUFFIXES = [
  '[1m]',
  '-1m',
  '-thinking',
  '-minimal',
  '-medium',
  '-xhigh',
  '-ultra',
  '-high',
  '-low',
  '-max',
] as const;

function stripVariantSuffixes(raw: string): string {
  let s = raw
    .toLowerCase()
    .trim()
    .replace(/[-_\s]+$/g, '')
    .replace(/^[-_\s]+/g, '');
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of VARIANT_SUFFIXES) {
      if (!s.endsWith(suffix)) continue;
      s = s.slice(0, -suffix.length).replace(/[-_\s]+$/g, '');
      stripped = true;
      break;
    }
  }
  return s.replace(/^[-_\s]+/g, '');
}

/**
 * 把核心串解析成 `{family, version}`。
 * - claude：`claude-fable-5` → family=fable / version=5；`claude-opus-4-8` → opus/4.8
 * - 已归一 bucket：`opus-4.8` → opus/4.8
 * - claude alias（无版本号，来自 agent frontmatter）：`fable`/`opus`/`sonnet`/`haiku` → family/无 version
 * - gpt/codex：`gpt-5.5` → gpt/5.5
 * 返回 null = 未识别（走 fallback 原样）。
 */
function parseFamilyVersion(core: string): { family: string; version: string | null } | null {
  // Claude family/version 必须完整匹配。精确 8 位日期是 snapshot，不进入 bucket version；
  // 其他 suffix（preview / provider slug / custom id）返回 null，交给 fallback 保留完整身份。
  const claudeMatch =
    /^claude-(fable|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{8})|[.-](\d+)(?:-(\d{8}))?)?)?$/.exec(
      core,
    );
  if (claudeMatch) {
    const family = claudeMatch[1];
    const major = claudeMatch[2];
    const minor = claudeMatch[4];
    const version = major ? (minor ? `${major}.${minor}` : major) : null;
    return { family, version };
  }
  // 裸 alias：fable / opus / sonnet / haiku（agent frontmatter model 字段常见）
  const aliasMatch = /^(fable|opus|sonnet|haiku)$/.exec(core);
  if (aliasMatch) {
    return { family: aliasMatch[1], version: null };
  }
  const bucketMatch = /^(fable|opus|sonnet|haiku)-(\d+(?:\.\d+)?)$/.exec(core);
  if (bucketMatch) {
    return { family: bucketMatch[1], version: bucketMatch[2] };
  }
  // gpt-<major>-<minor> / gpt-<major>.<minor> / gpt-<major>
  const gptMatch = /^gpt-(\d+)(?:[.-](\d+))?$/.exec(core);
  if (gptMatch) {
    const major = gptMatch[1];
    const minor = gptMatch[2];
    const version = minor ? `${major}.${minor}` : major;
    return { family: 'gpt', version };
  }
  return null;
}

/**
 * 归一 model id → {bucketKey, displayName}。
 *
 * - null / 空串 → UNKNOWN_BUCKET（「未知模型」）
 * - CODEX_DEFAULT_BUCKET 占位 → 「Codex (默认模型)」
 * - 识别出 family+version → bucketKey/displayName 都用 `<family>-<version>`（如 `opus-4.8`）
 * - 识别出 family 无 version（alias）→ bucketKey/displayName 都用 family（如 `opus`）
 * - 未识别 → fallback：bucketKey=stripped core（小写归一保聚合稳定），displayName=原始 raw（保粒度可读）
 */
export function normalizeModel(raw: string | null | undefined): NormalizedModel {
  if (raw == null || raw.trim() === '') {
    return { bucketKey: UNKNOWN_BUCKET, displayName: '未知模型' };
  }
  const trimmed = raw.trim();
  if (trimmed === CODEX_DEFAULT_BUCKET) {
    return { bucketKey: CODEX_DEFAULT_BUCKET, displayName: 'Codex (默认模型)' };
  }
  if (trimmed === CLAUDE_DEFAULT_BUCKET) {
    return { bucketKey: CLAUDE_DEFAULT_BUCKET, displayName: 'Claude (默认模型)' };
  }
  const core = stripVariantSuffixes(trimmed);
  const parsed = parseFamilyVersion(core);
  if (parsed) {
    if (parsed.version) {
      const bucketKey = `${parsed.family}-${parsed.version}`;
      return {
        bucketKey,
        displayName: bucketKey,
      };
    }
    return { bucketKey: parsed.family, displayName: parsed.family };
  }
  // fallback：未识别的 model（新模型 / 第三方）。bucketKey 用 stripped core 保聚合稳定
  // （同 model 不同变体仍合并），displayName 保原始 raw 让用户能认出。
  return { bucketKey: core || UNKNOWN_BUCKET, displayName: trimmed };
}
