import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, readdir, realpath, stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute, extname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BicepLanguageServer } from "./language-server.mjs";

const home = dirname(fileURLToPath(import.meta.url));
const copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
const defaultArtifacts = resolve(process.env.BICEP_VISUALIZER_STATE ?? join(copilotHome, "state", "bicep-visualizer"));
const defaultRenderer = process.env.BICEP_VISUALIZER_RENDERER_PATH ?? join(home, "vendor", "renderer");
const ignored = new Set([".git", "node_modules", ".terraform", "bin", "obj", "vendor"]);
const mime = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const inside = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && part !== ".." && !isAbsolute(part));
};

async function body(req, limit = 8 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new Error("Request exceeds the size limit.");
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function startCanvas(input = {}, {
  artifacts = defaultArtifacts,
  rendererPath = defaultRenderer,
  serverPath = process.env.BICEP_VISUALIZER_SERVER_PATH,
} = {}) {
  let rootPath = await realpath(resolve(input.rootPath ?? (input.filePath && isAbsolute(input.filePath) ? dirname(input.filePath) : process.cwd())));
  if (!(await stat(rootPath)).isDirectory()) throw new Error("rootPath must be a directory.");
  const rendererRoot = await realpath(rendererPath);
  let filePath = null;
  let language = null;
  let languageStart = null;
  let lastError = null;
  let disposed = false;
  let mutation = Promise.resolve();
  const clients = new Set();
  const allowedSource = new Set();
  const exports = new Map();
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  let url;
  let changeTimer;

  function send(event, data) {
    for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function invalidated() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (!disposed && filePath) send("document", { method: "documentDidChange", params: { documentUri: filePath } });
      send("state", state());
    }, 120);
  }
  function failure(error) {
    lastError = error.message ?? String(error);
    send("failure", { message: lastError });
  }
  function state() {
    return {
      version: "0.46.1", rootPath, filePath, error: lastError,
      diagnostics: [...(language?.diagnostics ?? new Map())].flatMap(([uri, diagnostics]) =>
        diagnostics.map((diagnostic) => ({ ...diagnostic, uri }))),
    };
  }
  async function ensureLanguage() {
    if (!languageStart) {
      language = new BicepLanguageServer({
        rootPath, serverPath, onDiagnostics: invalidated, onChange: invalidated, onError: failure,
      });
      languageStart = language.start();
    }
    await languageStart;
    return language;
  }
  function serial(work) {
    const next = mutation.then(work);
    mutation = next.catch(() => {});
    return next;
  }
  function preference() {
    return join(artifacts, "workspaces", `${createHash("sha256").update(rootPath).digest("hex")}.json`);
  }
  async function selectInternal(value) {
    if (typeof value !== "string" || !value) throw new Error("Choose a Bicep file.");
    const selected = await realpath(resolve(rootPath, value));
    if (!inside(rootPath, selected) || extname(selected) !== ".bicep" || !(await stat(selected)).isFile()) {
      throw new Error("Choose a .bicep file inside the selected workspace.");
    }
    const ls = await ensureLanguage();
    await ls.open(selected);
    filePath = selected;
    allowedSource.add(selected);
    lastError = null;
    await mkdir(dirname(preference()), { recursive: true });
    await writeFile(preference(), JSON.stringify({ filePath }, null, 2));
    send("selected", state());
    return state();
  }
  const select = (value) => serial(() => selectInternal(value));
  async function listFiles() {
    const files = [];
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith(".")) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".bicep")) files.push(relative(rootPath, path));
      }
    }
    await walk(rootPath);
    return files.sort();
  }
  async function refresh() {
    if (language) await language.refresh();
    invalidated();
    return state();
  }
  async function source(path, range) {
    const canonical = await realpath(path);
    if (!allowedSource.has(canonical) && !inside(rootPath, canonical)) throw new Error("This source is not part of the current graph.");
    if (![".bicep", ".bicepparam", ".json", ".jsonc", ".arm"].includes(extname(canonical))) throw new Error("Unsupported source file.");
    const info = await stat(canonical);
    if (info.size > 5 * 1024 * 1024) throw new Error("Source is larger than 5 MB. Open it in your editor.");
    return { filePath: canonical, range, content: await readFile(canonical, "utf8") };
  }
  async function revealNode(nodeId) {
    if (!filePath) throw new Error("Choose an entrypoint first.");
    const ls = await ensureLanguage();
    const result = await ls.request("textDocument/visualGraphNodeSource", {
      textDocument: { uri: pathToFileURL(filePath).href }, nodeId,
    });
    if (!result.found || !result.filePath || !result.range) throw new Error("The declaration no longer exists. Refresh the graph.");
    const canonical = await realpath(result.filePath);
    allowedSource.add(canonical);
    const location = await source(canonical, result.range);
    send("source", location);
    return location;
  }
  async function message(msg) {
    if (!msg || typeof msg.method !== "string") throw new Error("Invalid visualizer message.");
    switch (msg.method) {
      case "ready":
        invalidated();
        return null;
      case "getGraphUpdate":
      case "getGraphLayout": {
        if (!filePath) throw new Error("Choose an entrypoint first.");
        const ls = await ensureLanguage();
        const result = await ls.request(
          msg.method === "getGraphUpdate" ? "textDocument/visualGraphUpdate" : "textDocument/visualGraphLayout",
          { textDocument: { uri: pathToFileURL(filePath).href }, current: msg.params?.current ?? null },
        );
        lastError = null;
        return result;
      }
      case "revealNodeSource":
        await revealNode(msg.params?.nodeId);
        return null;
      case "revealFileRange":
        send("source", await source(msg.params.filePath, msg.params.range));
        return null;
      case "showProblemsPanel":
        send("problems", state());
        return null;
      default: throw new Error(`Unsupported visualizer message: ${msg.method}`);
    }
  }
  function json(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
  const server = createServer(async (req, res) => {
    try {
      const origin = new URL(url).origin;
      if (req.headers.host !== new URL(url).host || (req.headers.origin && req.headers.origin !== origin)) {
        json(res, { error: "Untrusted origin." }, 403);
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      const requestUrl = new URL(req.url, origin);
      if (!requestUrl.pathname.startsWith(prefix)) { json(res, { error: "Not found." }, 404); return; }
      const route = decodeURIComponent(requestUrl.pathname.slice(prefix.length));
      if (req.method === "GET" && route === "events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && route === "state") return json(res, state());
      if (req.method === "GET" && route === "files") return json(res, { rootPath, files: await listFiles() });
      if (req.method === "GET" && exports.has(route)) {
        res.setHeader("Content-Type", "image/png");
        res.end(await readFile(exports.get(route)));
        return;
      }
      if (req.method === "POST" && route === "export") {
        const name = requestUrl.searchParams.get("name");
        const folder = requestUrl.searchParams.get("folder") || join(artifacts, "exports");
        if (!name || basename(name) !== name || !name.endsWith(".png") || /[\\\x00-\x1f]/.test(name)) throw new Error("Enter a PNG filename without directory separators.");
        if (!isAbsolute(folder)) throw new Error("The export folder must be an absolute path.");
        const bytes = await body(req, 32 * 1024 * 1024);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Export is not a PNG image.");
        await mkdir(folder, { recursive: true });
        const destination = join(await realpath(folder), name);
        await writeFile(destination, bytes, { flag: "wx" });
        const id = `exports/${randomBytes(12).toString("hex")}.png`;
        exports.set(id, destination);
        send("exported", { filePath: destination, url: `${url}${id}` });
        return json(res, { filePath: destination, url: `${url}${id}` });
      }
      if (req.method === "POST") {
        const data = JSON.parse((await body(req)).toString("utf8"));
        if (route === "message") {
          try {
            const result = await message(data);
            return json(res, data.id ? { id: data.id, result } : { result });
          } catch (error) {
            failure(error);
            return json(res, data.id ? { id: data.id, error: { message: error.message } } : { error: error.message }, data.id ? 200 : 400);
          }
        }
        if (route === "select") return json(res, await select(data.filePath));
        if (route === "refresh") return json(res, await refresh());
        if (route === "source") {
          const uri = data.uri ? new URL(data.uri) : null;
          if (uri && uri.protocol !== "file:") throw new Error("Only local source files can be opened here.");
          const path = uri ? fileURLToPath(uri) : filePath;
          const knownDiagnostic = uri && language?.diagnostics.has(uri.href);
          if (knownDiagnostic) allowedSource.add(await realpath(path));
          return json(res, await source(path, data.range));
        }
        if (route === "workspace") {
          return json(res, await serial(async () => {
            if (typeof data.rootPath !== "string" || !isAbsolute(data.rootPath)) throw new Error("Enter an absolute workspace folder.");
            const root = await realpath(data.rootPath);
            if (!(await stat(root)).isDirectory()) throw new Error("Workspace must be a directory.");
            await language?.close();
            language = null;
            languageStart = null;
            rootPath = root;
            filePath = null;
            lastError = null;
            allowedSource.clear();
            send("selected", state());
            return state();
          }));
        }
      }
      if (req.method !== "GET") { json(res, { error: "Not found." }, 404); return; }
      const names = { "": "index.html", "graph": "graph.html", "bridge.js": "bridge.js", "shell.js": "shell.js", "shell.css": "shell.css", "graph.css": "graph.css" };
      let target;
      if (Object.hasOwn(names, route)) target = join(home, names[route]);
      else if (route.startsWith("renderer/")) {
        target = await realpath(resolve(rendererRoot, route.slice("renderer/".length)));
        if (!inside(rendererRoot, target)) throw new Error("Invalid asset path.");
      } else { json(res, { error: "Not found." }, 404); return; }
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'");
      res.setHeader("Content-Type", mime[extname(target)] ?? "text/html; charset=utf-8");
      res.end(await readFile(target));
    } catch (error) {
      if (!res.headersSent) json(res, { error: error.code === "EEXIST" ? "That PNG already exists. Choose a different filename." : error.message }, 400);
      else res.destroy(error);
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  url = `http://127.0.0.1:${server.address().port}${prefix}`;
  const heartbeat = setInterval(() => { for (const client of clients) client.write(": keepalive\n\n"); }, 15000);
  heartbeat.unref();
  const close = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    clearTimeout(changeTimer);
    for (const client of clients) client.end();
    clients.clear();
    server.closeIdleConnections();
    const closed = new Promise((done) => server.close(done));
    server.closeAllConnections();
    await Promise.all([closed, language?.close()]);
  };
  try {
    if (input.filePath) await select(input.filePath);
    else {
      let saved;
      try { saved = JSON.parse(await readFile(preference(), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (saved?.filePath) {
        try { await select(saved.filePath); }
        catch (error) { failure(error); }
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { url, state, select, refresh, revealNode, close };
}
