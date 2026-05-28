# Codex CLI / claude -p 大任务 stuck 教训

> 实证教训：单 prompt 文件清单 ≥ 15 / 总长 ≥ 80 行 + reasoning xhigh 时，CLI 容易卡在初步扫描阶段（`wc -l` / `ls`）10+ 分钟没动。
> 根因：xhigh "研究阶段" 在大 context 下会无限延长，不是真死锁，但等不到答案。

## 正确姿势

- 按主题 / 目录拆 ≤ 10 个文件一批，单批 prompt ≤ 30 行（文件清单 + 输出格式 + skip 项足够）
- 每批用 Bash 工具的 `run_in_background: true` 起，多批并发，等 `task-notification` 通知
- 单批仍给 `timeout: 600000`（拆批是降低 stuck 概率，不是降本批耗时）
- prompt 顶部明示「只看下面文件，不要再读 REVIEW_X.md / CLAUDE.md」避免 CLI 自拉背景把 context 撑大
- skip 项写在 prompt 里（如「skip REVIEW_1 已修过的 8 处：...」），不要让 CLI 自己去读 ref/reviews/ 推断
- 真卡了就 `TaskStop` 中止 + 拆更小批重试，不要傻等

## 简短版（CLAUDE.md 留这一句）

「单批 ≤ 10 文件 / prompt ≤ 30 行；超出拆批 + `run_in_background` 并发；卡住 `TaskStop` 后再拆更小批，不要傻等」
