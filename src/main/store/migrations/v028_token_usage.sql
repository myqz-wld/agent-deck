-- v028: token_usage 明细表（plan model-token-stats-and-dashboard-20260602 §数据模型）。
--
-- 采集每条 assistant message（claude）/ turn.completed（codex）的 token 用量，支撑：
--   ① header Top3 模型「输出 token/s」（今日 output 总量排名 + 60s 窗口速率）
--   ② 数据 tab 每模型每天 token 使用（input/output/cacheRead/cacheCreation 表格 + 汇总）
--
-- 关键设计（详 plan §数据模型 + deep-review 收口）：
-- - **存明细不预聚合**：60s 窗口需行级 ts；每天聚合用 GROUP BY date(ts/1000,'unixepoch','localtime')
--   同表算。SQLite 量级预聚合收益可忽略。
-- - **session_id 纯 TEXT 无硬 FK**（deep-review R1 F3）：原设计 FOREIGN KEY 与「token-usage ingest
--   早返不建 session row」张力 — claude 新 spawn 时 session row 由 finalizeSessionStart 创建，
--   而首条 assistant frame（带 usage）由后台 consume loop 处理，两者经 microtask 竞争；竞态输 →
--   FK INSERT 撞父行不存在 → 被 try/catch 吞 → 首条 usage 静默丢。去 FK 消除竞态 + 兑现解耦意图。
--   session 删除后 token_usage row 保留（统计不应因 session GC 塌缩，符合「历史每天」语义）。
-- - **message_id partial UNIQUE + max-merge**（deep-review R1 F1 + R2 H1）：claude 同 turn 多
--   tool_use 共享同一 BetaMessage.id，正常携带 identical usage；rare case 同 id 不同 output 取
--   最高值（官方 cost-tracking 文档）。result.modelUsage 补差额时用 synthetic message_id，同样
--   依赖 partial UNIQUE 防 result replay 重复计数。codex message_id=NULL 每 turn 独立 INSERT
--   新行（不参与 UNIQUE）。upsert 走 ON CONFLICT(message_id) WHERE message_id IS NOT NULL
--   DO UPDATE SET <4指标>=max(...)（conflict target 必带 WHERE 谓词，REVIEW_52 约定）。
-- - **model_raw（原始 id 保粒度）+ model_bucket（归一聚合维度，写时算）双存**；display 名不入库
--   （renderer 从 bucket 派生，改文案无需迁移）。
-- - **timestamp INTEGER epoch ms**（与 sessions / issues 一致）。
-- - **不采集 costUSD**（assistant message 无 costUSD；用户不展示费用）。

CREATE TABLE IF NOT EXISTS token_usage (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT,                              -- 纯 TEXT 无 FK；仅可选 drill-down
  agent_id               TEXT NOT NULL,                     -- 'claude-code' | 'codex-cli'
  message_id             TEXT,                              -- claude assistant/result 去重锚点；codex NULL
  model_raw              TEXT NOT NULL,                     -- 原始 model id 保粒度
  model_bucket           TEXT NOT NULL,                     -- 归一 bucket key（GROUP BY 维度）
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,        -- codex 无 → 0
  ts                     INTEGER NOT NULL                   -- epoch ms
);

-- 去重兜底：仅 message_id 非空走 partial UNIQUE（codex NULL 可插多行）。
-- ON CONFLICT(message_id) WHERE message_id IS NOT NULL DO UPDATE 必须重复此 WHERE 谓词。
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_message_id
  ON token_usage(message_id) WHERE message_id IS NOT NULL;

-- 60s 窗口（ratesSince）+ 今日（today）按 ts 范围扫
CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(ts);

-- 分桶窗口 / 每日聚合（ratesSince GROUP BY bucket / dailyByModel GROUP BY bucket,day）
CREATE INDEX IF NOT EXISTS idx_token_usage_bucket_ts ON token_usage(model_bucket, ts);
