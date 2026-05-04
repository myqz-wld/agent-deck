@echo off
REM Agent Deck CLI wrapper（Windows）
REM
REM 用法（cmd.exe / PowerShell 都能跑）：
REM   agent-deck                    -- 当前目录起新会话
REM   agent-deck --prompt "ping"    -- 当前目录起新会话 + 首条 prompt
REM   agent-deck new --cwd "C:\foo" --prompt "..."
REM
REM 行为（与 macOS bash wrapper 对齐）：
REM   1. 找 Agent Deck.exe：%AGENT_DECK_APP% > %LOCALAPPDATA%\Programs\Agent Deck\Agent Deck.exe > %PROGRAMFILES%\Agent Deck\Agent Deck.exe
REM   2. 应用未运行 → Electron 首启实例直接处理 argv
REM   3. 应用已运行 → second-instance 事件转发（main/index.ts）
REM
REM 行为差异（vs macOS bash wrapper）：
REM   - cmd.exe 的 %~1 / %* 在 quoting/escaping 上限制比 bash 多，所以：
REM     * 不在 wrapper 端做相对→绝对路径转换；而是依赖 main/cli.ts 的 isAbsolute+resolve 兜底
REM     * 不在 wrapper 端校验 --cwd 是否缺值；同样依赖主进程 throw + dialog.showErrorBox
REM   - 简化形式（自动补 'new' + --cwd "%CD%"）由 wrapper 负责，与 macOS 一致
REM
REM 安装到 PATH（任选）：
REM   - PowerShell 加：$env:PATH += ";C:\Users\<you>\AppData\Local\Programs\Agent Deck\resources\bin"
REM   - 或把 agent-deck.cmd 复制到已在 PATH 上的目录（如 C:\Windows\System32 不推荐，建议自建 ~\bin）

setlocal

REM 1. 定位 .exe
set "APP_EXE=%AGENT_DECK_APP%"
if not defined APP_EXE set "APP_EXE=%LOCALAPPDATA%\Programs\Agent Deck\Agent Deck.exe"
if not exist "%APP_EXE%" set "APP_EXE=%PROGRAMFILES%\Agent Deck\Agent Deck.exe"
if not exist "%APP_EXE%" (
  echo agent-deck: Agent Deck.exe not found.        1>&2
  echo   Set AGENT_DECK_APP to override default install location, or install via NSIS to default. 1>&2
  exit /b 1
)

REM 2. 简化形式判断 + spawn
REM    无参数：补 'new --cwd "%CD%"'
REM    首参 --xxx：补 'new --cwd "%CD%"' 在前
REM    首参 'new'：透传（main/cli.ts 内会兜底 cwd ?? homedir）
REM    其他：透传
if "%~1"=="" (
  start "" "%APP_EXE%" new --cwd "%CD%"
  exit /b 0
)

set "FIRST=%~1"
if /I "%FIRST%"=="new" (
  start "" "%APP_EXE%" %*
  exit /b 0
)

REM 检查首参是否以 -- 开头（cmd 的 substring）
if "%FIRST:~0,2%"=="--" (
  start "" "%APP_EXE%" new --cwd "%CD%" %*
  exit /b 0
)

REM 默认透传（未来子命令扩展用）
start "" "%APP_EXE%" %*
exit /b 0
