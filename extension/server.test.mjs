import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCanvas } from "./server.mjs";

const extension = dirname(fileURLToPath(import.meta.url));

test("loopback canvas serves the shell and a real Bicep graph", { timeout: 60000 }, async (t) => {
  const binary = join(extension, "vendor/language-server/Bicep.LangServer.dll");
  const dotnet = process.env.BICEP_VISUALIZER_DOTNET ?? "dotnet";
  try { await access(binary); } catch { t.skip("Bundled Bicep language server unavailable"); return; }
  if (spawnSync(dotnet, ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip(".NET runtime unavailable");
    return;
  }

  const root = join(extension, `.server-test-${randomUUID()}`);
  await mkdir(root);
  await writeFile(join(root, "main.bicep"), "resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {\n  name: 'example'\n  location: resourceGroup().location\n  kind: 'StorageV2'\n  sku: { name: 'Standard_LRS' }\n}\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const canvas = await startCanvas({ rootPath: root, filePath: "main.bicep" });
  t.after(() => canvas.close());

  const shell = await fetch(canvas.url);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Bicep Visualizer/);

  const graphPage = await fetch(new URL("graph", canvas.url));
  assert.equal(graphPage.status, 200);
  assert.match(await graphPage.text(), /renderer\/index\.js/);

  const renderer = await fetch(new URL("renderer/index.js", canvas.url));
  assert.equal(renderer.status, 200);
  assert.ok((await renderer.arrayBuffer()).byteLength > 100_000);

  const response = await fetch(new URL("message", canvas.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, method: "getGraphUpdate", params: { current: null } }),
  });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.ok(Array.isArray(message.result.patches));
  assert.ok(message.result.patches.length > 0);
});
