# Bicep Visualizer canvas

An importable GitHub Copilot canvas that runs the original Azure Bicep v0.46.1
resource graph locally. It supports live saved-file updates, nested modules,
dependency layout, source navigation, diagnostics, themes, and PNG export.

The installable [`extension/`](extension/) folder is self-contained, UTF-8
text-only, and has no generated artifacts or files above the GitHub Copilot
1,000,000-byte import limit. The exact unmodified visual-designer renderer is
checked in as two text-only JSON bundles. On first launch, the extension
reconstructs and verifies its 154 compiled JavaScript and CSS files in the same
external cache used for the language server.

The 104 MB language-server runtime is not committed or stored in the installed
extension. On first launch, the extension downloads Microsoft's official 55 MB
`bicep-langserver.zip`, verifies its pinned SHA-256 and a complete 241-file
checksum manifest, then installs it into an external Copilot cache.

## Prerequisites

- GitHub Copilot app with canvas extensions and **Import canvas from gist/URL**.
- [.NET 10 runtime](https://dotnet.microsoft.com/download/dotnet/10.0), with
  `dotnet` on `PATH`.
- Network access to the official Azure Bicep v0.46.1 release on GitHub during
  first launch.
- macOS or Linux: `unzip`.
- Windows: built-in `tar` or Windows PowerShell.

Set `BICEP_VISUALIZER_DOTNET` to an absolute `dotnet` executable path when
`dotnet` is not on `PATH`.

## Import directly in the GitHub Copilot app

Use this repository folder URL:

```text
https://github.com/johnlokerse/azure-bicep-visualizer-canvas/tree/main/extension
```

1. In the GitHub Copilot app sidebar, open **Customize**, then **Canvas**.
2. Choose **Import canvas from gist/URL**.
3. Paste the URL above and complete the import.
4. Start a new session or reload extensions.
5. Open the Bicep Visualizer. Its first launch downloads and verifies the
   pinned language server; later launches reuse the fully verified cache.

The extension follows GitHub's documented direct-installed layout: its own
directory contains [`package.json`](extension/package.json),
[`extension.mjs`](extension/extension.mjs), the local UI, licenses, provenance,
and renderer text assets.

## Share through a secret gist

Create a secret gist containing all **20 top-level files** from
[`extension/`](extension/), keeping their exact filenames, then import the gist
URL with **Import canvas from gist/URL**. The payload is intentionally flat, so
GitHub Gist's file model cannot lose nested renderer paths.

Do not add the repository-root `ThirdPartyNotices.txt` to the gist: it exceeds
the app's per-file import limit and the compact `AZURE-BICEP-NOTICE.md` already
links to it. Runtime binaries and saved canvas data remain outside the
extension directory and are never part of the gist.

## Script installation

Direct app import is recommended. The scripts remain available for users who
prefer to install into `$COPILOT_HOME/extensions/bicep-visualizer`;
`COPILOT_HOME` defaults to `~/.copilot`.

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/johnlokerse/azure-bicep-visualizer-canvas/main/install.sh | sh
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/johnlokerse/azure-bicep-visualizer-canvas/main/install.ps1 | iex
```

The scripts copy only the text extension payload. Runtime provisioning still
happens inside the extension on first launch, exactly as it does for a direct
URL or gist import. Updates roll back failed swaps and recover an interrupted
swap on the next run.

## Usage

Ask Copilot to open the Bicep Visualizer for a workspace or entrypoint:

> Open the Bicep Visualizer for `infra/main.bicep`.

The canvas can also open a workspace and let you select an entrypoint. Changes
saved to `.bicep`, `.bicepparam`, and `bicepconfig.json` files update the graph
automatically. Unsaved editor buffers are not visible to the extension.

PNG exports default to the external canvas state directory. You can choose
another absolute local directory in the save dialog; existing files are never
overwritten.

## Local data and uninstall

By default, the extension uses:

| Data | Location |
|---|---|
| Installed extension | `$COPILOT_HOME/extensions/bicep-visualizer` |
| Verified Bicep runtime | `$COPILOT_HOME/cache/bicep-visualizer/v0.46.1` |
| Preferences and PNG exports | `$COPILOT_HOME/state/bicep-visualizer` |

Remove the installed canvas from **Customize** > **Installed**, or delete its
extension directory. Removing the optional cache and state directories clears
the downloaded runtime and saved local data.

`BICEP_VISUALIZER_CACHE` and `BICEP_VISUALIZER_STATE` override the default
cache and state locations; use absolute paths. `BICEP_VISUALIZER_LANGSERVER_ARCHIVE`
can point to an already-downloaded archive or internal mirror; the pinned
checksum is still required.

## Security and privacy

- The canvas reads only local Bicep workspaces selected by the user.
- Its HTTP server binds to an ephemeral `127.0.0.1` port and uses a random
  per-panel URL capability. Unexpected hosts and origins are rejected.
- Bicep telemetry is disabled. Source files and language-server messages stay
  local.
- Only saved files are read. Unsaved editor buffers are not accessible.
- PNG export writes only to the selected local destination and refuses to
  overwrite an existing file.
- The bootstrap accepts only the official Azure Bicep v0.46.1 archive with
  SHA-256
  `b8224c8e941cde9698747ddd97c930a25097bf688e4e43e4acdd21ca8c24656a`.
- Every extracted runtime file must match the committed checksum manifest.
  Concurrent launches share a lock, and interrupted installs are recovered
  before the cache is used.

## Licensing and attribution

The integration code is licensed under the [MIT License](LICENSE), which is
also included inside the directly importable extension.

The unmodified renderer and downloaded language server come from the official
[Azure Bicep v0.46.1 release](https://github.com/Azure/bicep/releases/tag/v0.46.1)
and are licensed by Microsoft under MIT. The upstream
[license](extension/AZURE-BICEP-LICENSE.txt), compact in-extension
[notice](extension/AZURE-BICEP-NOTICE.md), complete
[third-party notices](ThirdPartyNotices.txt), and machine-readable
[provenance](extension/provenance.json) are preserved in this repository.
