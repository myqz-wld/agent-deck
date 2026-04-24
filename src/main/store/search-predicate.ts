/**
 * 历史搜索关键词谓词构造（CHANGELOG_22 / Phase 4 N5）
 *
 * 历史方案：`payload_json LIKE '%kw%'` + EXISTS LIMIT 1 短路（详见 session-repo.ts 注释）。
 * 当前方案：≥ 3 字符走 FTS5 + trigram MATCH（events_fts / summaries_fts），保留 title LIKE
 * 兼顾「session 标题命中但 events 已被 N1 截断的极端情况」。
 *
 * 拆出本函数主因是单测：vitest 在 node 环境跑，better-sqlite3 binding 由 electron 重编无法
 * 直接跑真 SQL，但纯函数（escape / SQL fragment 拼接）可单测，FTS 真行为靠手测脚本验收。
 */

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

/**
 * 构造关键词谓词。约束：
 * - keyword 为空 / 全空白 → 调用方应跳过（这里不 enforce，传进来会回 LIKE-only 形态）
 * - 长度 < 3：trigram 索引 3-gram 不可用，只搜 title LIKE
 * - 长度 ≥ 3：title LIKE OR events_fts MATCH OR summaries_fts MATCH
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
 * @param keyword 用户搜索关键词（trim 由调用方做）
 * @returns 拼接 SQL + 参数
 */
export function buildKeywordPredicate(keyword: string): KeywordPredicate {
  const params: Record<string, string> = {
    kw_like: `%${keyword}%`,
  };

  if (keyword.length < 3) {
    return {
      sql: `title LIKE @kw_like`,
      params,
    };
  }

  params.kw_fts = escapeFtsPhrase(keyword);

  return {
    sql: `(title LIKE @kw_like
      OR sessions.id IN (
        SELECT DISTINCT e.session_id FROM events_fts
         JOIN events e ON e.id = events_fts.rowid
        WHERE events_fts MATCH @kw_fts
      )
      OR sessions.id IN (
        SELECT DISTINCT su.session_id FROM summaries_fts
         JOIN summaries su ON su.id = summaries_fts.rowid
        WHERE summaries_fts MATCH @kw_fts
      ))`,
    params,
  };
}
