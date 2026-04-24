-- 持久化 SDK 通道的 permission_mode（用户上次主动选过的）。SDK Query 自身有运行时
-- 状态但不暴露 getter，DB 列让 UI 切回 detail / 恢复会话时能还原下拉。
-- CLI 通道不写这列，永远 NULL。
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
