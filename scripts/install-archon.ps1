param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$resolvedTarget = (Resolve-Path -LiteralPath $TargetPath).Path

node --experimental-strip-types src/install/cli.ts --target $resolvedTarget
