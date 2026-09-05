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

    $bootstrap = Join-Path $sourceRoot "scripts\bootstrap-vendor.ps1"
    if (-not (Test-Path (Join-Path $sourceRoot "extension\extension.mjs")) -or -not (Test-Path $bootstrap)) {
        throw "The downloaded source is missing the extension or bootstrap script."
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
    $files = @(
        "extension.mjs", "server.mjs", "language-server.mjs",
        "bridge.js", "shell.js", "index.html", "graph.html", "graph.css", "shell.css",
        "copilot-extension.json", "provenance.json"
    )
    foreach ($file in $files) {
        Copy-Item -Force (Join-Path $sourceRoot "extension\$file") (Join-Path $stage $file)
    }
    New-Item -ItemType Directory -Path (Join-Path $stage "examples"), (Join-Path $stage "vendor") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $sourceRoot "extension\examples\*") (Join-Path $stage "examples")
    Copy-Item -Recurse -Force (Join-Path $sourceRoot "extension\vendor\renderer") (Join-Path $stage "vendor\renderer")
    Copy-Item -Force `
        (Join-Path $sourceRoot "extension\vendor\LICENSE.txt"), `
        (Join-Path $sourceRoot "extension\vendor\ThirdPartyNotices.txt"), `
        (Join-Path $sourceRoot "extension\vendor\language-server.sha256") `
        (Join-Path $stage "vendor")

    if (Test-Path (Join-Path $target "artifacts")) {
        New-Item -ItemType Directory -Path (Join-Path $stage "artifacts") | Out-Null
        Copy-Item -Recurse -Force (Join-Path $target "artifacts\*") (Join-Path $stage "artifacts")
    }
    if ((Test-Path (Join-Path $target "vendor\.installed-bicep-langserver.json")) `
        -and (Test-Path (Join-Path $target "vendor\language-server"))) {
        Copy-Item -Recurse -Force (Join-Path $target "vendor\language-server") (Join-Path $stage "vendor\language-server")
        Copy-Item -Force (Join-Path $target "vendor\.installed-bicep-langserver.json") (Join-Path $stage "vendor\.installed-bicep-langserver.json")
    }

    & $bootstrap -Target $stage

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
    Write-Host "Reload extensions in GitHub Copilot, or restart the app."
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
