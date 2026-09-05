# Bicep Visualizer canvas

An installable GitHub Copilot canvas that runs the original Azure Bicep
v0.46.1 resource graph locally. It supports live saved-file updates, nested
modules, dependency layout, source navigation, diagnostics, themes, and PNG
export.

The exact 1.5 MB visual-designer renderer is committed unchanged. The
repository intentionally does not commit the 104 MB Bicep language-server
runtime. The installer downloads Microsoft's official 55 MB
`bicep-langserver.zip`, verifies its pinned SHA-256 checksum, and extracts it
into the ignored vendor path.

## Prerequisites

- GitHub Copilot app or CLI with extension canvases enabled.
- [.NET 10 runtime](https://dotnet.microsoft.com/download/dotnet/10.0), with
  `dotnet` on `PATH`.
- macOS or Linux: `curl`, `tar`, `unzip`, and a SHA-256 utility (`sha256sum`,
  `shasum`, or `openssl`). Standard macOS and most Linux installations already
  provide these.
- Windows: Windows PowerShell 5.1 or PowerShell 7.

Set `BICEP_VISUALIZER_DOTNET` to an absolute `dotnet` executable path when
`dotnet` is not on `PATH`.

## Install or update

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/johnlokerse/azure-bicep-visualizer-canvas/main/install.sh | sh
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/johnlokerse/azure-bicep-visualizer-canvas/main/install.ps1 | iex
```

The installer stages a complete user extension at
`$COPILOT_HOME/extensions/bicep-visualizer`; `COPILOT_HOME` defaults to
`~/.copilot`. Updates preserve the extension's `artifacts` folder, roll back
failed swaps, and recover an interrupted swap on the next run. Existing Bicep
vendor files are reused only after every extracted file passes the committed
v0.46.1 checksum manifest.

Reload extensions from the GitHub Copilot command palette after installation,
or restart the app.

To install from a clone instead:

```sh
./install.sh
```

```powershell
.\install.ps1
```

GitHub Copilot's generic **Install extension from repository folder** flow is
not sufficient for this repository: generated vendor files are intentionally
gitignored and therefore cannot be preserved by that flow. Use the installer,
which stages the complete extension after verification.

## Usage

Ask Copilot to open the Bicep Visualizer for a workspace or entrypoint, for
example:

> Open the Bicep Visualizer for `infra/main.bicep`.

The canvas can also open a workspace and let you select an entrypoint. Changes
saved to `.bicep`, `.bicepparam`, and `bicepconfig.json` files update the graph
automatically. Unsaved editor buffers are not visible to the extension.

PNG exports default to the extension's persistent `artifacts/exports`
directory. You can choose another absolute local directory in the save dialog;
existing files are never overwritten.

## Uninstall

Close or reload GitHub Copilot, then remove:

```sh
rm -rf "${COPILOT_HOME:-$HOME/.copilot}/extensions/bicep-visualizer"
```

On Windows:

```powershell
Remove-Item -Recurse -Force (Join-Path $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { "$HOME\.copilot" }) "extensions\bicep-visualizer")
```

## Security and privacy

- The canvas reads local Bicep workspaces selected by the user.
- Its HTTP server binds only to an ephemeral `127.0.0.1` port and uses a random
  per-panel URL capability. Requests with an unexpected host or origin are
  rejected.
- Bicep telemetry is disabled. Source files and language-server messages stay
  local.
- Only saved files are read. The canvas cannot access unsaved editor buffers.
- PNG export writes only to the local destination selected by the user and
  refuses to overwrite existing files.
- The installer downloads only the pinned official Azure Bicep language-server
  archive over HTTPS and rejects it unless its SHA-256 is
  `b8224c8e941cde9698747ddd97c930a25097bf688e4e43e4acdd21ca8c24656a`.

## Versioning and platform notes

The renderer and language server are both pinned to Azure Bicep **v0.46.1**.
Keeping them at the same version is required because the visual graph uses
custom language-server methods. The official framework-dependent language
server contains managed assemblies plus native runtime assets for macOS,
Linux, and Windows; the host architecture is selected by .NET.

To test an already downloaded archive or use an internal mirror, set
`BICEP_VISUALIZER_LANGSERVER_ARCHIVE` to its local path. The same pinned
checksum is still required.

## Development

Populate ignored vendor files and run all tests:

```sh
./scripts/bootstrap-vendor.sh
node --test extension/*.test.mjs
```

The tests cover JSON-RPC framing and lifecycle behavior, saved dependency
updates, the real v0.46.1 language server, graph generation, and the loopback
HTTP canvas shell.

## Licensing and attribution

The integration code in this repository is licensed under the [MIT
License](LICENSE).

The unmodified renderer and language server come from the official
[Azure Bicep v0.46.1 release](https://github.com/Azure/bicep/releases/tag/v0.46.1)
and are licensed by Microsoft under MIT. Their exact
[license](extension/vendor/LICENSE.txt), complete
[third-party notices](extension/vendor/ThirdPartyNotices.txt), and machine-readable
[provenance](extension/provenance.json) are included. The local bridge and
canvas shell adapt the VS Code messaging and UI surfaces without modifying the
upstream renderer bundle.
