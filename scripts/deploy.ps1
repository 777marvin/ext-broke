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
  first and only removed after the commit marker (.deployed-version) was
  written and verified; on failure the previous installation is restored
  automatically (BRK-012). Runtime data that exceeds its preserve cap is
  MOVED to an update-recovery directory next to the target instead of
  being deleted with the backup (BRK-004/BRK-011).
  The payload is built from the GIT MANIFEST (git ls-files): only tracked
  files ship, so untracked runtime/private data (errors/, snapshots/,
  index/, logs) can never leave the machine (BRK-011). On top of that,
  sensitive files (.env*, *.pem, *.key, *.p12, *.pfx, *.log, .aider*,
  stats.jsonl) are excluded at every depth as defense in depth.
  Existing runtime files in the target (config.json, stats.jsonl,
  node_modules, snapshots/, index/, and errors/ up to 100 MB) are
  preserved across the deploy.

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

function Copy-GitManifest {
  param(
    [string]$From,
    [string]$To,
    [string]$ExcludeRegex
  )
  # BRK-011 (external review 2026-08-29): the payload is built from the GIT
  # MANIFEST (tracked files only). Untracked runtime/private data that lives
  # in the working tree (errors/, snapshots/, index/, measure.jsonl, logs)
  # can therefore never leave the machine - the old negative-filter recursive
  # copy shipped exactly those. The exclude regex stays as defense in depth.
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  Push-Location $From
  try {
    $files = git ls-files -z
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
    foreach ($rel in ($files -split "`0" | Where-Object { $_ -ne '' })) {
      if ($rel -match $ExcludeRegex) { continue }
      $dest = Join-Path $To $rel
      $destDir = Split-Path $dest -Parent
      if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
      Copy-Item -Path (Join-Path $From $rel) -Destination $dest -Force
    }
  }
  finally {
    Pop-Location
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
# Files that are never deployed even if tracked (defense in depth on top of
# the git manifest): secrets, key material, logs, AiderDesk project config
# and runtime data (errors/, snapshots/, index/, measure.jsonl).
$excludeRegex = '^(\.git|node_modules|\.env(\..*)?|.+\.(pem|key|p12|pfx|log)$|\.aider.*|stats\.jsonl|measure\.jsonl$|^(errors|snapshots|index)(\\|/|$))'

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
      Copy-GitManifest -From $Source -To $tmp -ExcludeRegex $excludeRegex
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
    'extensions' { @('config.json', 'stats.jsonl', 'node_modules', 'snapshots', 'index') }
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
          # BRK-004/BRK-011 parity with the updater: oversized runtime data is
          # MOVED to a recovery directory next to the target - never deleted
          # with the backup after a successful deploy.
          $recovery = Join-Path (Split-Path $Target -Parent) ("update-recovery-" + (Get-Date -Format "yyyy-MM-ddTHH-mm-ss"))
          New-Item -ItemType Directory -Path $recovery -Force | Out-Null
          Move-Item -Path $errSrc -Destination (Join-Path $recovery 'errors') -Force
          Write-Host "[!] errors/ archive exceeds 100 MB - moved to $recovery (not deleted)." -ForegroundColor Yellow
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
  # Recover from an earlier interrupted deploy first (BRK-012): the commit
  # marker decides, not "target exists -> newer". A target WITHOUT
  # .deployed-version is a partial copy from a crashed deploy - the backup
  # holds the good installation and is restored.
  if (Test-Path $backup) {
    $targetIsCommitted = Test-Path (Join-Path $Target '.deployed-version')
    if (Test-Path $Target) {
      if ($targetIsCommitted) {
        # Committed previous deploy; the backup is a locked leftover.
        Remove-Item $backup -Recurse -Force
      }
      else {
        # Previous deploy died mid-copy: restore the good backup over it.
        Remove-Item $Target -Recurse -Force
        Rename-Item -Path $backup -NewName (Split-Path $Target -Leaf)
      }
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
  # BRK-012: the commit marker is the transaction boundary - verify it before
  # anything destructive (backup deletion) may happen.
  if (-not (Test-Path (Join-Path $Target '.deployed-version'))) { throw 'commit marker missing after write' }

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
