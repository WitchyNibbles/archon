# install-archon.ps1 — thin shim that delegates to the compiled archon bin.
#
# This script works in two contexts:
#   (a) Inside the archon source repo (dev): $repoRoot\dist\cli\archon-bin.js
#       must exist.  Run 'npm run build:dist' first if it does not.
#   (b) Installed in a consumer project as node_modules\archon\scripts\:
#       the package always ships dist\**, so the bin is always present.
#
# The shim invokes the compiled bin only — no TypeScript source flags needed.
# All installer flags (--with-grafana, --with-obsidian, ...) are forwarded
# as additional positional arguments after the mandatory -TargetPath.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$TargetPath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AdditionalArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
# Use GetFullPath instead of Resolve-Path so the shim does not throw when the
# target directory does not yet exist.  Resolve-Path requires the path to exist
# under $ErrorActionPreference="Stop"; GetFullPath resolves without I/O and lets
# the CLI emit the meaningful error if the path is invalid.
$resolvedTarget = [System.IO.Path]::GetFullPath($TargetPath)
$bin = Join-Path $repoRoot "dist\cli\archon-bin.js"

if (-not (Test-Path -LiteralPath $bin)) {
    Write-Error "compiled bin not found at $bin`n  (run 'npm run build:dist' in the archon repo and then retry)"
    exit 1
}

$extraArgs = if ($AdditionalArgs) { $AdditionalArgs } else { @() }
$argList = @("init", "--apply", "--target", $resolvedTarget) + $extraArgs
& node $bin @argList
exit $LASTEXITCODE
