-- v022: events.tool_use_id 列 + partial UNIQUE INDEX，让 ingest 写入侧 dedup
-- 同 toolUseId 的 tool-use-start（REVIEW_52 A2，配合 event-repo.ts UPSERT）。
--
-- 背景：codex item.updated 重发同 toolUseId 的 tool-use-start 让 store dedup 替换显示
-- aggregated_output 增长（codex-cli/translate.ts:271-295）。但每条 emit 都 INSERT 新行
-- → 长命令 30 秒推 N 条 → DB 累积 N 条同 toolUseId tool-use-start → 拉历史 N 行重复显示。
--
-- 修法：tool_use_id 表列 + partial UNIQUE INDEX(session_id, kind, tool_use_id)
-- WHERE kind='tool-use-start' AND tool_use_id IS NOT NULL，让 INSERT 走 UPSERT
-- 命中 partial conflict 替 payload+ts 不开新行。
--
-- 双 reviewer 异构对抗 finding（REVIEW_52 review）：
--   - F1（claude HIGH-1 ↔ codex HIGH-2）：partial UNIQUE INDEX 与 ON CONFLICT target
--     必须重复 WHERE 子句（SQLite 3.49.2 lang_upsert.html 文档承诺）— 由 event-repo.ts
--     UPSERT 实施
--   - F6（codex MED-1）：DELETE 历史冗余按 ts DESC 取首，不是按 MAX(id)
--     （ts 与 id 顺序在 codex 重连乱序场景下不一致）
--   - LOW-1（codex）：UPDATE 回填加 json_type='text' AND != '' 守门，
--     避免空字符串 / 非 string toolUseId 进 dedup 路径

-- 1. 加 tool_use_id 列（NULL 默认，让其他 kind 不参与 dedup）
ALTER TABLE events ADD COLUMN tool_use_id TEXT;

-- 2. 历史数据回填：从 payload_json 提取 toolUseId
--    LOW-1 守门：仅 string 类型 + 非空才回填，避免 '{"toolUseId":""}' / '{"toolUseId":123}'
--    被 json_extract 强转后参与 dedup
UPDATE events
SET tool_use_id = json_extract(payload_json, '$.toolUseId')
WHERE kind IN ('tool-use-start', 'tool-use-end')
  AND json_type(payload_json, '$.toolUseId') = 'text'
  AND json_extract(payload_json, '$.toolUseId') != '';

-- 3. 历史冗余清理：同 (session_id, kind='tool-use-start', tool_use_id) 仅保留 ts DESC 首行
--    F6 修法：用窗口函数 ROW_NUMBER OVER ORDER BY ts DESC, id DESC（与 listForSession
--    SQL F3 修法 ORDER BY ts DESC, id DESC 完全对齐 — UI 拉历史首条 == migration 保留首条）
--    SQLite 3.25+ 支持窗口函数（bundled 3.49.2 完全支持）
DELETE FROM events
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY session_id, tool_use_id
             ORDER BY ts DESC, id DESC
           ) AS rn
    FROM events
    WHERE kind = 'tool-use-start' AND tool_use_id IS NOT NULL
  )
  WHERE rn > 1
);

-- 4. partial UNIQUE INDEX：仅 tool-use-start + 有 tool_use_id 才独占
--    partial 让 tool-use-end 同 toolUseId 终态行允许多条（每对 start/end 独立行）
--    其他 kind（message / file-changed 等）tool_use_id 都 NULL，partial WHERE 自动跳过
CREATE UNIQUE INDEX events_tool_use_start_dedup
  ON events (session_id, kind, tool_use_id)
  WHERE kind = 'tool-use-start' AND tool_use_id IS NOT NULL;
