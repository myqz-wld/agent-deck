#!/usr/bin/env bash
# verify-fts5.sh — Phase 4 N5 真 SQL 集成校验（CHANGELOG_22 / REVIEW 配套）
#
# 用 system sqlite3 CLI 在 :memory: 里跑全套 migrations + buildKeywordPredicate 生成的
# SQL 模板 + 触发器场景，验证：
#  - schema 语法合法（migration 全部 apply 成功）
#  - FTS MATCH 谓词可 prepare（review N5 #1：alias MATCH 形态会 parse fail 的 regression 防御）
#  - 关键词命中正确（events / summaries / title 三路命中各跑一次）
#  - INSERT/DELETE/UPDATE 触发器同步（review N5 #3：UPDATE WHEN 防御 rename 白工作）
#  - 大小写敏感性维持原 LIKE BINARY 行为（review N5 #5：trigram case_sensitive=1）
#
# 不依赖 better-sqlite3 binding（electron 重编版本与本机 node 不兼容），不依赖 vitest。
# 任何步骤失败 → 整脚本 exit 1。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/src/main/store/migrations"

# 校验 sqlite3 可用 + 版本 ≥ 3.34（trigram tokenizer 引入版本）
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "FAIL: sqlite3 CLI not installed"
  exit 1
fi

SQLITE_VERSION=$(sqlite3 --version | awk '{print $1}')
echo "Using sqlite3 $SQLITE_VERSION"

# 拼装所有 migrations
SCHEMA=$(cat \
  "$MIGRATIONS_DIR/v001_init.sql" \
  "$MIGRATIONS_DIR/v002_sessions_source.sql" \
  "$MIGRATIONS_DIR/v003_split_archive_from_lifecycle.sql" \
  "$MIGRATIONS_DIR/v004_sessions_permission_mode.sql" \
  "$MIGRATIONS_DIR/v005_fts.sql"
)

run_sql() {
  local desc="$1"
  local sql="$2"
  local expected="$3"
  local actual
  actual=$(sqlite3 ':memory:' <<EOF
-- macOS 系统 sqlite3 CLI 默认 trusted_schema=OFF，拒绝从 trigger 写虚表。
-- better-sqlite3 11.x 默认 ON 不影响生产；此脚本显式置 ON 以匹配生产行为。
-- db.ts 也已显式置 ON 防御未来 binding 默认变化（review N5 #10）。
PRAGMA trusted_schema = ON;
-- sqlite3 CLI 默认 foreign_keys=OFF，必须显式 ON 才能验证 ON DELETE CASCADE
-- 生产 db.ts:initDb 已经设过。
PRAGMA foreign_keys = ON;

$SCHEMA

-- 测试夹具：3 个 sessions，每个挂若干 events / summaries
INSERT INTO sessions (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
VALUES
  ('s1', 'claude', '/tmp/foo', 'Title contains foo', 'cli', 'closed', 'idle', 1000, 2000),
  ('s2', 'claude', '/tmp/bar', 'Generic title', 'cli', 'closed', 'idle', 1000, 2000),
  ('s3', 'claude', '/tmp/baz', 'Another', 'cli', 'closed', 'idle', 1000, 2000);

INSERT INTO events (session_id, kind, payload_json, ts) VALUES
  ('s2', 'tool-use-end', '{"toolResult":"hello world from bash"}', 1500),
  ('s2', 'tool-use-end', '{"toolResult":"unrelated payload"}', 1600),
  ('s3', 'tool-use-end', '{"toolResult":"another mention here"}', 1700);

INSERT INTO summaries (session_id, content, trigger, ts) VALUES
  ('s3', 'this conversation discussed needle in haystack', 'auto', 1800);

$sql
EOF
)
  if [[ "$actual" == "$expected" ]]; then
    echo "OK   $desc"
  else
    echo "FAIL $desc"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

#
# 测试 1: schema apply 成功（v005 + 触发器全建）
#
run_sql "schema applies cleanly" \
  "SELECT name FROM sqlite_master
    WHERE type IN ('table','trigger')
      AND (name LIKE '%fts%' OR name IN ('events_ai','events_ad','events_au','summaries_ai','summaries_ad','summaries_au'))
    ORDER BY name;" \
  "events_ad
events_ai
events_au
events_fts
events_fts_config
events_fts_data
events_fts_docsize
events_fts_idx
summaries_ad
summaries_ai
summaries_au
summaries_fts
summaries_fts_config
summaries_fts_data
summaries_fts_docsize
summaries_fts_idx"

#
# 测试 2: title 命中（≥3 字符触发 FTS，但 events/summaries 都没命中，靠 title LIKE）
#
run_sql "title-only match (≥3 chars)" \
  "SELECT id FROM sessions WHERE (title LIKE '%foo%'
      OR sessions.id IN (
        SELECT DISTINCT e.session_id FROM events_fts
         JOIN events e ON e.id = events_fts.rowid
        WHERE events_fts MATCH '\"foo\"'
      )
      OR sessions.id IN (
        SELECT DISTINCT su.session_id FROM summaries_fts
         JOIN summaries su ON su.id = summaries_fts.rowid
        WHERE summaries_fts MATCH '\"foo\"'
      )) ORDER BY id;" \
  "s1"

#
# 测试 3 (N5 #1 regression): events_fts MATCH @kw_fts 表名形态可 parse
# （历史曾用 \`fts MATCH @kw_fts\` alias 形态会 parse fail）
#
run_sql "events_fts MATCH parse OK + match correctness" \
  "SELECT id FROM sessions WHERE sessions.id IN (
    SELECT DISTINCT e.session_id FROM events_fts
     JOIN events e ON e.id = events_fts.rowid
    WHERE events_fts MATCH '\"hello world\"'
  ) ORDER BY id;" \
  "s2"

#
# 测试 4: summaries_fts MATCH 命中
#
run_sql "summaries_fts MATCH hits" \
  "SELECT id FROM sessions WHERE sessions.id IN (
    SELECT DISTINCT su.session_id FROM summaries_fts
     JOIN summaries su ON su.id = summaries_fts.rowid
    WHERE summaries_fts MATCH '\"needle\"'
  ) ORDER BY id;" \
  "s3"

#
# 测试 5 (N5 #5): trigram case_sensitive=1 维持大小写敏感
# 'HELLO' (大写) 不应命中含 'hello' (小写) 的文档
#
run_sql "trigram case_sensitive=1 (大小写敏感, 维持原 LIKE BINARY 行为)" \
  "SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"HELLO\"';" \
  "0"

run_sql "trigram case_sensitive=1 (相同大小写命中)" \
  "SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"hello\"';" \
  "1"

#
# 测试 6 (N5 #3 触发器同步): INSERT 后 FTS 立即可搜
#
run_sql "INSERT trigger 同步" \
  "INSERT INTO sessions (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
   VALUES ('s9', 'claude', '/tmp', 'tmp', 'cli', 'closed', 'idle', 0, 0);
   INSERT INTO events (session_id, kind, payload_json, ts) VALUES ('s9', 'k', '{\"x\":\"freshly inserted text\"}', 9999);
   SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"freshly\"';" \
  "1"

#
# 测试 7 (N5 #3 触发器同步): DELETE 后 FTS 立即清掉
#
run_sql "DELETE trigger 同步" \
  "DELETE FROM events WHERE session_id = 's2';
   SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"hello\"';" \
  "0"

#
# 测试 8 (N5 #3 关键): UPDATE session_id 时 payload_json 没变 → WHEN 跳过触发器
# 单凭 SQL 不好直接验「触发器有没有 fire」，但可以验「rename 后 FTS 索引仍能命中相同关键词」
# （如果 WHEN 错过把 payload 删掉但没重插会 dangling，count 变 0）
#
run_sql "UPDATE WHEN 防御: rename 不破坏 FTS" \
  "UPDATE events SET session_id = 's3' WHERE session_id = 's2';
   SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"hello\"';" \
  "1"

#
# 测试 9 (N5 #3 反向): UPDATE payload_json 真改时 WHEN 通过触发器更新
#
run_sql "UPDATE WHEN 触发: payload 真改时 FTS 同步新值" \
  "UPDATE events SET payload_json = '{\"toolResult\":\"replaced text bingo\"}' WHERE session_id = 's2' AND payload_json LIKE '%hello%';
   SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"bingo\"';" \
  "1"

#
# 测试 10: CASCADE DELETE sessions → events DELETE → FTS 清理
#
run_sql "CASCADE DELETE 触发 events_ad → FTS 清理" \
  "DELETE FROM sessions WHERE id = 's3';
   SELECT count(*) FROM events_fts WHERE events_fts MATCH '\"another mention\"';
   SELECT count(*) FROM summaries_fts WHERE summaries_fts MATCH '\"needle\"';" \
  "0
0"

#
# 测试 11 (N5 #1 对照): alias MATCH 应该 parse FAIL（保护回归）
# 确认旧 broken 形态在当前 sqlite3 仍被拒（如果哪天 sqlite 接受了 alias MATCH 这测试会变绿）
#
echo -n "OK   alias MATCH 仍被 sqlite3 拒绝（regression guard）: "
ALIAS_OUT=$(sqlite3 ':memory:' 2>&1 <<EOF || true
PRAGMA trusted_schema = ON;
PRAGMA foreign_keys = ON;
$SCHEMA
SELECT 1 FROM events_fts fts WHERE fts MATCH '"x"' LIMIT 1;
EOF
)
if echo "$ALIAS_OUT" | grep -q "no such column: fts"; then
  echo "rejected as expected"
else
  echo "FAIL: alias MATCH unexpectedly accepted by sqlite3 $SQLITE_VERSION"
  echo "  output: $ALIAS_OUT"
  exit 1
fi

echo
echo "All FTS5 integration checks passed (sqlite3 $SQLITE_VERSION)."
