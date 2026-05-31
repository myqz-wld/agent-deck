/**
 * CHANGELOG_107 Step 2: jsonl missing / cwdFellBack fallback 路径起 fresh CLI 之前
 * 生成历史摘要,prepend 到 user prompt 前作为 fresh CLI 首条 prompt 的一部分。
 *
 * 让用户体感「Claude 还能续聊」(而不是 CHANGELOG_106 兜底「请下条消息把背景告诉它一次」
 * 的手动补背景)。
 *
 * **触发场景**(Step 3/4 接入 recoverer 主路径后):
 * - cwdFellBack=true(`recoverer.ts` cwd 失效启发式 fallback 路径)
 * - jsonl missing(同路径,CLI resume 用的 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl 不在)
 *
 * 两条路径都会起一个**全新** CLI session(不带 --resume),Claude 看不到任何历史 →
 * 用户在 SessionDetail 看到完整对话历史 + Claude 答非所问 = CHANGELOG_106 修的 UX bug。
 * 本 helper 在 fresh CLI 起来**之前**用应用层 DB 的 events 表自动生成接力简报 prepend
 * 到首条 prompt 前,让 Claude 知道前情。
 *
 * **不变量**(plan §设计决策 4 / §不变量):
 * - settings 关 / DB 没历史 / 摘要为空 / 超长 / thunk throw → 退回 originalText 原样,
 *   **永不阻塞** fallback 主路径(无论失败原因都返 `{ used: false, failReason }` 让 caller
 *   决定怎么补 emit)
 * - 不持久化摘要(每次 fallback 重算;典型 fallback 路径低频,LLM 成本可接受)
 * - 本 helper **不直接 emit** AgentEvent — 让 caller 看 failReason 决定 emit 哪条文案
 *   (避免「摘要成功 → 不 emit 丢失警告」「摘要失败 → emit CHANGELOG_106 文案」分支
 *   被硬编码在 helper 里破坏分层)
 *
 * **形态**:module-level pure function,**不依赖** recoverer class state — 让单测不需要
 * 起 facade / TestBridge,纯函数 input/output 验证(Step 6 加单测)。
 *
 * **events 来源**(plan §下一会话第一步 events 来源决策):caller 传 `listEventsFn` thunk,
 * caller 自己 bind `eventRepo.listForSession(sid)`(默认 limit=200,DESC 排序;
 * `formatEventsForPrompt` 内部已自己 sort ASC + slice(-30) 取最新一段,本 helper 不处理排序)。
 */

import type { AgentEvent } from '@shared/types';
import { MAX_MESSAGE_LENGTH } from './constants';
import type { SummariseFnThunk } from './recoverer';

/**
 * `prependHistorySummary` 入参(options object 风格便于扩展 + 单测可读)。
 */
export interface PrependHistorySummaryOptions {
  /**
   * 拉哪个 session 的事件历史(应用层 DB events 表)。注意是 OLD_ID(fallback 前的
   * session id),不是 fresh CLI 的 newRealId — fresh CLI 还没起,events 表里也没新 id 的事件。
   */
  sessionId: string;
  /** 用户当前要发的消息(原文,不带任何 prefix)。 */
  originalText: string;
  /**
   * session cwd(传给 LLM 摘要 prompt 用,与 `summariseSessionForHandOff(cwd, events)`
   * 签名对齐;cwd 主要用于 prompt 里展示「会话 cwd」字段,不影响 LLM 调用本身)。
   *
   * cwdFellBack=true 时这里**应**传原 `rec.cwd`(让摘要保留「原本是哪个 worktree」的语义),
   * 不传 fallback cwd(fallback cwd 是新选的逃生路径,与历史活动无关)。caller 决定。
   */
  cwd: string;
  /**
   * Step 5 settings 接通后这里穿透传入 `settings.autoSummariseOnFallback`;
   * Step 2/3/4 时 caller 暂传 default `true` 占位,Step 5 把硬编码换成真正读 settings。
   */
  autoSummariseOnFallback: boolean;
  /**
   * test seam 注入的 LLM 摘要 thunk(facade 层 bind `summariseSessionForHandOff`,
   * Step 1 已在 recoverer ctor / facade 层接通)。失败语义参见 `SummariseFnThunk` jsdoc。
   */
  summariseFn: SummariseFnThunk;
  /**
   * events 来源 thunk(test seam)。caller 默认 bind `eventRepo.listForSession`;
   * 单测可注入 mock 数组让纯函数行为可控。
   */
  listEventsFn: (sessionId: string) => AgentEvent[];
}

/**
 * 5 种 fallback 原因(used === false 时一定有值)。caller 看这个分支决定 emit 哪条文案:
 * - `settings-off` → caller 静默走原 fallback 路径(用户主动关了不打扰)
 * - `no-events` → caller 静默(没历史可摘要,本来 fresh CLI 也续不上,与原 fallback 等价)
 * - `summary-empty` → caller emit CHANGELOG_106「请补背景」(events 给了但 LLM 拿不出有效内容,
 *   等价于摘要失败)
 * - `over-length` → caller emit CHANGELOG_106「请补背景」(摘要太长无法 prepend,等价失败)
 * - `thunk-throw` → caller emit CHANGELOG_106「请补背景」(events 来源 thunk `listEventsFn`
 *   或 LLM 摘要 thunk `summariseFn` 任一抛错,与原 fallback 路径一致 — REVIEW_76 把
 *   listEventsFn 也纳入此 failReason 保「永不抛错」契约)
 */
export type PrependFailReason =
  | 'settings-off'
  | 'no-events'
  | 'summary-empty'
  | 'over-length'
  | 'thunk-throw';

/**
 * helper 返回结构:
 * - 成功 = `{ prompt: prepended, used: true }`
 * - 失败 = `{ prompt: originalText, used: false, failReason, thrown? }`
 *   (`thrown` 仅 `failReason === 'thunk-throw'` 时有,caller 决定是否 console.warn / 上报)
 */
export interface PrependResult {
  /** 最终 prompt 字符串 — caller 直接用作 createThunk 的 prompt 参数。 */
  prompt: string;
  /** true = 摘要成功 prepend;false = 走 fallback 退回 originalText 原样。 */
  used: boolean;
  /** 仅 used === false 时有值。 */
  failReason?: PrependFailReason;
  /** 仅 failReason === 'thunk-throw' 时有值,thunk 抛的真错(已包成 Error)。 */
  thrown?: Error;
}

/**
 * 拼接格式(plan §设计决策 3):双段五等号块明确区分,让 Claude 区分「历史」vs「当前 task」。
 *
 * 五等号块设计动机:避免 LLM 把摘要里的祈使句(典型如「请下一步...」)误解为用户当前
 * 指令的一部分。明确分段后 Claude 看到「===== 历史会话摘要 =====」就知道这一段是
 * 旁白上下文,「===== 用户当前消息 =====」之后才是实际 task。
 */
function buildPrepended(summary: string, originalText: string): string {
  return (
    `===== 历史会话摘要(由应用 DB 历史自动生成,因为 CLI 内部 jsonl 已丢失)=====\n` +
    summary.trim() +
    `\n\n===== 用户当前消息 =====\n` +
    originalText
  );
}

/**
 * 在 fallback 路径起 fresh CLI 之前,尝试用应用层 DB 历史生成摘要 prepend 到 user prompt 前。
 *
 * 算法:
 * 1. settings 关 → return originalText + `settings-off`
 * 2. listEventsFn 拉 events 空 → return originalText + `no-events`
 * 3. summariseFn 调用,throw → return originalText + `thunk-throw` + thrown
 * 4. 摘要 null / 空 → return originalText + `summary-empty`
 * 5. 拼接 prepended,长度 > MAX_MESSAGE_LENGTH → return originalText + `over-length`
 * 6. 一切 OK → return prepended + `used: true`
 *
 * **永不抛错**(plan §不变量):任何失败都封装在 PrependResult 里返,让 caller 主路径
 * 任何情况下都能 fall back to originalText 启动 fresh CLI 不阻塞。
 */
export async function prependHistorySummary(
  opts: PrependHistorySummaryOptions,
): Promise<PrependResult> {
  const {
    sessionId,
    originalText,
    cwd,
    autoSummariseOnFallback,
    summariseFn,
    listEventsFn,
  } = opts;

  // 1. settings 关 → skip(用户主动关了不打扰)
  if (!autoSummariseOnFallback) {
    return { prompt: originalText, used: false, failReason: 'settings-off' };
  }

  // 2. events 空(从未有过 turn / 已被 historyRetentionDays 清理)→ skip
  //    没历史可摘要,本来 fresh CLI 也续不上,与原 fallback 等价。
  //
  // **REVIEW_76 MED (reviewer-codex + lead 代码链实测)**: listEventsFn 调用纳入 try/catch。
  // 修前 listEventsFn(sessionId) 在 try 外(只有 summariseFn 在 try 内),违反本函数 jsdoc +
  // §不变量「永不抛错,任何失败封装为 PrependResult 让 caller fall back to originalText」承诺。
  // 触发:生产 thunk = eventRepo.listForSession(index.ts:286-287),其内部 rows.map(rowToEvent)
  // 走 JSON.parse(r.payload_json)(event-repo.ts:21) — 历史 row payload_json 损坏 / DB 读错时
  // 同步抛错 → 穿透 prependHistorySummary → maybeJsonlFallback 在 createSession 之前中断 →
  // recoverer 只 emit「⚠ 自动恢复失败」**不进 fresh CLI reuse-app fallback**(用户体感本该能续聊
  // 的会话彻底起不来)。修法:listEventsFn 纳入 try/catch,复用 thunk-throw failReason(caller
  // 已处理:emit CHANGELOG_106「请补背景」+ 继续 fresh CLI fallback 用 originalText),确保
  // 「永不抛错」契约完整覆盖 events 来源 thunk(与 summariseFn 同款保护)。
  let events: AgentEvent[];
  try {
    events = listEventsFn(sessionId);
  } catch (err) {
    return {
      prompt: originalText,
      used: false,
      failReason: 'thunk-throw',
      thrown: err instanceof Error ? err : new Error(String(err)),
    };
  }
  if (!events || events.length === 0) {
    return { prompt: originalText, used: false, failReason: 'no-events' };
  }

  // 3. thunk 调用(LLM 真路径 / test mock)。任何 throw 都封装,不传播。
  let summary: string | null;
  try {
    summary = await summariseFn(cwd, events);
  } catch (err) {
    return {
      prompt: originalText,
      used: false,
      failReason: 'thunk-throw',
      thrown: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // 4. summary 空(典型场景:events 全 tool-use 没文本可总结 / formatEventsForPrompt 返空 →
  //    summariseSessionForHandOff 早 return null)→ skip。
  if (!summary || summary.trim().length === 0) {
    return { prompt: originalText, used: false, failReason: 'summary-empty' };
  }

  // 5. 拼接 + 长度校验。MAX_MESSAGE_LENGTH 与 send-validation 全局上限对齐(102_400 chars),
  //    超过会被 sendMessage 路径 reject,不能因摘要让 fresh CLI 首条 prompt 拒队。
  //    实测:summariseSessionForHandOff 限 4000 char + 五等号块 wrapper ~100 char +
  //    originalText 通常 <1000 char ≪ 102_400,over-length 是边角兜底防 originalText 已接近上限。
  const prepended = buildPrepended(summary, originalText);
  if (prepended.length > MAX_MESSAGE_LENGTH) {
    return { prompt: originalText, used: false, failReason: 'over-length' };
  }

  return { prompt: prepended, used: true };
}
