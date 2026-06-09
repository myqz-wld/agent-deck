/**
 * **shared/** category: **policy**（跨进程业务规则 — 模型 id 归一 + 实时窗口常量）。
 *
 * plan model-token-stats-and-dashboard-20260602 §Phase 0 (M)。token 统计的「模型归一」单一
 * 真源（SSOT，§不变量 4）：main 端写库算 bucketKey + renderer 端显示 displayName 都 import
 * 本模块，禁止各处各写 model id 解析 regex。
 *
 * **为什么归一**：同一基础模型有多个变体后缀（`-thinking` / `-thinking-max` / `[1m]` /
 * reasoning 等级），用户语义上是「同一个模型」。token 统计按 bucketKey 聚合（Top3 / 每模型每天），
 * 把变体合并为一个 bucket + 友好显示名（如 `Opus 4.8`）。DB 同时存原始 model id（model_raw 列）
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

/** 归一结果：bucketKey（聚合维度，GROUP BY 用）+ displayName（UI 友好显示）。 */
export interface NormalizedModel {
  /** 聚合 bucket key（稳定标识，写入 token_usage.model_bucket）。 */
  bucketKey: string;
  /** UI 友好显示名（renderer 渲染用，不入库——改文案无需迁移）。 */
  displayName: string;
}

/**
 * codex 未显式指定 model 的占位 bucket（session-finalize effective model 兜底值）。
 * plan §已知踩坑 1：交互式 codex 走 ~/.codex/config.toml 默认时，effective model resolve
 * 不到具体值 → 落此占位，UI 显示「Codex (默认模型)」让用户理解统计合并局限。
 */
export const CODEX_DEFAULT_BUCKET = 'codex-default';
/** 完全无 model 信息的兜底 bucket（理论极端：raw 为空且非 codex-default 占位）。 */
export const UNKNOWN_BUCKET = 'unknown';

/**
 * 把变体后缀剥掉，得到归一用的核心 model 串。
 * 处理：lowercase → 去 `[1m]` / `-1m` 长上下文标记 → 去 `-thinking-max` / `-thinking` /
 * `-max` 推理后缀 → 去尾部 reasoning 等级（`-high` / `-xhigh` / `-low` / `-medium` / `-minimal`）→
 * 去首尾多余 `-`。
 */
function stripVariantSuffixes(raw: string): string {
  let s = raw.toLowerCase().trim();
  // [1m] / -1m 长上下文窗口标记（claude-opus-4-8-thinking-max[1m]）
  s = s.replace(/\[1m\]/g, '').replace(/-1m\b/g, '');
  // 推理后缀（顺序：长的先去，避免 -thinking-max 只去掉 -max 残留 -thinking）
  s = s.replace(/-thinking-max/g, '').replace(/-thinking/g, '').replace(/-max\b/g, '');
  // reasoning 等级后缀
  s = s.replace(/-(x?high|low|medium|minimal)\b/g, '');
  // 收尾多余分隔符
  s = s.replace(/[-_\s]+$/g, '').replace(/^[-_\s]+/g, '');
  return s;
}

/**
 * 把核心串解析成 `{family, version}`。
 * - claude：`claude-opus-4-8` → family=opus / version=4.8；`claude-sonnet-4-5` → sonnet/4.5
 * - claude alias（无版本号，来自 agent frontmatter）：`opus`/`sonnet`/`haiku` → family/无 version
 * - gpt/codex：`gpt-5.5` → gpt/5.5
 * 返回 null = 未识别（走 fallback 原样）。
 */
function parseFamilyVersion(core: string): { family: string; version: string | null } | null {
  // claude-<family>-<major>-<minor> 或 claude-<family>-<major>
  const claudeMatch = /^claude-(opus|sonnet|haiku)(?:-(\d+)(?:-(\d+))?)?/.exec(core);
  if (claudeMatch) {
    const family = claudeMatch[1];
    const major = claudeMatch[2];
    const minor = claudeMatch[3];
    const version = major ? (minor ? `${major}.${minor}` : major) : null;
    return { family, version };
  }
  // 裸 alias：opus / sonnet / haiku（agent frontmatter model 字段常见）
  const aliasMatch = /^(opus|sonnet|haiku)$/.exec(core);
  if (aliasMatch) {
    return { family: aliasMatch[1], version: null };
  }
  // gpt-<major>-<minor> / gpt-<major>.<minor> / gpt-<major>
  const gptMatch = /^gpt-(\d+)(?:[.-](\d+))?/.exec(core);
  if (gptMatch) {
    const major = gptMatch[1];
    const minor = gptMatch[2];
    const version = minor ? `${major}.${minor}` : major;
    return { family: 'gpt', version };
  }
  return null;
}

const FAMILY_DISPLAY: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/**
 * 归一 model id → {bucketKey, displayName}。
 *
 * - null / 空串 → UNKNOWN_BUCKET（「未知模型」）
 * - CODEX_DEFAULT_BUCKET 占位 → 「Codex (默认模型)」
 * - 识别出 family+version → bucketKey=`<family>-<version>`（如 `opus-4.8`），displayName=`Opus 4.8`
 *  ；gpt family 保持 bucket 风格显示（`gpt-5.5`），与 Codex / 第三方模型 id 对齐。
 * - 识别出 family 无 version（alias）→ bucketKey=family，displayName=`Opus`
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
  const core = stripVariantSuffixes(trimmed);
  const parsed = parseFamilyVersion(core);
  if (parsed) {
    const familyDisplay = FAMILY_DISPLAY[parsed.family] ?? parsed.family;
    if (parsed.version) {
      if (parsed.family === 'gpt') {
        return {
          bucketKey: `${parsed.family}-${parsed.version}`,
          displayName: `${parsed.family}-${parsed.version}`,
        };
      }
      return {
        bucketKey: `${parsed.family}-${parsed.version}`,
        displayName: `${familyDisplay} ${parsed.version}`,
      };
    }
    return { bucketKey: parsed.family, displayName: familyDisplay };
  }
  // fallback：未识别的 model（新模型 / 第三方）。bucketKey 用 stripped core 保聚合稳定
  // （同 model 不同变体仍合并），displayName 保原始 raw 让用户能认出。
  return { bucketKey: core || UNKNOWN_BUCKET, displayName: trimmed };
}
