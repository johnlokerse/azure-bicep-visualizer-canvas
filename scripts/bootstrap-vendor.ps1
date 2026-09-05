[CmdletBinding()]
param(
    [string]$Target = (Join-Path $PSScriptRoot "..\extension")
)

$ErrorActionPreference = "Stop"
$version = "0.46.1"
$archiveUrl = "https://github.com/Azure/bicep/releases/download/v$version/bicep-langserver.zip"
$archiveSha256 = "b8224c8e941cde9698747ddd97c930a25097bf688e4e43e4acdd21ca8c24656a"
$languageServerSha256 = "2756e192acbcc8a1a84b41c54b48349381a3b4cd3c38b6f1fc568207ccb71513"
$rendererSha256 = "44e6aea537929a9a2da01abec9030369e09b22568b94efd1c47198d852cd64a0"
$licenseSha256 = "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"
$noticesSha256 = "ebb6d7f745eecff538d2bc47a2fb2d3c67b3822b7b04e576afc3b6de623a0f7a"
$targetPath = [IO.Path]::GetFullPath($Target)

if ($targetPath -eq [IO.Path]::GetPathRoot($targetPath) -or -not (Test-Path (Join-Path $targetPath "extension.mjs"))) {
    throw "Target is not a Bicep Visualizer extension: $targetPath"
}

function Get-Sha256([string]$Path) {
    if (-not (Test-Path $Path)) {
        return ""
    }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-LanguageServer([string]$Root, [string]$Manifest) {
    if (-not (Test-Path $Root -PathType Container) -or -not (Test-Path $Manifest -PathType Leaf)) {
        return $false
    }
    if (@(Get-ChildItem -LiteralPath $Root -File -Recurse).Count -ne 241) {
        return $false
    }
    foreach ($line in Get-Content -LiteralPath $Manifest) {
        $parts = $line -split "  ", 2
        if ($parts.Count -ne 2) {
            return $false
        }
        $relative = $parts[1].Replace("/", [IO.Path]::DirectorySeparatorChar)
        if ((Get-Sha256 (Join-Path $Root $relative)) -ne $parts[0]) {
            return $false
        }
    }
    return $true
}

$vendor = Join-Path $targetPath "vendor"
$marker = Join-Path $vendor ".installed-bicep-langserver.json"
$manifest = Join-Path $vendor "language-server.sha256"
$valid = (Test-Path $marker) `
    -and (Test-LanguageServer (Join-Path $vendor "language-server") $manifest) `
    -and (Get-Sha256 (Join-Path $vendor "renderer\index.js")) -eq $rendererSha256 `
    -and (Get-Sha256 (Join-Path $vendor "LICENSE.txt")) -eq $licenseSha256 `
    -and (Get-Sha256 (Join-Path $vendor "ThirdPartyNotices.txt")) -eq $noticesSha256 `
    -and (Get-Content -Raw -LiteralPath $marker).Contains($archiveSha256)
if ($valid) {
    Write-Host "Azure Bicep v$version vendor files are already installed."
    return
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("bicep-visualizer-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $archive = if ($env:BICEP_VISUALIZER_LANGSERVER_ARCHIVE) { [IO.Path]::GetFullPath($env:BICEP_VISUALIZER_LANGSERVER_ARCHIVE) } else { Join-Path $work "bicep-langserver.zip" }
    if ($env:BICEP_VISUALIZER_LANGSERVER_ARCHIVE) {
        if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
            throw "BICEP_VISUALIZER_LANGSERVER_ARCHIVE does not name a file: $archive"
        }
    } else {
        Write-Host "Downloading Azure Bicep v$version from the official GitHub release..."
        Invoke-WebRequest -Uri $archiveUrl -OutFile $archive
    }
    $actual = Get-Sha256 $archive
    if ($actual -ne $archiveSha256) {
        throw "Checksum mismatch for bicep-langserver.zip. Expected: $archiveSha256 Actual: $actual"
    }

    $unpacked = Join-Path $work "unpacked"
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $languageServer = $unpacked
    if ((Get-Sha256 (Join-Path $vendor "renderer\index.js")) -ne $rendererSha256 `
        -or (Get-Sha256 (Join-Path $languageServer "Bicep.LangServer.dll")) -ne $languageServerSha256 `
        -or -not (Test-LanguageServer $languageServer $manifest)) {
        throw "Extracted Azure Bicep files did not match the pinned release."
    }

    New-Item -ItemType Directory -Force -Path $vendor | Out-Null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $vendor "language-server")
    Move-Item -LiteralPath $languageServer -Destination (Join-Path $vendor "language-server")
    @{
        version = "v$version"
        archiveUrl = $archiveUrl
        archiveSha256 = $archiveSha256
    } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $marker
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}

Write-Host "Installed Azure Bicep v$version language server into $vendor."
