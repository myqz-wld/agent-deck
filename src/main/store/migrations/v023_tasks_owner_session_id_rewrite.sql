-- plan task-mcp-owner-session-id-rewrite-20260521 Step 1
-- ──────────────────────────────────────────────────────────────────────────────
-- tasks 表从「team_id 闭包 + global task」模型重设计为「owner_session_id 必填
-- + sessions reverse join 拿 team scope」纯模型。
--
-- 起源：REVIEW_49 R3 task tool 修法（"global task 谁都能改"）暴露的累积问题 ——
-- 三条路径会落 global task (team_id IS NULL)：① caller session 无 team 时 closure
-- 闭包 NULL ② team 硬删 ON DELETE SET NULL ③ caller 显式传 team_id=null。task
-- 表无 cleanup / TTL，completed task 永久存活 → DB 持续累积。
--
-- 重设计核心（RFC 3 轮收口 D1-D6 共识）：
-- - core model: owner_session_id NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
-- - 不存 team 字段：team scope 在 query 层 reverse join `sessions → agent_deck_team_members`
-- - 写权限：caller 与 task owner 共享 active team 即可（含 caller == owner 特例）
-- - hand_off 过继：hand_off_session tool spawn 新 session 后原子
--   UPDATE owner_session_id 把 task 转给新 session
-- - GC：复用现有 LifecycleScheduler.historyRetentionDays + sessionRepo.delete
--   → CASCADE 自动删 task；无需新 GC 机制
--
-- Migration 策略 (D5)：DROP TABLE + CREATE TABLE 全新 schema，destructive。
-- 用户 RFC 第 3 轮 Q1 明示「A. drop 所有现有 task（最干净）」—— dev 阶段所有
-- 现存 task 数据丢失可接受（无 prod 用户，task 都是 review/fix 流程辅助跟踪，
-- 非长期 work item）。
--
-- ──────────────────────────────────────────────────────────────────────────────
-- Step 1: DROP TABLE tasks
-- ──────────────────────────────────────────────────────────────────────────────
-- 注意：SQLite DROP TABLE 自动级联 drop 该表所有 indexes（含 v007 的
-- idx_tasks_team_name / idx_tasks_status / idx_tasks_updated_at 与 v011 的
-- idx_tasks_team_id），无需手动 DROP INDEX。
--
-- IF EXISTS 兜底：理论上 v007 已建过 tasks 表此处必存在，但显式 IF EXISTS 让
-- 假设的「跳跃 migration」场景（如新装应用未跑 v007-v022 全直接到 v023）也安全。
DROP TABLE IF EXISTS tasks;

-- ──────────────────────────────────────────────────────────────────────────────
-- Step 2: CREATE TABLE tasks 全新 schema
-- ──────────────────────────────────────────────────────────────────────────────
-- 字段语义：
-- - id              UUID v4（crypto.randomUUID），tool 层生成
-- - owner_session_id NOT NULL，永远绑一个真实 session（无 global task 概念）
--                   FK → sessions(id) ON DELETE CASCADE
--                   ⚠️ CASCADE 行为变化：v007 用 ON DELETE SET NULL（孤儿 task
--                   保留），v023 改 CASCADE（session 真删 → task 真删）。配合
--                   LifecycleScheduler.historyRetentionDays 自动 GC archived 后
--                   N 天的老 session，达成「task TTL 自动清理」效果（plan §D4）。
-- - subject         非空 1-200 char（tool 层 zod 校验，repo 层只挡 trim 后空字符串）
-- - description     ≤2000 char（tool 层 zod）
-- - status          枚举 pending|active|completed|blocked|abandoned
-- - active_form     当前认领 agent 名（兼容 Claude Code TaskUpdate active_form 字段）
-- - priority        0-10 优先级（默认 5）
-- - blocks          JSON string of task id[]（下游被阻塞 task）
-- - blocked_by      JSON string of task id[]（上游依赖 task）
-- - labels          JSON string of string[]（自由 tag）
-- - created_at      ISO8601 字符串
-- - updated_at      ISO8601 字符串
--
-- ⚠️ 删除字段：team_name (v007) + team_id (v011) 全删 —— team scope 信息
-- 完全推到 query 层 reverse join 算（owner_session_id → sessions →
-- agent_deck_team_members.team_id）。
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  owner_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  active_form       TEXT,
  priority          INTEGER NOT NULL DEFAULT 5,
  blocks            TEXT NOT NULL DEFAULT '[]',
  blocked_by        TEXT NOT NULL DEFAULT '[]',
  labels            TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ──────────────────────────────────────────────────────────────────────────────
-- Step 3: 索引
-- ──────────────────────────────────────────────────────────────────────────────
-- owner_session_id：
-- 1. 查询：list 默认 query 走 sessions reverse join，owner_session_id 是
--    JOIN ON 列必加索引。
-- 2. FK 索引：SQLite 删 sessions row 触发 ON DELETE CASCADE 时需扫 tasks 表找
--    匹配 owner_session_id 的行；无索引则全表扫，sessions 频繁删（lifecycle GC）
--    时 N+1 退化为 N×M。FK 索引是 perf hardening 不是正确性约束。
CREATE INDEX IF NOT EXISTS idx_tasks_owner_session_id
  ON tasks(owner_session_id);

-- list 默认 status 过滤 + ORDER BY updated_at DESC，两个常用查询路径都给 b-tree 加速。
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_tasks_updated_at
  ON tasks(updated_at DESC);
