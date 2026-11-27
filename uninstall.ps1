# Run as a script, not in the caller's scope: exit must only exit this script.
if ($MyInvocation.InvocationName -eq '.') { throw 'Invoke .\uninstall.ps1 without dot-sourcing it.' }
$ErrorActionPreference = 'Stop'
$usage = 'Usage: .\uninstall.ps1 [-DryRun] [-AllHomes] [-Help]'
$options = @()
$helpRequested = $false
foreach ($arg in $args) {
  if ($arg -is [string] -and $arg -in '-DryRun', '-AllHomes') {
    if ($arg -notin $options) { $options += $arg }
  } elseif ($arg -is [string] -and $arg -eq '-Help') {
    $helpRequested = $true
  } else {
    [Console]::Error.WriteLine("error: unknown argument: $arg")
    [Console]::Error.WriteLine($usage)
    exit 2
  }
}
if ($helpRequested) { Write-Output $usage; exit 0 }

# A fresh -File process returns the installer's exit code even when it throws
# or finishes normally without setting LASTEXITCODE in the caller's scope.
$shellName = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh' }
$shell = Join-Path $PSHOME $shellName
$installer = Join-Path $PSScriptRoot 'install.ps1'
$PSNativeCommandUseErrorActionPreference = $false
& $shell -NoProfile -NonInteractive -File $installer uninstall @options
exit $LASTEXITCODE
