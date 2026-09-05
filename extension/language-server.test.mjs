import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BicepLanguageServer, ContentLengthDecoder } from "./language-server.mjs";

const extension = dirname(fileURLToPath(import.meta.url));
const fixture = join(extension, "language-server.test-fixture.mjs");
const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

test("Content-Length frames survive every byte boundary, UTF-8 and multiple messages", () => {
  const messages = [{ jsonrpc: "2.0", id: 1, result: "é😀" }, { jsonrpc: "2.0", id: 2, result: [] }];
  const bytes = Buffer.concat(messages.map(frame));
  for (let split = 0; split <= bytes.length; split++) {
    const received = [];
    const decoder = new ContentLengthDecoder((message) => received.push(message));
    decoder.push(bytes.subarray(0, split));
    decoder.push(bytes.subarray(split));
    assert.deepEqual(received, messages);
  }
  const received = [];
  const decoder = new ContentLengthDecoder((message) => received.push(message));
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(received, messages);
  for (const header of ["Content-Length: -1", "Content-Length: 999999999", "Other: 1", "Content-Length: 2\r\nContent-Length: 2"]) {
    assert.throws(() => new ContentLengthDecoder(() => {}).push(Buffer.from(`${header}\r\n\r\n{}`)));
  }
});

async function workspace(t) {
  const path = join(extension, `.lsp-test-${randomUUID()}`);
  await mkdir(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("client lifecycle, configuration, edits, dependencies, deletion, timeout and cancellation", async (t) => {
  const root = await workspace(t);
  const project = join(root, "project");
  await mkdir(project);
  const main = join(project, "main space é.bicep");
  const dependency = join(root, "outside.bicep");
  await writeFile(main, "module other '../outside.bicep' = { name: 'other' }\n");
  await writeFile(dependency, "param name string\n");
  const changes = [];
  const diagnostics = [];
  const server = new BicepLanguageServer({
    rootPath: project, dotnetPath: process.execPath, serverPath: fixture, pollInterval: 0,
    onChange: (value) => changes.push(value), onDiagnostics: (value) => diagnostics.push(value),
  });
  t.after(() => server.close());
  await Promise.all([server.start(), server.start()]);
  const [uri, secondUri] = await Promise.all([server.open(main), server.open(main)]);
  assert.equal(uri, pathToFileURL(main).href);
  assert.equal(secondUri, uri);
  let messages = await server.request("test/messages", {});
  assert.equal(messages.filter((message) => message.method === "textDocument/didOpen").length, 1);
  assert.deepEqual(messages.find((message) => message.id === "configuration").result, [{ enableTelemetry: false }, null]);
  assert.equal(diagnostics.length, 1);
  assert.ok(server.diagnostics.has(uri));
  assert.deepEqual(await server.refresh(), []);
  assert.equal(changes.length, 0);
  await writeFile(dependency, "param name int\n");
  const refreshes = await Promise.all([server.refresh(), server.refresh(), server.refresh()]);
  assert.equal(changes.length, 1);
  assert.deepEqual(refreshes[0], [{ uri: pathToFileURL(dependency).href, type: 2 }]);
  await writeFile(main, "param updated string\n");
  assert.deepEqual(await server.refresh(), [{ uri, type: 2 }]);
  await mkdir(join(project, "node_modules"));
  await writeFile(join(project, "node_modules/ignored.bicep"), "not bicep");
  assert.deepEqual(await server.refresh(), []);
  await writeFile(join(project, "bicepconfig.json"), "{}");
  assert.deepEqual(await server.refresh(), [{ uri: pathToFileURL(join(project, "bicepconfig.json")).href, type: 1 }]);
  messages = await server.request("test/messages", {});
  assert.equal(messages.filter((message) => message.method === "textDocument/didOpen").length, 1);
  assert.ok(messages.some((message) => message.method === "textDocument/didChange" && message.params.contentChanges[0].text.includes("updated")));
  await rm(main);
  await server.refresh();
  await writeFile(main, "param recreated bool\n");
  await server.refresh();
  messages = await server.request("test/messages", {});
  assert.equal(messages.filter((message) => message.method === "textDocument/didClose").length, 1);
  assert.equal(messages.filter((message) => message.method === "textDocument/didOpen").length, 2);
  await assert.rejects(server.request("test/error", {}), { code: -32000 });
  await assert.rejects(server.request("test/wait", {}, { timeout: 20 }), /timed out/);
  const controller = new AbortController();
  const pending = server.request("test/wait", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(server.pending.size, 0);
  messages = await server.request("test/messages", {});
  assert.equal(messages.filter((message) => message.method === "$/cancelRequest").length, 2);
  await Promise.all([server.close(), server.close()]);
  await assert.rejects(server.start(), /closed/);
});

test("spawn failure and unexpected exit reject rather than silently falling back", async (t) => {
  const root = await workspace(t);
  const errors = [];
  const absent = new BicepLanguageServer({ rootPath: root, serverPath: fixture, dotnetPath: join(root, "not-found"), onError: (error) => errors.push(error) });
  t.after(() => absent.close());
  await assert.rejects(absent.start(), /Cannot start/);
  assert.equal(errors.length, 1);
  const server = new BicepLanguageServer({ rootPath: root, serverPath: fixture, dotnetPath: process.execPath, pollInterval: 0 });
  t.after(() => server.close());
  await server.start();
  await assert.rejects(server.request("test/exit", {}), /exited \(23\)/);
  await assert.rejects(server.request("test/messages", {}), /exited \(23\)/);
});

test("real Bicep v0.46.1 initializes, compiles modules and returns visual graph patches", { timeout: 60000 }, async (t) => {
  const binary = join(extension, "vendor/language-server/Bicep.LangServer.dll");
  const dotnet = process.env.BICEP_VISUALIZER_DOTNET ?? "dotnet";
  try { await access(binary); } catch { t.skip("Bundled Bicep language server unavailable"); return; }
  if (spawnSync(dotnet, ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip(".NET runtime unavailable");
    return;
  }
  const root = await workspace(t);
  await writeFile(join(root, "main.bicep"), "module child './child.bicep' = { name: 'child' }\noutput greeting string = child.outputs.greeting\n");
  await writeFile(join(root, "child.bicep"), "output greeting string = 'hello'\n");
  const publications = [];
  let notifyDiagnostics;
  const server = new BicepLanguageServer({
    rootPath: root, pollInterval: 0,
    onDiagnostics: (value) => { publications.push(value); notifyDiagnostics?.(value); },
  });
  t.after(() => server.close());
  const initialized = await server.start();
  assert.ok(initialized.capabilities);
  const uri = await server.open(join(root, "main.bicep"));
  const result = await server.request("textDocument/visualGraphUpdate", { textDocument: { uri }, current: null });
  assert.ok(Array.isArray(result.patches));
  assert.ok(result.patches.length > 0);
  assert.ok(publications.some((publication) => publication.uri === uri));
  assert.equal(server.diagnostics.get(uri).filter((diagnostic) => diagnostic.severity === 1).length, 0);
  const errorPublication = new Promise((resolvePublication, rejectPublication) => {
    const timer = setTimeout(() => rejectPublication(new Error("Dependency edit did not produce updated diagnostics")), 10000);
    notifyDiagnostics = (value) => {
      if (value.uri === uri && value.diagnostics.some((diagnostic) => diagnostic.severity === 1)) {
        clearTimeout(timer);
        resolvePublication(value);
      }
    };
  });
  await writeFile(join(root, "child.bicep"), "output greeting string = missingName\n");
  const changed = await server.refresh();
  assert.deepEqual(changed, [{ uri: pathToFileURL(join(root, "child.bicep")).href, type: 2 }]);
  await server.request("textDocument/visualGraphUpdate", { textDocument: { uri }, current: null });
  await errorPublication;
});
