/**
 * 历史搜索关键词谓词构造（CHANGELOG_22 / Phase 4 N5）
 *
 * 历史方案：`payload_json LIKE '%kw%'` + EXISTS LIMIT 1 短路（详见 session-repo.ts 注释）。
 * 当前方案：≥ 3 字符走 FTS5 + trigram MATCH（legacy events_fts、bounded
 * event_search_fts_v1、summaries_fts），保留 title / cwd LIKE；四类字段统一为 ASCII
 * 大小写不敏感。cwd 直接查 sessions，避免把
 * 每条 event 都重复索引一份目录。新索引回填期间 UNION 保持旧索引完整覆盖；跨重启验证并在
 * 无写入的关机阶段退休旧索引后，长工具输出只保留首尾各 2,048 字符用于搜索。
 *
 * 拆出本函数主因是单测：vitest 在 node 环境跑，better-sqlite3 binding 由 electron 重编无法
 * 直接跑真 SQL，但纯函数（escape / SQL fragment 拼接）可单测，FTS 真行为靠手测脚本验收。
 */
import type { Database } from 'better-sqlite3';

/**
 * 把任意关键词转成 FTS5 phrase 查询字面量（包双引号、内部 `"` 转 `""`）。
 *
 * trigram tokenizer 下 phrase 查询等价于 substring：搜 "foo bar" 命中含 `foo`/`oo `/`o b`/...
 * 连续 trigram 的文档。把整个 keyword 当一个 phrase 是「直觉行为最贴近 LIKE %kw%」的写法，
 * 也避免用户输入里的 AND/OR/NEAR/* 被 FTS5 当查询语法误解。
 */
export function escapeFtsPhrase(keyword: string): string {
  return `"${keyword.replaceAll('"', '""')}"`;
}

export interface KeywordPredicate {
  /** 拼到 listHistory 的 WHERE 子句末尾的 SQL fragment（已套外层括号） */
  sql: string;
  /** 注入到 prepare().all(params) 的参数（命名参数） */
  params: Record<string, string>;
}

export interface KeywordPredicateOptions {
  /** Keep the raw-payload rollback index in the query until shutdown retirement is durable. */
  includeLegacyEventIndex?: boolean;
}

/**
 * 构造关键词谓词。约束：
 * - keyword 为空 / 全空白 → 调用方应跳过（这里不 enforce，传进来会回 LIKE-only 形态）
 * - 长度 < 3：trigram 索引 3-gram 不可用，只搜 title / cwd LIKE
 * - 长度 ≥ 3：title / cwd LIKE OR event FTS MATCH OR summaries_fts MATCH；v43 tokenizer
 *   使用 `trigram case_sensitive 0`，与 SQLite LIKE 的 ASCII 大小写语义一致
 *
 * SQL 形态（Phase 4 N5 review 修订，REVIEW_X #1 + #2）：
 *
 * 1. **MATCH 左侧必须用虚表名而不是 alias**：SQLite 会把 `alias MATCH ...` 里的 alias
 *    当成普通列名解析报错（验证：`SELECT 1 FROM events_fts fts WHERE fts MATCH 'x'`
 *    抛 "no such column: fts"）。所以这里写 `events_fts MATCH @kw_fts` 而不是
 *    `fts MATCH @kw_fts`。
 *
 * 2. **走 IN (SELECT DISTINCT) 而不是 EXISTS + 相关子查询**：FTS 工作负载下 EXISTS 会让
 *    query planner 把外层 sessions 做 SCAN + 每行重跑一次 FTS（CORRELATED SCALAR
 *    SUBQUERY）；IN + DISTINCT 让 planner 一次物化 FTS 命中的 session_id 集合，再
 *    SEARCH sessions USING PRIMARY KEY，selective 关键词下快 5-200×（review 实测）。
 *    FTS 命中集天然小（关键词命中事件数 << session×events），物化代价远低于重扫。
 *
 * 3. **同一关键词复用 @kw_fts 参数**：better-sqlite3 命名参数允许同一参数在 SQL 里多次
 *    出现，绑定一次即可，避免 prepare 缓存碎片化。
 *
 * 4. **title / cwd LIKE 必须 escape `% _ \` + 配 `ESCAPE '\'`**（REVIEW_91）：与同
 *    listHistory query 的独立 cwd / task subject filter 同款，避免用户输入里的 `_` `%`
 *    被当 LIKE 通配符。
 *
 * @param keyword 用户搜索关键词（trim 由调用方做）
 * @returns 拼接 SQL + 参数
 */
export function buildKeywordPredicate(
  keyword: string,
  options: KeywordPredicateOptions = {},
): KeywordPredicate {
  // title / cwd LIKE 的 `\` `%` `_` 三个 wildcard 字符做 escape + 配 `ESCAPE '\'`（REVIEW_91
  // 双 reviewer 独立共识）。与同一 listHistory query 的 cwd（core-crud.ts REVIEW_88）/
  // task subject（task-repo-list.ts REVIEW_61）同款修法对齐 —— 此前 title 漏修，用户搜含
  // `_` 的标题（如 `my_project`）时 `_` 被当单字符通配匹配 `myXproject`。非注入（命名参数
  // 挡），是搜索语义错误。FTS phrase 那侧走 escapeFtsPhrase 不受影响。
  const likeEscaped = keyword
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const params: Record<string, string> = {
    kw_like: `%${likeEscaped}%`,
  };

  if (keyword.length < 3) {
    return {
      sql: `(title LIKE @kw_like ESCAPE '\\' OR cwd LIKE @kw_like ESCAPE '\\')`,
      params,
    };
  }

  params.kw_fts = escapeFtsPhrase(keyword);
  const eventSessionSelect = options.includeLegacyEventIndex !== false
    ? `SELECT DISTINCT e.session_id
          FROM (
            SELECT rowid FROM events_fts
             WHERE events_fts MATCH @kw_fts
            UNION
            SELECT rowid FROM event_search_fts_v1
             WHERE event_search_fts_v1 MATCH @kw_fts
          ) event_matches
          JOIN events e ON e.id = event_matches.rowid`
    : `SELECT DISTINCT e.session_id
          FROM event_search_fts_v1
          JOIN events e ON e.id = event_search_fts_v1.rowid
         WHERE event_search_fts_v1 MATCH @kw_fts`;

  return {
    sql: `(title LIKE @kw_like ESCAPE '\\'
      OR cwd LIKE @kw_like ESCAPE '\\'
      OR sessions.id IN (
        ${eventSessionSelect}
      )
      OR sessions.id IN (
        SELECT DISTINCT su.session_id FROM summaries_fts
         JOIN summaries su ON su.id = summaries_fts.rowid
        WHERE summaries_fts MATCH @kw_fts
      ))`,
    params,
  };
}

/** Keep the rollback FTS branch until its shutdown retirement has completed durably. */
export function shouldIncludeLegacyEventIndex(db: Database): boolean {
  const stateTableExists = db.prepare(
    `SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'storage_maintenance_state' LIMIT 1`,
  ).get();
  if (!stateTableExists) return true;
  const phase = db.prepare(
    `SELECT phase FROM storage_maintenance_state WHERE task = 'event-search-v1'`,
  ).pluck().get();
  return phase !== 'complete';
}
