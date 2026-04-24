-- V5：FTS5 全文索引（CHANGELOG_22 / Phase 4 N5）
--
-- 历史搜索原走 `events.payload_json LIKE '%kw%'` + EXISTS LIMIT 1 短路（已是 O(n) 全表扫的
-- 最低成本优化，详见 session-repo.ts 注释）。当 events 表大几万条 + payload 多 KB 时仍慢。
-- 上 FTS5 + trigram tokenizer 才是终态。
--
-- 选 trigram 而非 unicode61：payload_json 是任意 JSON 字符串，用户搜的是 substring（函数名 /
-- 错误片段 / 文件路径），unicode61 按 word 切分对 substring 无能为力。trigram 按 3 字符 gram
-- 索引，substring 友好，对中英文混合也通用（每个字符按 UTF-8 切 trigram）。代价是索引 3-5x
-- 大于原文，已可接受。
--
-- `case_sensitive 1`（review N5 #5 修订）：trigram 默认 case_sensitive=0，会改变历史 LIKE
-- 默认 BINARY collation 的「大小写敏感」行为。这里显式置 1 维持原行为，避免用户突然发现
-- 搜 Foo 也命中 foo。如果未来想反向（默认大小写不敏感）需走「行为变更」走 changelog 公告。
--
-- 用 contentless-delete external content 模式 (content='events', content_rowid='id')：
-- FTS 表不复制原文，只存索引；通过 rowid 关联回 events.id。空间最省，但需手维护触发器。

CREATE VIRTUAL TABLE events_fts USING fts5(
  payload_json,
  content='events',
  content_rowid='id',
  tokenize='trigram case_sensitive 1'
);

CREATE VIRTUAL TABLE summaries_fts USING fts5(
  content,
  content='summaries',
  content_rowid='id',
  tokenize='trigram case_sensitive 1'
);

-- 历史回填（external content 模式下用 'rebuild' 触发全量重建索引）。
-- 注意：rebuild 命令读 source 表的 content_rowid 列与索引列，不需要手工 SELECT INSERT。
--
-- 已知风险（review N5 #4，CHANGELOG_22 标注 + 未来优化）：rebuild 在本 migration tx 里跑，
-- 若用户库已有 10w+ 行 events，initDb() 会同步阻塞主进程几秒到十几秒。当前用户库还小，
-- 暂不拆「DDL→commit→后台 rebuild」流程；后续若卡再优化（reviews 跟踪条目）。
INSERT INTO events_fts(events_fts) VALUES('rebuild');
INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild');

-- events 表同步触发器
-- INSERT：新增行 → 索引同步
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, payload_json) VALUES (new.id, new.payload_json);
END;

-- DELETE：external content 模式下要往 fts 表写一行 'delete' 命令告诉它原 rowid 内容
-- （否则索引会引用已不存在的 rowid，MATCH 时报 missing source row）
CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload_json) VALUES('delete', old.id, old.payload_json);
END;

-- UPDATE：先 delete 旧索引再 insert 新索引（payload_json 通常不会被 UPDATE，但留一手以防 N1 截断
-- 重写或后续 schema 加补丁）。
--
-- WHEN 条件（review N5 #3 修订）：sessionRepo.rename 会跑 `UPDATE events SET session_id = ?`
-- 修上千条引用，触发器无条件 fire 会白干 2N 次 FTS 索引读写。加 `IS NOT` 防御只在
-- payload_json 真改时才同步。SQLite 的 IS NOT 处理 NULL 安全（NULL IS NOT NULL → false）。
CREATE TRIGGER events_au AFTER UPDATE ON events
WHEN old.payload_json IS NOT new.payload_json
BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload_json) VALUES('delete', old.id, old.payload_json);
  INSERT INTO events_fts(rowid, payload_json) VALUES (new.id, new.payload_json);
END;

-- summaries 表同步触发器（同上结构）
CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER summaries_au AFTER UPDATE ON summaries
WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO summaries_fts(rowid, content) VALUES (new.id, new.content);
END;
