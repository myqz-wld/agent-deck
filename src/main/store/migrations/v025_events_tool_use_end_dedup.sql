-- v025: events 表 tool-use-end partial UNIQUE INDEX，对称 v022（REVIEW_54）。
--
-- 背景（DB 实测铁证）：v022 仅 dedup tool-use-start，tool-use-end 故意没 dedup
-- （彼时假设「终态事件，每对 start/end 独立行」）。但 codex thread restart/resume/
-- 重连路径下同一 item.id 的 item.completed 会被重发多次 → DB 累积 N 行同
-- toolUseId 的 tool-use-end 行。生产 DB 实测：codex 会话 019e438b-994f-... 共
-- 19 组 (session_id, tool_use_id) 出现 2-4 行 tool-use-end 重复。
--
-- 渲染侧后果：
--   1. ActivityFeed `recent` 数组同 toolUseId 多份 tool-use-end → 渲染多行 ToolEndRow
--   2. eventKey = `tool-use-end:<toolUseId>` → 多个 <ActivityRow> 共享同 React key
--      → key collision，hooks state 与 reconciliation 错乱 → button onClick 点了无反应
--
-- 修法：与 v022 字节级对称（仅 WHERE 子句 kind 替换为 'tool-use-end'）
--
-- 注意：tool_use_id 列已由 v022 创建（不重复 ADD COLUMN），仅做 tool-use-end
-- 子集的回填 / 清理 / partial index 创建。
--
-- LOW 守门同 v022：仅 json_type='text' AND != '' 才回填 tool_use_id，
-- 避免空串 / 非 string toolUseId 被强转进 dedup 路径。

-- 1. 历史数据回填 tool-use-end（v022 回填覆盖了 tool-use-start AND tool-use-end，
--    但仅当 toolUseId 是 text 且非空时才回填；这里再跑一次仅 tool-use-end 子集
--    是幂等 noop 兜底 — 万一某条 v022 执行后写入的 tool-use-end 行漏回填的兜底）。
UPDATE events
SET tool_use_id = json_extract(payload_json, '$.toolUseId')
WHERE kind = 'tool-use-end'
  AND tool_use_id IS NULL
  AND json_type(payload_json, '$.toolUseId') = 'text'
  AND json_extract(payload_json, '$.toolUseId') != '';

-- 2. 历史冗余清理：同 (session_id, kind='tool-use-end', tool_use_id) 仅保留
--    ts DESC, id DESC 首行（与 v022 step 3 + event-repo.listForSession F3 修法
--    `ORDER BY ts DESC, id DESC` 完全对齐 — UI 拉历史首条 == migration 保留首条）。
--    SQLite 3.25+ 支持窗口函数（bundled 3.49.2 完全支持）。
DELETE FROM events
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY session_id, tool_use_id
             ORDER BY ts DESC, id DESC
           ) AS rn
    FROM events
    WHERE kind = 'tool-use-end' AND tool_use_id IS NOT NULL
  )
  WHERE rn > 1
);

-- 3. partial UNIQUE INDEX：仅 tool-use-end + 有 tool_use_id 才独占
--    与 v022 的 events_tool_use_start_dedup 共存不冲突（kind 不同，partial WHERE
--    互斥）。索引名独立避免命名碰撞。
CREATE UNIQUE INDEX events_tool_use_end_dedup
  ON events (session_id, kind, tool_use_id)
  WHERE kind = 'tool-use-end' AND tool_use_id IS NOT NULL;
