/**
 * buildKeywordPredicate 单测（CHANGELOG_22 / Phase 4 N5）
 *
 * 只覆盖纯函数行为：长度门槛、SQL fragment 内容、参数命名、FTS phrase 转义。
 * FTS5 真实索引行为由手测脚本验证（vitest 跑在 node 环境，better-sqlite3 binding 是
 * electron 重编的，跑不了真 SQL）。
 */
import { describe, expect, it } from 'vitest';
import { buildKeywordPredicate, escapeFtsPhrase } from './search-predicate';

describe('escapeFtsPhrase', () => {
  it('普通词包成 phrase 双引号字面量', () => {
    expect(escapeFtsPhrase('foo')).toBe('"foo"');
    expect(escapeFtsPhrase('foo bar')).toBe('"foo bar"');
  });

  it('内部 " 转义为 ""（FTS5 phrase 标准 escape）', () => {
    expect(escapeFtsPhrase('say "hi"')).toBe('"say ""hi"""');
    expect(escapeFtsPhrase('"')).toBe('""""');
  });

  it('FTS5 保留字（AND/OR/NOT/NEAR/*）当字面量处理而非语法', () => {
    // 包在 phrase 双引号内 → FTS5 当字面量；不会被当成布尔操作符
    expect(escapeFtsPhrase('foo AND bar')).toBe('"foo AND bar"');
    expect(escapeFtsPhrase('a*b')).toBe('"a*b"');
  });

  it('中英文混合保持原样（trigram tokenizer 按 codepoint 切，不需要预处理）', () => {
    expect(escapeFtsPhrase('搜索foo')).toBe('"搜索foo"');
    expect(escapeFtsPhrase('错误：找不到')).toBe('"错误：找不到"');
  });
});

describe('buildKeywordPredicate', () => {
  it('< 3 字符走 title LIKE only（trigram 索引不覆盖 < 3 gram）', () => {
    const result = buildKeywordPredicate('ab');
    expect(result.sql).toBe('title LIKE @kw_like');
    expect(result.params.kw_like).toBe('%ab%');
    expect(result.params.kw_fts).toBeUndefined();
  });

  it('单字符也走 title LIKE only', () => {
    const result = buildKeywordPredicate('x');
    expect(result.sql).toBe('title LIKE @kw_like');
    expect(result.params.kw_fts).toBeUndefined();
  });

  it('= 3 字符触发 FTS：events_fts + summaries_fts MATCH', () => {
    const result = buildKeywordPredicate('foo');
    expect(result.sql).toContain('title LIKE @kw_like');
    expect(result.sql).toContain('events_fts');
    expect(result.sql).toContain('summaries_fts');
    // MATCH 左侧必须是表名而不是 alias（SQLite 把 alias MATCH 解析成列名报错，N5 #1）
    expect(result.sql).toContain('events_fts MATCH @kw_fts');
    expect(result.sql).toContain('summaries_fts MATCH @kw_fts');
    expect(result.sql).not.toMatch(/\bfts MATCH\b/);
    expect(result.params.kw_like).toBe('%foo%');
    expect(result.params.kw_fts).toBe('"foo"');
  });

  it('FTS 子查询走 IN + SELECT DISTINCT（不是 EXISTS + 相关子查询）', () => {
    const result = buildKeywordPredicate('hello');
    // IN + DISTINCT 让 planner 物化 FTS 命中的 session_id 集合，再 SEARCH sessions PK
    // EXISTS 形态会让 planner 把外层 sessions SCAN + 每行重跑 FTS（review N5 #2）
    expect(result.sql).toMatch(/sessions\.id IN\s*\(\s*SELECT DISTINCT e\.session_id FROM events_fts/);
    expect(result.sql).toMatch(/JOIN events e ON e\.id = events_fts\.rowid/);
    expect(result.sql).toMatch(/sessions\.id IN\s*\(\s*SELECT DISTINCT su\.session_id FROM summaries_fts/);
    expect(result.sql).toMatch(/JOIN summaries su ON su\.id = summaries_fts\.rowid/);
    expect(result.sql).not.toMatch(/EXISTS\s*\(/);
    // 不应出现旧的 LIKE 全表扫
    expect(result.sql).not.toContain('payload_json LIKE');
    expect(result.sql).not.toContain('su.content LIKE');
  });

  it('SQL fragment 整体外层用括号包裹，可直接拼到 WHERE A AND B 形态', () => {
    const result = buildKeywordPredicate('hello');
    expect(result.sql.trim().startsWith('(')).toBe(true);
    expect(result.sql.trim().endsWith(')')).toBe(true);
  });

  it('含 SQL 通配 % 的关键词被 LIKE 字面拼接（不另加 escape，与历史行为一致）', () => {
    // 历史 listHistory 也是 `%${opts.keyword}%` 不 escape，行为保持
    const result = buildKeywordPredicate('100%');
    expect(result.params.kw_like).toBe('%100%%');
    expect(result.params.kw_fts).toBe('"100%"');
  });

  it('含双引号关键词正确转义 FTS phrase', () => {
    const result = buildKeywordPredicate('say "hi"');
    expect(result.params.kw_fts).toBe('"say ""hi"""');
    expect(result.params.kw_like).toBe('%say "hi"%');
  });

  it('中文关键词 ≥ 3 字符触发 FTS（trigram 按 codepoint 切对 CJK 通用）', () => {
    const result = buildKeywordPredicate('错误信息');
    expect(result.sql).toContain('events_fts');
    expect(result.params.kw_fts).toBe('"错误信息"');
  });

  it('FTS 保留字不会污染 query：phrase 包裹后当字面量处理', () => {
    const result = buildKeywordPredicate('foo AND bar');
    // 不应出现裸 AND/OR 让 FTS 当布尔语法
    expect(result.params.kw_fts).toBe('"foo AND bar"');
  });
});
