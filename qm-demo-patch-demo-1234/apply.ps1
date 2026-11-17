param(
  [string]$Repo = '.',
  [switch]$DryRun,
  [switch]$ResetAuthor
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { [Console]::Error.WriteLine('QM apply: git is not installed or not on PATH'); exit 4 }
$root = Split-Path -Parent (Split-Path -Parent $git.Source)
$sh = Join-Path $root 'bin\sh.exe'
if (-not (Test-Path $sh)) { $sh = Join-Path $root 'usr\bin\sh.exe' }
if (-not (Test-Path $sh)) { [Console]::Error.WriteLine('QM apply: sh.exe of Git for Windows not found'); exit 4 }
$repoFull = (Resolve-Path -LiteralPath $Repo).Path.Replace('\', '/')
$argList = @('apply.sh', '--repo', $repoFull)
if ($DryRun) { $argList += '--dry-run' }
if ($ResetAuthor) { $argList += '--reset-author' }
Push-Location $here
try {
  & $sh @argList
  $rc = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $rc
