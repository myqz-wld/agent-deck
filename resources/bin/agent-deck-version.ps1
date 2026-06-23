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

  if ($null -eq $Value) {
    return "unknown"
  }
  $text = [string]$Value
  if ($text.Length -eq 0) {
    return "unknown"
  }
  return $text
}

$appRoot = Split-Path $AppExe -Parent
$buildInfoPath = Join-Path $appRoot "resources\build-info.json"

if (!(Test-Path $buildInfoPath)) {
  Write-Host "Agent Deck: build-info.json not found"
  Write-Host ("  path: " + $buildInfoPath)
  Write-Host "  hint: this installed package is older or was not built with the current packaging script."
  if ($CheckInstalled) {
    exit 2
  }
  exit 0
}

$info = Get-Content -Raw $buildInfoPath | ConvertFrom-Json

Write-Host ("Agent Deck " + (Value-OrUnknown $info.version))
Write-Host ("  installed commit: " + (Value-OrUnknown $info.commit) + " (" + (Value-OrUnknown $info.shortCommit) + ")")
Write-Host ("  installed branch: " + (Value-OrUnknown $info.branch))
Write-Host ("  installed dirty: " + (Value-OrUnknown $info.dirty))
Write-Host ("  built at: " + (Value-OrUnknown $info.builtAt))

$repo = Find-SourceRepo
if (!$repo) {
  Write-Host "  status: no agent-deck source checkout found under current directory"
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

Write-Host ("  source checkout: " + $repo)
Write-Host ("  source HEAD: " + (Value-OrUnknown $head) + " (" + (Value-OrUnknown $shortHead) + ")")
Write-Host ("  source dirty: " + $sourceDirty)
if ($originMain) {
  Write-Host ("  origin/main: " + $originMain + " (" + (Value-OrUnknown $shortOrigin) + ")")
}

if ($head -and $info.commit -eq $head) {
  $suffix = ""
  if ($sourceDirty) {
    $suffix = "; source checkout has uncommitted changes"
  }
  Write-Host ("  status: installed build matches this checkout commit" + $suffix)
  exit 0
}

if ($originMain -and $info.commit -eq $originMain) {
  Write-Host "  status: installed build matches origin/main but differs from this checkout"
  if ($CheckInstalled) {
    exit 1
  }
  exit 0
}

Write-Host "  status: installed build differs from this checkout"
if ($CheckInstalled) {
  exit 1
}
exit 0
