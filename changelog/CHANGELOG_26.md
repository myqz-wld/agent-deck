# CHANGELOG_26: 安装流程加 pkill 旧进程，避免 chunk hash 错配渲染 monaco 源码

## 概要

实测翻车一次：早上 12:11 重新 dist + cp 覆盖到 /Applications，但旧 main 进程从昨天起一直没退（pid 2398，Tue 10AM 启动），后续点 dock 图标 macOS 复用了那个旧实例。旧 renderer 还引用着旧 hash 的 chunk 文件名（`index-OLDHASH.js`），新 .app 里只剩新 hash 的 `index-BSJIHkwr.js`，触发 `TextDiffRenderer.tsx` 里 `import('@monaco-editor/react')` 的 dynamic import 拿到错的内容，整段 monaco-editor/react Editor 组件 minified 源码（`reactExports.useEffect / o.current.editor.create / ... return We.createElement(H, ...)`）被 webview 当 plain text 渲染到窗口里。

把「重装前 pkill 旧实例」补成 CLAUDE.md「打包与本地安装」流程的第 0 步，并在「打包配置已踩的坑」里加一条记录原因，下次直接看清单就能避免。

## 变更内容

### CLAUDE.md（「打包与本地安装」节）
- 新增第 0 步 `pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck"` + `pkill -f "Agent Deck Helper"`，注释解释根因（macOS 同 bundle id 的活进程会被复用 → 旧 main + 新资源 chunk hash 错配 → dynamic import 拉错文件 → plain text 渲染 monaco 源码）
- 「打包配置已踩的坑」清单尾部追加「重装前必须 pkill 旧进程」条目，跟「ad-hoc 重签必须做」并列，方便扫描；强调不要靠点 dock 红点退出（后台 helper / utility 进程不一定跟着走）

## 取舍说明

### 为什么不在 dist 脚本里自动 pkill
`pnpm dist` 只负责打包出 dmg，覆盖安装是后续步骤。pkill 放进 npm script 会让它跨职责（打包脚本不应该动用户已安装的应用进程）；放在文档第 0 步、跟覆盖安装一起跑更符合心智模型，也方便用户单独 dist 不想动现有实例的情况。

### 为什么不写个一键安装脚本
五步流程已经文档化，每步都有独立的踩坑理由（重签、quarantine、wrapper 软链），脚本化反而让用户绕过这些上下文。当前痛点是「容易漏第 0 步」，写清楚比脚本封装更重要。

### 为什么不靠 single-instance lock 让旧进程主动退
`requestSingleInstanceLock` 的语义是「新启动的实例发现自己是第二个就退」，不是「让旧实例自杀让位给新版本」。旧实例还活着、用户也没主动退它的时候，它对自己的版本号不知情，main 也不会自动 reload renderer。要做版本对比让旧进程自退是另一码事（涉及 IPC 协议、进度感知、未保存状态保护），成本远大于「打包前 pkill」一行命令。

## 不在这次改动范围内
- 不动代码（main / renderer / electron-builder 配置都没改），纯文档约定
- 不改 dev 流程的「kill 干净」清单（那条针对 electron-vite dev 进程，与装好的 .app pkill 不冲突）
