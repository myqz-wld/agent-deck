# CHANGELOG_45: README 重构（466 → 264 行）

## 概要

README.md 累积了 30+ 个三级标题，每个 5-15 行，读者读完前 5 个就累了；功能描述、设计决策、内部实现细节混在一起；「项目结构」一节膨胀到 97 行像文件树字典；安装步骤埋在「开发与运行」末尾对纯使用者不友好。重写为「30 秒读懂这是什么 → 主要能力快扫 → 核心概念建心智模型 → 安装路径分级 → 开发细节」的递进结构。功能能力 0 删除（只是合并描述），删的全是「为什么这么设计」「实现细节陷阱」类内部信息（这些本来就该在 changelog / 代码注释，不该在 README）。

## 变更内容

### README.md
- 466 行 → 264 行（-43%）
- 一级章节：11 → 8（顶部介绍、截图、主要能力、核心概念、安装与使用、命令行接入、设置、项目结构、开发指南、进一步阅读）
- 三级章节：30+ → 14（核心概念下 6 个、安装下 3 个、开发指南下 4 个）
- 「主要能力」重写成 8 个一句话 bullet，让读者扫一眼知道有什么
- 「权限请求」「AskUserQuestion」「ExitPlanMode」三个原本独立的大节合并成主要能力的一行 bullet + Adapter capabilities 表里说差异
- 「Claude Code SDK 通道」「Hook 通道」「Codex CLI SDK 通道」三大节合并到核心概念下「会话来源：内 vs 外」一节
- 「项目结构」97 行 → 32 行：只列二级目录 + 关键文件 + 一行职责，不再逐文件注释
- 「打包必须知道的几件事」列 5 条核心坑 + 对应 CHANGELOG 编号，详细原因不复述
- 安装步骤从「开发与运行」末尾提到「安装与使用」靠前位置，让纯用户路径更直接
- 设置面板从逐项详尽列表改成一段话扫一遍能改什么
- 删除「毛玻璃 CSS 陷阱」「pin 残影 invalidate」「30s fallback / tempKey rename」「cwd 待领取标记」「会话恢复 resume 实现细节」等纯实现陷阱节（这些是开发者读 changelog 的事）

### 流程
- sub-agent 干（general-purpose），先读 README + CLAUDE.md + changelog/INDEX.md + package.json 建立认知，规划新结构，覆盖写入
- typecheck / build 不需要跑（只动文档）
- 截图占位保留 `<!-- TODO: 补一张主界面截图 -->`，不凭空贴图

### 没改但值得知道
- 「设计决策摘要」附录章节最初考虑加一个，最后没加：核心概念 6 节已经覆盖了最关键决策（lifecycle / archived 正交、SDK vs Hook 通道、Adapter capabilities），再列 10 条会变成「README 复述 changelog」反而稀释主线
- 一些读者可能会找的内容（毛玻璃 CSS 数值、pin invalidate 频率、Codex 单工 turn 队列实现）现在只在 changelog 里 —— 这是有意取舍，README 不该是「让 maintainer 也舒服」的全能文档
