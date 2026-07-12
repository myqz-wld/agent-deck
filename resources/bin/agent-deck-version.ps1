param(
  [Parameter(Mandatory = $true)]
  [string]$AppExe,
  [switch]$CheckInstalled
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string[]]$GitArgs
  )

  try {
    $output = & git -C $Repo @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) {
      return $null
    }
    return (($output -join "`n").Trim())
  } catch {
    return $null
  }
}

function Find-SourceRepo {
  $dir = (Get-Location).Path
  while ($dir) {
    $packagePath = Join-Path $dir "package.json"
    if (Test-Path $packagePath) {
      try {
        $package = Get-Content -Raw $packagePath | ConvertFrom-Json
        if ($package.name -eq "agent-deck") {
          return $dir
        }
      } catch {
      }
    }

    $parent = Split-Path $dir -Parent
    if (!$parent -or $parent -eq $dir) {
      break
    }
    $dir = $parent
  }
  return $null
}

function Value-OrUnknown {
  param([object]$Value)

  if ($Value -is [bool]) {
    if ($Value) {
      return "是"
    }
    return "否"
  }
  if ($null -eq $Value) {
    return "未知"
  }
  $text = [string]$Value
  if ($text.Length -eq 0) {
    return "未知"
  }
  return $text
}

$appRoot = Split-Path $AppExe -Parent
$buildInfoPath = Join-Path $appRoot "resources\build-info.json"

if (!(Test-Path $buildInfoPath)) {
  Write-Host "Agent Deck：未找到 build-info.json"
  Write-Host ("  查找路径：" + $buildInfoPath)
  Write-Host "  提示：安装包版本较旧，或未使用当前打包脚本构建。"
  if ($CheckInstalled) {
    exit 2
  }
  exit 0
}

$info = Get-Content -Raw $buildInfoPath | ConvertFrom-Json

Write-Host ("Agent Deck " + (Value-OrUnknown $info.version))
Write-Host ("  安装 commit：" + (Value-OrUnknown $info.commit) + " (" + (Value-OrUnknown $info.shortCommit) + ")")
Write-Host ("  安装分支：" + (Value-OrUnknown $info.branch))
Write-Host ("  安装时有未提交改动：" + (Value-OrUnknown $info.dirty))
Write-Host ("  构建时间：" + (Value-OrUnknown $info.builtAt))

$repo = Find-SourceRepo
if (!$repo) {
  Write-Host "  状态：当前目录下未找到 agent-deck 源码 checkout"
  exit 0
}

$head = Invoke-Git -Repo $repo -GitArgs @("rev-parse", "HEAD")
$shortHead = Invoke-Git -Repo $repo -GitArgs @("rev-parse", "--short=12", "HEAD")
$originMain = Invoke-Git -Repo $repo -GitArgs @("rev-parse", "--verify", "--quiet", "origin/main")
$shortOrigin = $null
if ($originMain) {
  $shortOrigin = Invoke-Git -Repo $repo -GitArgs @("rev-parse", "--short=12", "--verify", "--quiet", "origin/main")
}
$sourceDirty = [bool](Invoke-Git -Repo $repo -GitArgs @("status", "--porcelain"))

Write-Host ("  源码目录：" + $repo)
Write-Host ("  源码 HEAD：" + (Value-OrUnknown $head) + " (" + (Value-OrUnknown $shortHead) + ")")
Write-Host ("  源码有未提交改动：" + (Value-OrUnknown $sourceDirty))
if ($originMain) {
  Write-Host ("  origin/main：" + $originMain + " (" + (Value-OrUnknown $shortOrigin) + ")")
}

if ($head -and $info.commit -eq $head) {
  $suffix = ""
  if ($sourceDirty) {
    $suffix = "，但源码有未提交改动"
  }
  Write-Host ("  状态：安装版本与当前 commit 一致" + $suffix)
  exit 0
}

if ($originMain -and $info.commit -eq $originMain) {
  Write-Host "  状态：安装版本与 origin/main 一致，但不同于当前 checkout"
  if ($CheckInstalled) {
    exit 1
  }
  exit 0
}

Write-Host "  状态：安装版本不同于当前 checkout"
if ($CheckInstalled) {
  exit 1
}
exit 0
