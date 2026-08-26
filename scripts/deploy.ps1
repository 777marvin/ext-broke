#Requires -Version 5.1
<#
.SYNOPSIS
  Deploys this project into the AiderDesk configuration.

.DESCRIPTION
  Copies the project to its AiderDesk target. Standalone mode (default
  when this script is vendored inside the project repo): the repo itself
  is the source.
    extensions -> ~/.aider-desk/extensions/<name>/
    agents     -> ~/.aider-desk/agents/<name>/
    skills     -> ~/.aider-desk/skills/<name>/
  By default the working tree is deployed, but only from a clean state
  (no modified or untracked files) - use -Force to override. Use -FromTag
  to deploy an exact tagged version (git archive; safe even from a dirty
  tree).
  The deploy is atomic: the previous installation is renamed to a backup
  first and only removed after the new copy completed successfully; on
  failure the previous installation is restored automatically.
  The deployed version is written to .deployed-version in the target.
  .git, node_modules and sensitive files (.env*, *.pem, *.key, *.p12,
  *.pfx, *.log, .aider*, stats.jsonl) are never copied from the working
  tree, at ANY depth (nested examples/.env is excluded too). Existing
  runtime files in the target (config.json, stats.jsonl,
  node_modules, snapshots/, and errors/ up to 100 MB) are preserved across
  the deploy.

.PARAMETER Category
  skills | extensions | agents

.PARAMETER Name
  Subproject name (folder name under the category; lowercase letters,
  digits and dashes only).

.PARAMETER FromTag
  Deploy this exact git tag (git archive) instead of the working tree.

.PARAMETER InstallDeps
  Run `npm install` in the target after copying (extensions with runtime
  deps).

.PARAMETER DryRun
  Only show what would be deployed.

.PARAMETER Force
  Skip the clean-tree check and do not ask for confirmation.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('skills', 'extensions', 'agents')]
  [string]$Category,
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [string]$FromTag = '',
  [switch]$InstallDeps,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Copy-FilteredRecursive {
  param(
    [string]$From,
    [string]$To,
    [string]$ExcludeRegex
  )
  # The exclusion list applies at EVERY depth: a nested examples/.env must
  # never leave the machine. Top-level filtering + recursive copy leaks it.
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  foreach ($child in Get-ChildItem -Path $From -Force) {
    if ($child.Name -match $ExcludeRegex) { continue }
    if ($child.PSIsContainer) {
      Copy-FilteredRecursive -From $child.FullName -To (Join-Path $To $child.Name) -ExcludeRegex $ExcludeRegex
    }
    else {
      Copy-Item -Path $child.FullName -Destination $To -Force
    }
  }
}

if ($Name -notmatch '^[a-z0-9][a-z0-9-]*$') {
  throw "Invalid name '$Name'. Use lowercase letters, digits and dashes only (e.g. 'workspace-info')."
}

$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root (Join-Path $Category $Name)
$TargetBase = Join-Path $env:USERPROFILE '.aider-desk'

# Standalone mode: when this script is vendored inside the project repo
# itself (the public ext-broke layout), the folder <root>/<category>/<name>
# does not exist - deploy the repo itself.
if (-not (Test-Path $Source)) {
  $Source = $Root
}

if (-not (Test-Path (Join-Path $Source '.git'))) {
  throw "Source is not a git repository: $Source"
}

$Target = switch ($Category) {
  'extensions' { Join-Path $TargetBase "extensions\$Name" }
  'agents'     { Join-Path $TargetBase "agents\$Name" }
  'skills'     { Join-Path $TargetBase "skills\$Name" }
}

# --- Determine version ---------------------------------------------------
Push-Location $Source
try {
  if ($FromTag) {
    $version = $FromTag
    git rev-parse --verify "$FromTag^{commit}" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Tag not found: $FromTag" }
  }
  else {
    # Clean-state check: deploys must come from a clean tree (workflow.md).
    # Ignored files (node_modules, .aider*) do not count as dirty.
    $dirty = git status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
    if ($dirty) {
      if ($Force) {
        Write-Host '[!] Working tree is not clean, continuing due to -Force.' -ForegroundColor Yellow
      }
      elseif ($DryRun) {
        Write-Host '[!] Working tree is not clean - a real deploy would refuse without -Force.' -ForegroundColor Yellow
      }
      else {
        throw 'Working tree is not clean. Commit or stash your changes first (or use -Force). Deploying unreviewed changes is not allowed.'
      }
    }
    # --always: without tags git prints the short SHA instead of failing on
    # stderr (which would abort the script under $ErrorActionPreference).
    $version = git describe --tags --always 2>$null
    if (-not $version) { $version = git rev-parse --short HEAD }
  }
} finally {
  Pop-Location
}

Write-Host "Deploying '$Name' ($version)" -ForegroundColor Cyan
Write-Host "  Source: $Source"
Write-Host "  Target: $Target"

if ($DryRun) {
  Write-Host '[dry-run] Nothing was copied.' -ForegroundColor Yellow
  exit 0
}

# --- Confirmation ---------------------------------------------------------
if (-not $Force) {
  $answer = Read-Host "Deploy '$Name' ($version) to $Target? [y/N]"
  if ($answer -notmatch '^(y|yes|j|ja)$') {
    Write-Host 'Deploy aborted.' -ForegroundColor Yellow
    exit 1
  }
}

# --- Build deployment copy ----------------------------------------------
# Files that are never deployed from the working tree: version control,
# dependencies, secrets, logs, AiderDesk project config and runtime data.
# (git archive for -FromTag only contains tracked files anyway.)
$excludeRegex = '^(\.git|node_modules|\.env(\..*)?|.+\.(pem|key|p12|pfx|log)$|\.aider.*|stats\.jsonl)$'

# GetTempPath() instead of $env:TEMP: pwsh on Linux does not set TEMP/TMP,
# and a real deploy (not just the dry run) failed there with a null path.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "aiderdesk-deploy-$Name"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null

$deployOk = $false
$swapped = $false
$backup = "$Target.old"

try {
  Push-Location $Source
  try {
    if ($FromTag) {
      # Note: never pipe git archive into tar - PowerShell corrupts binary
      # data in pipelines. Write the archive to a file first.
      $archive = Join-Path ([System.IO.Path]::GetTempPath()) "aiderdesk-deploy-$Name.tar"
      git archive --format=tar -o $archive $FromTag
      if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
      tar -xf $archive -C $tmp
      if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed' }
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
    }
    else {
      Copy-FilteredRecursive -From $Source -To $tmp -ExcludeRegex $excludeRegex
    }
  } finally {
    Pop-Location
  }

  # --- Preserve runtime state across the deploy --------------------------
  # Extensions keep runtime files (config.json, stats.jsonl) and node_modules
  # in their target; agents deploy config.json as a repo artifact, and skills
  # are read-only SKILL.md folders. So only extension targets get preserved
  # files. They are copied into the staging copy BEFORE the swap, so a deploy
  # neither wipes the user's settings nor breaks dependencies. Note: a
  # preserved file wins over a same-named file from the repo - runtime state
  # is user data by definition (extensions only).
  $preserveList = switch ($Category) {
    'extensions' { @('config.json', 'stats.jsonl', 'node_modules', 'snapshots') }
    'agents'     { @() }   # config.json is the deployable profile artifact
    'skills'     { @() }
    default      { @() }
  }
  if (Test-Path $Target) {
    foreach ($rel in $preserveList) {
      $p = Join-Path $Target $rel
      if (Test-Path $p) {
        Copy-Item -Path $p -Destination (Join-Path $tmp $rel) -Recurse -Force
      }
    }
    # The errors/ archive is preserved with a size cap: it is the only thing
    # that makes "full output saved to errors/..." references survive a
    # deploy, but it is debug data and must not drag gigabytes along.
    if ($Category -eq 'extensions') {
      $errSrc = Join-Path $Target 'errors'
      if (Test-Path $errSrc) {
        $errSize = (Get-ChildItem -Path $errSrc -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if (-not $errSize) { $errSize = 0 }
        $maxErrorsPreserveBytes = 100MB
        if ($errSize -le $maxErrorsPreserveBytes) {
          Copy-Item -Path $errSrc -Destination (Join-Path $tmp 'errors') -Recurse -Force
        }
        else {
          Write-Host "[!] errors/ archive exceeds 100 MB - not preserved across the deploy." -ForegroundColor Yellow
        }
      }
    }
    # Preserved node_modules + changed package.json = stale dependencies.
    if ($Category -eq 'extensions' -and (Test-Path (Join-Path $Target 'node_modules'))) {
      $newPkg = Join-Path $tmp 'package.json'
      $oldPkg = Join-Path $Target 'package.json'
      if ((Test-Path $newPkg) -and (Test-Path $oldPkg)) {
        if ((Get-FileHash $newPkg).Hash -ne (Get-FileHash $oldPkg).Hash) {
          Write-Host '[!] package.json changed but node_modules are preserved. Run with -InstallDeps to refresh dependencies.' -ForegroundColor Yellow
        }
      }
    }
  }

  # --- Atomic swap --------------------------------------------------------
  # The target's parent chain must exist before the copy (fresh machines,
  # CI profiles): Copy-Item does not create missing parent directories.
  New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
  # Recover from an earlier interrupted deploy first: a leftover backup with
  # no target means the previous run crashed between rename and copy.
  if (Test-Path $backup) {
    if (Test-Path $Target) {
      # Stale backup; the current target is the newer state.
      Remove-Item $backup -Recurse -Force
    }
    else {
      Rename-Item -Path $backup -NewName (Split-Path $Target -Leaf)
    }
  }
  if (Test-Path $Target) {
    Rename-Item -Path $Target -NewName (Split-Path $backup -Leaf)
    $swapped = $true
  }

  try {
    Copy-Item -Path $tmp -Destination $Target -Recurse -Force
    if (-not (Test-Path $Target)) { throw 'Deploy copy failed (target missing after copy)' }
  }
  catch {
    # The copy failed - restore the previous installation immediately.
    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
    if (Test-Path $backup) { Rename-Item -Path $backup -NewName (Split-Path $Target -Leaf) }
    $swapped = $false
    throw
  }

  Write-Utf8NoBom (Join-Path $Target '.deployed-version') $version

  if ($InstallDeps) {
    Write-Host '[deps] Running npm install in target...' -ForegroundColor Yellow
    Push-Location $Target
    try {
      npm install --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    } finally {
      Pop-Location
    }
  }

  # Success - drop the previous installation.
  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
  $deployOk = $true
}
catch {
  if ($swapped) {
    try {
      if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
      if (Test-Path $backup) { Rename-Item -Path $backup -NewName (Split-Path $Target -Leaf) }
      Write-Host '[!] Deploy failed - previous installation restored.' -ForegroundColor Yellow
    }
    catch {
      Write-Host "[!] Deploy failed and rollback failed: $_ (backup kept at: $backup)" -ForegroundColor Red
    }
  }
  throw
}
finally {
  if ($deployOk) {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  else {
    Write-Host "[!] Staging copy preserved for inspection: $tmp" -ForegroundColor Yellow
  }
}

Write-Host "[ok] Deployed $version to $Target" -ForegroundColor Green
Write-Host "Rollback: .\scripts\deploy.ps1 -Category $Category -Name $Name -FromTag <previous-tag>" -ForegroundColor Yellow
