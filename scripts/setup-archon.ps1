Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path -LiteralPath ".env") -and (Test-Path -LiteralPath ".env.example")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
    Write-Host "created .env from .env.example"
}

function Test-ArchonSafeEnvKey {
    param([Parameter(Mandatory = $true)][string]$Name)

    return $Name -match '^ARCHON_[A-Z0-9_]+$'
}

function Trim-ArchonLeadingWhitespace {
    param([Parameter(Mandatory = $true)][string]$Value)

    return ($Value -replace '^\s+', '')
}

function Trim-ArchonTrailingWhitespace {
    param([Parameter(Mandatory = $true)][string]$Value)

    return ($Value -replace '\s+$', '')
}

function Strip-ArchonUnquotedComment {
    param([Parameter(Mandatory = $true)][string]$Value)

    $builder = [System.Text.StringBuilder]::new()
    $previousWasWhitespace = $false

    for ($i = 0; $i -lt $Value.Length; $i++) {
        $ch = $Value[$i]
        if ($ch -eq '#' -and ($builder.Length -eq 0 -or $previousWasWhitespace)) {
            break
        }

        [void]$builder.Append($ch)
        $previousWasWhitespace = [char]::IsWhiteSpace($ch)
    }

    return (Trim-ArchonTrailingWhitespace $builder.ToString())
}

function Unescape-ArchonDoubleQuotedValue {
    param([Parameter(Mandatory = $true)][string]$Value)

    $Value = $Value.Replace('\\', '\')
    $Value = $Value.Replace('\"', '"')
    $Value = $Value.Replace('\n', "`n")
    $Value = $Value.Replace('\r', "`r")
    $Value = $Value.Replace('\t', "`t")
    $Value = $Value.Replace('\$', '$')

    return $Value
}

function Import-ArchonEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.TrimEnd()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
            return
        }

        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $name = $Matches[1]
            if (Test-ArchonSafeEnvKey -Name $name) {
                if (Test-Path -LiteralPath "Env:$name") {
                    return
                }
                $value = Trim-ArchonLeadingWhitespace $Matches[2]
                if ($value -match '^"((?:\\.|[^"])*)"(?:\s+#.*)?$') {
                    $value = Unescape-ArchonDoubleQuotedValue $Matches[1]
                } elseif ($value -match "^'([^']*)'(?:\s+#.*)?$") {
                    $value = $Matches[1]
                } else {
                    $value = Strip-ArchonUnquotedComment $value
                }

                Set-Item -Path "Env:$name" -Value $value
            }
        }
    }
}

Import-ArchonEnvFile -Path ".env"

function Resolve-ArchonNpmScript {
    param(
        [Parameter(Mandatory = $true)][string]$Preferred,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    $packageJson = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
    $scriptNames = @()
    if ($null -ne $packageJson.scripts) {
        $scriptNames = $packageJson.scripts.PSObject.Properties.Name
    }

    if ($scriptNames -contains $Preferred) {
        return $Preferred
    }

    if ($scriptNames -contains $Fallback) {
        return $Fallback
    }

    throw "missing npm script aliases: $Preferred or $Fallback"
}

function Invoke-ArchonNpmScript {
    param(
        [Parameter(Mandatory = $true)][string]$Preferred,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    $scriptName = Resolve-ArchonNpmScript -Preferred $Preferred -Fallback $Fallback
    npm run $scriptName
}

function Test-ArchonScript {
    param(
        [Parameter(Mandatory = $true)][string]$Preferred,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    try {
        [void](Resolve-ArchonNpmScript -Preferred $Preferred -Fallback $Fallback)
        return $true
    } catch {
        return $false
    }
}

function Resolve-ArchonRuntimeModeFromProfile {
    param([string]$Profile)

    switch ($Profile.ToLowerInvariant()) {
        "local-docker" { return "docker" }
        "local-native" { return "native" }
        "managed" { return "managed" }
        default { return $null }
    }
}

function Resolve-ArchonRuntimeProfile {
    param([Parameter(Mandatory = $true)][string]$Mode)

    switch ($Mode) {
        "docker" { return "local-docker" }
        "native" { return "local-native" }
        "managed" { return "managed" }
        default { throw "unsupported runtime mode: $Mode" }
    }
}

function Test-ArchonDockerAvailable {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        return $false
    }

    try {
        docker version | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Resolve-ArchonRuntimeMode {
    $requested = if ($env:ARCHON_RUNTIME_MODE) { $env:ARCHON_RUNTIME_MODE.ToLowerInvariant() } else { "auto" }
    switch ($requested) {
        "docker" { return "docker" }
        "native" { return "native" }
        "managed" { return "managed" }
        "auto" {
            if ($env:ARCHON_RUNTIME_PROFILE) {
                $derived = Resolve-ArchonRuntimeModeFromProfile -Profile $env:ARCHON_RUNTIME_PROFILE
                if ($derived -and $derived -ne "docker") {
                    return $derived
                }
            }
            if (Test-ArchonDockerAvailable) {
                return "docker"
            }
            throw "docker runtime is unavailable and native fallback is only supported on Linux/WSL; use ARCHON_RUNTIME_MODE=managed or run the Unix setup path"
        }
        default {
            throw "invalid ARCHON_RUNTIME_MODE: $requested"
        }
    }
}

if (-not $env:ARCHON_PROJECT_REPO_PATH -or $env:ARCHON_PROJECT_REPO_PATH -eq "/absolute/path/to/repo") {
    $env:ARCHON_PROJECT_REPO_PATH = $repoRoot
}

if (-not $env:ARCHON_PROJECT_SLUG) {
    $env:ARCHON_PROJECT_SLUG = (Split-Path -Leaf $repoRoot).ToLowerInvariant()
}

if (-not $env:ARCHON_PROJECT_NAME) {
    $env:ARCHON_PROJECT_NAME = $env:ARCHON_PROJECT_SLUG
}

if (-not $env:ARCHON_WORKSPACE_SLUG) {
    $env:ARCHON_WORKSPACE_SLUG = "default"
}

if (-not $env:ARCHON_WORKSPACE_NAME) {
    $env:ARCHON_WORKSPACE_NAME = "Default Workspace"
}

if (-not $env:ARCHON_DOCKER_CONTAINER_NAME) {
    $env:ARCHON_DOCKER_CONTAINER_NAME = "archon-postgres-$($env:ARCHON_PROJECT_SLUG)"
}

if (-not $env:ARCHON_POSTGRES_PASSWORD -or $env:ARCHON_POSTGRES_PASSWORD -eq "archon") {
    throw "ARCHON_POSTGRES_PASSWORD must be set to a non-default local password before setup continues"
}

if (-not $env:ARCHON_POSTGRES_PORT) {
    $env:ARCHON_POSTGRES_PORT = "5432"
}

if (-not $env:ARCHON_CORE_DATABASE_URL) {
    $postgresUser = if ($env:ARCHON_POSTGRES_USER) { $env:ARCHON_POSTGRES_USER } else { "archon" }
    $postgresDb = if ($env:ARCHON_POSTGRES_DB) { $env:ARCHON_POSTGRES_DB } else { "archon" }
    $env:ARCHON_CORE_DATABASE_URL = "postgres://${postgresUser}:$($env:ARCHON_POSTGRES_PASSWORD)@127.0.0.1:$($env:ARCHON_POSTGRES_PORT)/$postgresDb"
}

function Wait-ArchonContainerHealth {
    param(
        [Parameter(Mandatory = $true)][string]$ContainerName,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Write-Host "waiting for $Label to become healthy"
    for ($i = 0; $i -lt 60; $i++) {
        $status = ""
        try {
            $status = docker inspect -f "{{.State.Health.Status}}" $ContainerName 2>$null
        } catch {
            $status = ""
        }

        if ($status -eq "healthy") {
            return
        }

        Start-Sleep -Seconds 2
    }

    docker logs $ContainerName --tail 100
    throw "$Label did not become healthy"
}


$runtimeMode = Resolve-ArchonRuntimeMode
$env:ARCHON_RUNTIME_MODE = $runtimeMode
$env:ARCHON_RUNTIME_PROFILE = Resolve-ArchonRuntimeProfile -Mode $runtimeMode

switch ($runtimeMode) {
    "docker" {
        if (-not (Test-ArchonDockerAvailable)) {
            throw "docker runtime mode selected but Docker is not available; use ARCHON_RUNTIME_MODE=managed or run the Unix setup path for native fallback"
        }

        docker compose up -d archon-postgres

        Wait-ArchonContainerHealth -ContainerName $env:ARCHON_DOCKER_CONTAINER_NAME -Label "archon-postgres"
    }
    "managed" {
    }
    "native" {
        throw "native runtime mode is only supported through the Unix/Linux setup path; use WSL bash setup or managed mode"
    }
}

if (-not (Test-Path -LiteralPath "node_modules")) {
    npm install
}

if ((Test-Path -LiteralPath ".archon/install-manifest.json")) {
    try {
        git rev-parse --show-toplevel | Out-Null
        npm run archon:setup:git-guard
    } catch {
    }
}

if (Test-ArchonScript -Preferred "archon:setup:playwright" -Fallback "setup:playwright") {
    npm run archon:setup:playwright
}

Invoke-ArchonNpmScript -Preferred "archon:migrate" -Fallback "migrate"
Invoke-ArchonNpmScript -Preferred "archon:bootstrap" -Fallback "bootstrap"
if (Test-Path -LiteralPath ".archon/work/task-queue.json") {
    npm run archon:repair-task-queue
}
npm run archon:refresh-repo-context
npm run archon:refresh-retrieval:fast
Invoke-ArchonNpmScript -Preferred "archon:verify:setup" -Fallback "verify:setup"
if (Test-ArchonScript -Preferred "archon:verify:playwright" -Fallback "verify:playwright") {
    npm run archon:verify:playwright
}

Write-Host ""
Write-Host "archon local setup complete"
Write-Host "runtime mode: $runtimeMode"
Write-Host "workspace: $($env:ARCHON_WORKSPACE_SLUG)"
Write-Host "project: $($env:ARCHON_PROJECT_SLUG)"
Write-Host "database: configured"
Write-Host "playwright: configured"
