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

## Licensing and attribution

The integration code is licensed under the [MIT License](LICENSE), which is
also included inside the directly importable extension.

The unmodified renderer and downloaded language server come from the official
[Azure Bicep v0.46.1 release](https://github.com/Azure/bicep/releases/tag/v0.46.1)
and are licensed by Microsoft under MIT. The upstream
[license](extension/AZURE-BICEP-LICENSE.txt), compact in-extension
[notice](extension/vendor/NOTICE.md), complete
[third-party notices](ThirdPartyNotices.txt), and machine-readable
[provenance](extension/provenance.json) are preserved in this repository.
