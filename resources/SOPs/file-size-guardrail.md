# 单文件大小护栏（≤ 500 行）

> 任何代码源文件 LOC > 500 行触发拆分尝试（不含测试 fixture / 自动生成的 migration / lock / snapshot 等机器产物）。每次改完该文件 / commit 前必做一次。

## 风险升序，按档选

1. **抽 module-level 纯函数 / 类型 / 常量** —— 风险最低，先做。原文件只 import 回来，调用点零改动
2. **目录化 + 同目录 sub-module / sub-component** —— `foo.ts → foo/index.ts + foo/bar.ts`，多数语言的 module resolution 自动透传 import，外部调用方不用动
3. **拆 class（合作 class + facade 委托 + 共享 ctx ref）** —— 最重风险，class state ownership 重组属架构决策，必须走 plan + 「决策对抗」节流程

## 真不能拆

race 极复杂 / state ownership 高度耦合 / 强行拆收益 < 风险 → 写到对应 CHANGELOG 的「不动文件保护清单」+ 注明理由（class 性质 / 单飞 / cross-cutting state ...），下次拆分轮直接跳过。**不能默认沉默忽略**——必须显式登记并说理，否则下次还会被同一文件的拆分尝试重复打断。

## 阈值调整

500 行调整属约定升级，走「决策对抗」三态裁决；触发判定本身（行数 > 阈值）不走对抗，纯机械计算。
