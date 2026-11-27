# Install or remove keepgoing as a personal Pi package (Windows).
# Usage: .\install.ps1 [install|uninstall|status] [-DryRun] [-AllHomes]
# -AllHomes runs the action in every Pi home found at ~/.pi/agent and ~/.pi-*/agent.
param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install',
  [switch]$DryRun,
  [switch]$AllHomes
)
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path -LiteralPath $PSScriptRoot).Path

function Info([string]$Message) { Write-Host "==> $Message" }

# Top-level "version" string in package.json, or 'unknown' when it cannot be read.
function Get-PackageVersion {
  try {
    $version = (Get-Content -Raw (Join-Path $Root 'package.json') | ConvertFrom-Json).version
  } catch {
    $version = $null
  }
  if ($version) { return [string]$version }
  return 'unknown'
}

# -AllHomes children inherit KEEPGOING_INSTALL_CHILD so the version prints once.
$PackageVersion = Get-PackageVersion
if (-not $env:KEEPGOING_INSTALL_CHILD) { Info "keepgoing $PackageVersion" }

function Invoke-Step([string[]]$Command) {
  if ($DryRun) {
    Write-Host "[dry-run] $($Command -join ' ')"
    return
  }
  & $Command[0] $Command[1..($Command.Length - 1)]
  if ($LASTEXITCODE -ne 0) { throw "command failed: $($Command -join ' ')" }
}

# Display-only lookup for install/status; not a safe removal operand.
function Get-InstalledSource($lines) {
  $personal = $false
  $source = $null
  foreach ($line in $lines) {
    if ($line -eq 'User packages:') { $personal = $true; continue }
    if ($line -match '^\S') { $personal = $false }
    if (-not $personal) { continue }
    if ($line -match '^  (\S.*)$') {
      $source = $Matches[1]
      if ($source -eq $Root) { return $source }
    } elseif ($line -match '^    (\S.*)$' -and $Matches[1] -eq $Root) {
      return $source
    }
  }
  return $null
}

function Expand-PiPath([string]$Path) {
  if ($Path -ceq '~') { return $HOME }
  if ($Path.StartsWith('~/') -or ($windowsPaths -and $Path.StartsWith('~\'))) {
    return [IO.Path]::Combine($HOME, $Path.Substring(2))
  }
  if ($Path.StartsWith('file://')) { return ([Uri]$Path).LocalPath }
  return $Path
}

function Get-LocalLabelPath([string]$Label) {
  if (-not $Label -or $Label -cmatch '^[\s\uFEFF]|[\s\uFEFF]$|[\x00-\x1f\x7f]') { return }
  if ($Label -match '^[\w+.-]+:' -and -not $Label.StartsWith('file://') -and
      -not ($windowsPaths -and $Label -match '^[a-z]:[\\/]')) { return }
  try { return [IO.Path]::GetFullPath([IO.Path]::Combine($base, (Expand-PiPath $Label))) } catch { return }
}

# Resolve-Path is lexical, even for junctions. Use the device/file ID from a
# followed stat, including links in parent directories. Batch only listed paths;
# neither canonical names nor package display labels are sent to pi remove.
function Assert-NoCheckoutAlias($reported, $possible) {
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'node not found; cannot verify checkout identity' }
  $check = @'
const fs = require('node:fs'), path = require('node:path');
try {
  const { root, reported, possible } = JSON.parse(fs.readFileSync(0, 'utf8'));
  function identity(p) {
    const { dev, ino } = fs.statSync(p, { bigint: true });
    if (!ino) process.exit(1);
    return `${dev}:${ino}`;
  }
  const checkout = identity(root);
  function rejectAlias(p, installed) {
    if (!path.isAbsolute(p)) process.exit(1);
    if (p === root) return;
    try { if (identity(p) === checkout) process.exit(1); }
    catch (e) { if (installed || !['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
  }
  for (const p of reported) rejectAlias(p, true);
  for (const p of possible) rejectAlias(p, false);
} catch { process.exit(1); }
'@
  $OutputEncoding = [Text.UTF8Encoding]::new($false)
  $PSNativeCommandUseErrorActionPreference = $false
  @{ root = $Root; reported = $reported.ToArray(); possible = $possible.ToArray() } |
    ConvertTo-Json -Compress | & $node.Source -e $check
  if ($LASTEXITCODE -ne 0) { throw $unsafe }
}

# Confirm both the installed path and its preceding personal label. A filtered
# display label is not a CLI operand. Pi resolves stored paths from the agent dir.
function Get-RemovalTarget($lines) {
  $unsafe = 'unsafe or ambiguous checkout identity; no package changes made'
  $windowsPaths = [IO.Path]::DirectorySeparatorChar -eq '\'
  $comparison = if ($windowsPaths) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  if (-not [IO.Path]::IsPathRooted($Root) -or $Root -cmatch '[\s\uFEFF]$|[\x00-\x1f\x7f]') { throw $unsafe }
  # Batch-file shims can re-interpret cmd metacharacters during native invocation.
  if ($windowsPaths -and (Get-Command pi).Source -match '\.(cmd|bat)$' -and $Root -match '[%&!^|<>()"]') { throw $unsafe }
  $base = if ($env:PI_CODING_AGENT_DIR) { Expand-PiPath $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi/agent' }
  $base = [IO.Path]::Combine($PWD.ProviderPath, $base)
  $personal = $false; $confirmed = 0; $personalPaths = 0; $paths = 0
  $reported = [Collections.Generic.List[string]]::new()
  $possible = [Collections.Generic.List[string]]::new()
  $rows = @($lines)
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $line = $rows[$i]
    if ($line -cmatch '^\S') { $personal = $line -ceq 'User packages:' }
    if ([string]::Equals($line, "    $Root", $comparison)) { $paths++; if ($personal) { $personalPaths++ } }
    if ($personal -and $line -cmatch '^    (\S.*)$' -and [IO.Path]::IsPathRooted($Matches[1])) { $reported.Add($Matches[1]) }
    if (-not $personal -or $line -cnotmatch '^  \S') { continue }
    $label = $line.Substring(2)
    $installed = if ($rows[$i + 1] -cmatch '^    (\S.*)$') { $Matches[1] }
    if ($installed -and -not [IO.Path]::IsPathRooted($installed)) { throw $unsafe }
    $suffix = ' (filtered)'
    $candidates = @(
      Get-LocalLabelPath $label
      if ($label.EndsWith($suffix)) { Get-LocalLabelPath $label.Substring(0, $label.Length - $suffix.Length) }
    )
    $namesRoot = $false; $namesInstalled = $false
    foreach ($p in $candidates) {
      if ([string]::Equals($p, $Root, $comparison)) { $namesRoot = $true }
      if ([string]::Equals($p, $installed, $comparison)) { $namesInstalled = $true }
    }
    if (-not $namesInstalled) { foreach ($p in $candidates) { $possible.Add($p) } }
    $here = [string]::Equals($installed, $Root, $comparison)
    # Pi folds case on Windows, even inside a case-sensitive directory. Do not
    # remove a differently spelled checkout merely because Pi would match it.
    if ($here -and -not [string]::Equals($installed, $Root, [StringComparison]::Ordinal)) { throw $unsafe }
    if (-not $here -and -not $namesRoot) { continue }
    if (-not $namesInstalled) { throw $unsafe }
    if ($here) { $confirmed++ }
  }
  if ($confirmed -ne $personalPaths -or ($confirmed -and $paths -ne 1)) { throw $unsafe }
  Assert-NoCheckoutAlias $reported $possible
  if ($confirmed) { return $Root }
}

# Each Pi home (for example the ODD lanes ~/.pi-opus) keeps its own package list,
# so run this script once per home with PI_CODING_AGENT_DIR pointing at it.
if ($AllHomes) {
  if ($env:PI_CODING_AGENT_DIR) {
    [Console]::Error.WriteLine('error: -AllHomes cannot be combined with PI_CODING_AGENT_DIR')
    exit 2
  }
  $homes = @()
  $defaultHome = Join-Path (Join-Path $HOME '.pi') 'agent'
  if (Test-Path -LiteralPath $defaultHome -PathType Container) { $homes += $defaultHome }
  $laneDirs = Get-ChildItem -LiteralPath $HOME -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.pi-*' } | Sort-Object Name
  foreach ($laneDir in $laneDirs) {
    $laneHome = Join-Path $laneDir.FullName 'agent'
    if (Test-Path -LiteralPath $laneHome -PathType Container) { $homes += $laneHome }
  }
  if ($homes.Count -eq 0) {
    [Console]::Error.WriteLine("error: no Pi homes found (looked for $(Join-Path (Join-Path $HOME '.pi') 'agent') and $(Join-Path (Join-Path $HOME '.pi-*') 'agent'))")
    exit 1
  }
  # Run each home in a fresh PowerShell process so a failing home cannot stop the loop;
  # a non-zero child exit is read from $LASTEXITCODE instead of raising (PowerShell 7.3+).
  $PSNativeCommandUseErrorActionPreference = $false
  $shell = (Get-Process -Id $PID).Path
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, $Action)
  if ($DryRun) { $childArgs += '-DryRun' }
  $previousChild = $env:KEEPGOING_INSTALL_CHILD
  $failed = @()
  try {
    $env:KEEPGOING_INSTALL_CHILD = '1'
    foreach ($dir in $homes) {
      Info "Pi home: $dir"
      $env:PI_CODING_AGENT_DIR = $dir
      & $shell @childArgs
      if ($LASTEXITCODE -ne 0) { $failed += $dir }
    }
  } finally {
    Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
    if ($previousChild) { $env:KEEPGOING_INSTALL_CHILD = $previousChild }
    else { Remove-Item Env:KEEPGOING_INSTALL_CHILD -ErrorAction SilentlyContinue }
  }
  if ($failed.Count -gt 0) {
    [Console]::Error.WriteLine("error: $($failed.Count) of $($homes.Count) Pi homes failed: $($failed -join ' ')")
    exit 1
  }
  Info "$($homes.Count) Pi homes processed"
  exit 0
}

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { throw 'pi CLI not found in PATH' }
if (-not (Test-Path (Join-Path $Root 'extensions\keepgoing.ts'))) {
  throw 'run this script from inside the keepgoing checkout'
}

$listArgs = @('list')
if ($Action -eq 'uninstall') { $listArgs += '--no-approve' }
$lines = & pi @listArgs
if ($LASTEXITCODE -ne 0) { throw 'pi list failed; no package changes made' }
$Source = if ($Action -eq 'uninstall') { Get-RemovalTarget $lines } else { Get-InstalledSource $lines }

switch ($Action) {
  'status' {
    if ($Source) { Info "keepgoing is installed from $Root" }
    else { Info "keepgoing is not installed from $Root" }
  }
  'install' {
    if (-not (Get-Command powershell -ErrorAction SilentlyContinue)) {
      throw 'powershell.exe not found; the sleep-inhibition helper requires it'
    }
    if ($Source) {
      Info "keepgoing already installed from $Root"
    } else {
      Info "installing keepgoing $PackageVersion from $Root"
      Invoke-Step @('pi', 'install', $Root)
    }
    Info 'done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.'
    Info "keep this checkout in place: Pi loads the package from $Root"
  }
  'uninstall' {
    if ($Source) {
      Info "removing keepgoing $PackageVersion ($Root)"
      Invoke-Step @('pi', 'remove', $Root, '--no-approve')
      Info 'done. Restart Pi (or run /reload).'
    } else {
      Info "keepgoing is not installed from $Root; nothing to do"
    }
  }
}
