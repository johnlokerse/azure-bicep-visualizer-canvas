[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repository = "johnlokerse/azure-bicep-visualizer-canvas"
$ref = if ($env:BICEP_VISUALIZER_REF) { $env:BICEP_VISUALIZER_REF } else { "main" }
$work = $null
$stage = $null
$backup = $null

try {
    if ($env:BICEP_VISUALIZER_SOURCE) {
        $sourceRoot = [IO.Path]::GetFullPath($env:BICEP_VISUALIZER_SOURCE)
    } elseif ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "extension\extension.mjs"))) {
        $sourceRoot = $PSScriptRoot
    } else {
        $work = Join-Path ([IO.Path]::GetTempPath()) ("bicep-visualizer-source-" + [Guid]::NewGuid())
        New-Item -ItemType Directory -Path $work | Out-Null
        $archive = Join-Path $work "source.zip"
        Write-Host "Downloading $repository at $ref..."
        Invoke-WebRequest -Uri "https://github.com/$repository/archive/$ref.zip" -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $work
        $sourceRoot = (Get-ChildItem -LiteralPath $work -Directory | Select-Object -First 1).FullName
    }

    if (-not (Test-Path (Join-Path $sourceRoot "extension\extension.mjs")) `
        -or -not (Test-Path (Join-Path $sourceRoot "extension\bootstrap.mjs"))) {
        throw "The downloaded source is missing the canvas extension."
    }

    $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME ".copilot" }
    $parent = Join-Path $copilotHome "extensions"
    $target = Join-Path $parent "bicep-visualizer"
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (-not (Test-Path $target)) {
        $interrupted = Get-ChildItem -LiteralPath $parent -Directory -Force -Filter ".bicep-visualizer.backup.*" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($interrupted) {
            Write-Host "Recovering an interrupted Bicep Visualizer update..."
            Move-Item -LiteralPath $interrupted.FullName -Destination $target
        }
    }
    $stage = Join-Path $parent (".bicep-visualizer.install." + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $stage | Out-Null
    $payload = Get-ChildItem -LiteralPath (Join-Path $sourceRoot "extension") -Force
    if ($payload.Where({ -not $_.PSIsContainer }).Count -ne $payload.Count) {
        throw "The extension payload must contain only top-level text files."
    }
    Copy-Item -Force $payload.FullName $stage

    if (Test-Path (Join-Path $target "artifacts")) {
        $legacyState = if ($env:BICEP_VISUALIZER_STATE) { $env:BICEP_VISUALIZER_STATE } else { Join-Path $copilotHome "state\bicep-visualizer" }
        New-Item -ItemType Directory -Force -Path $legacyState | Out-Null
        Copy-Item -Recurse -Force (Join-Path $target "artifacts\*") $legacyState
    }

    $backup = Join-Path $parent (".bicep-visualizer.backup." + [Guid]::NewGuid())
    if (Test-Path $target) {
        Move-Item -LiteralPath $target -Destination $backup
    }
    try {
        Move-Item -LiteralPath $stage -Destination $target
        $stage = $null
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $backup
        $backup = $null
    } catch {
        if (Test-Path $backup) {
            Move-Item -LiteralPath $backup -Destination $target
        }
        throw
    }

    Write-Host ""
    Write-Host "Installed Bicep Visualizer at $target"
    Write-Host "Reload extensions in GitHub Copilot, or restart the app. The first launch downloads the pinned Azure Bicep runtime."
} finally {
    if ($backup -and (Test-Path $backup) -and -not (Test-Path $target)) {
        Move-Item -LiteralPath $backup -Destination $target
    }
    if ($stage -and (Test-Path $stage)) {
        Remove-Item -Recurse -Force $stage
    }
    if ($work -and (Test-Path $work)) {
        Remove-Item -Recurse -Force $work
    }
}
