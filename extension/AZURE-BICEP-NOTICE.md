# Azure Bicep renderer notice

The `renderer.bundle-*.json` files contain the unmodified visual-designer
bundle from Microsoft's [Azure Bicep v0.46.1 release][release]. Azure Bicep is
licensed under the MIT License; the upstream license is included in
[`AZURE-BICEP-LICENSE.txt`](AZURE-BICEP-LICENSE.txt).

The complete third-party notices for the matching official
`vscode-bicep.vsix` are preserved in this repository as
[`ThirdPartyNotices.txt`][notices]. They are intentionally outside the
installable `extension/` folder because GitHub Copilot canvas URL/gist imports
reject individual files larger than 1,000,000 bytes.

[release]: https://github.com/Azure/bicep/releases/tag/v0.46.1
[notices]: https://github.com/johnlokerse/azure-bicep-visualizer-canvas/blob/main/ThirdPartyNotices.txt
