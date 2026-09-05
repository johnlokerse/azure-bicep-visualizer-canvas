import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionPath = dirname(fileURLToPath(import.meta.url));
const relevant = (path) => /\.(bicep|bicepparam)$/i.test(path) || basename(path) === "bicepconfig.json";
const missing = (error) => error.code === "ENOENT" || error.code === "ENOTDIR";
const canonicalUri = (path) => pathToFileURL(resolve(path)).href;
const abortError = () => Object.assign(new Error("Language server request cancelled"), { name: "AbortError", code: -32800 });

/** A byte-oriented decoder: Content-Length measures UTF-8 bytes, not JS characters. */
export class ContentLengthDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    this.length = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.length === null) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > 8192) throw new Error("Language server header exceeds 8192 bytes");
          return;
        }
        if (end > 8192) throw new Error("Language server header exceeds 8192 bytes");
        const lengths = this.buffer.subarray(0, end).toString("ascii").split("\r\n")
          .filter((line) => /^content-length:/i.test(line));
        if (lengths.length !== 1 || !/^content-length:\s*\d+\s*$/i.test(lengths[0])) {
          throw new Error("Invalid language server Content-Length header");
        }
        this.length = Number(lengths[0].split(":")[1].trim());
        if (!Number.isSafeInteger(this.length) || this.length < 1 || this.length > 64 * 1024 * 1024) {
          throw new Error("Language server frame size is invalid");
        }
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) return;
      const body = this.buffer.subarray(0, this.length);
      this.buffer = this.buffer.subarray(this.length);
      this.length = null;
      this.onMessage(JSON.parse(body.toString("utf8")));
    }
  }
}

export class BicepLanguageServer {
  constructor({
    rootPath, onDiagnostics, onChange, onError,
    dotnetPath = process.env.BICEP_VISUALIZER_DOTNET ?? "dotnet",
    serverPath = join(extensionPath, "vendor/language-server/Bicep.LangServer.dll"),
    requestTimeout = 60000, pollInterval = 1000,
  } = {}) {
    if (!rootPath) throw new Error("BicepLanguageServer requires rootPath");
    this.rootPath = resolve(rootPath);
    this.rootUri = canonicalUri(this.rootPath);
    this.onDiagnostics = onDiagnostics;
    this.onChange = onChange;
    this.onError = onError;
    this.dotnetPath = dotnetPath;
    this.serverPath = serverPath;
    this.requestTimeout = requestTimeout;
    this.pollInterval = pollInterval;
    this.diagnostics = new Map();
    this.documents = new Map();
    this.pending = new Map();
    this.trackedFiles = new Set();
    this.snapshot = new Map();
    this.nextId = 1;
    this.state = "new";
    this.stderr = "";
    this.opening = new Map();
  }

  start() {
    if (this.state === "closed" || this.state === "closing") return Promise.reject(new Error("Language server is closed"));
    if (this.state === "failed") return Promise.reject(this.failure);
    if (!this.startPromise) this.startPromise = this._start();
    return this.startPromise;
  }

  async _start() {
    this.state = "starting";
    try {
      if (!(await stat(this.rootPath)).isDirectory()) throw new Error("rootPath must be a directory");
      await stat(this.serverPath);
      this.snapshot = await this._scan();
      if (this.state !== "starting") throw new Error("Language server start was cancelled");
      this.child = spawn(this.dotnetPath, [this.serverPath], {
        cwd: extensionPath, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
      });
      this.exitPromise = new Promise((resolveExit) => {
        this.child.once("close", (code, signal) => {
          resolveExit();
          if (this.state !== "closing" && this.state !== "closed") {
            this._fail(new Error(`Bicep language server exited (${signal || code}). ${this.stderr.trim()}`));
          }
        });
      });
      this.child.on("error", (error) => this._fail(new Error(`Cannot start Bicep language server: ${error.message}`)));
      this.child.stdin.on("error", (error) => {
        if (this.state !== "closing" && this.state !== "closed") this._fail(error);
      });
      const decoder = new ContentLengthDecoder((message) => this._receive(message));
      this.child.stdout.on("data", (chunk) => {
        try { decoder.push(chunk); } catch (error) { this._fail(error); }
      });
      this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
      this.initializeResult = await this._request("initialize", {
        processId: process.pid,
        clientInfo: { name: "bicep-visualizer", version: "1.0.0" },
        rootPath: this.rootPath,
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: basename(this.rootPath) }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } },
          textDocument: { synchronization: { dynamicRegistration: false, didSave: true }, publishDiagnostics: { relatedInformation: true } },
          window: { workDoneProgress: true },
        },
        initializationOptions: { enableTelemetry: false },
        trace: "off",
      });
      if (this.state !== "starting") throw this.failure || new Error("Language server start was cancelled");
      this._notify("initialized", {});
      this.state = "ready";
      this._schedulePoll();
      return this.initializeResult;
    } catch (error) {
      if (this.state !== "closing" && this.state !== "closed") this._fail(error);
      throw error;
    }
  }

  _callback(name, ...args) {
    try {
      const result = this[name]?.(...args);
      if (result?.catch) result.catch((error) => { if (name !== "onError") this._callback("onError", error); });
    } catch (error) {
      if (name !== "onError") this._callback("onError", error);
    }
  }

  _fail(error) {
    if (this.state === "failed" || this.state === "closed" || this.state === "closing") return;
    this.failure = error;
    this.state = "failed";
    clearTimeout(this.pollTimer);
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this._callback("onError", error);
    this._terminate();
  }

  _terminate() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    this.killTimer ??= setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 1500);
    this.killTimer.unref();
  }

  _send(message) {
    if (!this.child?.stdin.writable || this.state === "failed" || this.state === "closed") {
      throw this.failure || new Error("Language server transport is not writable");
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  _notify(method, params) { this._send({ method, params }); }

  _request(method, params, { signal, timeout = this.requestTimeout } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      let timer;
      const finish = (callback, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
        callback(value);
      };
      const reject = (error) => finish(rejectRequest, error);
      const cancel = () => {
        try { this._notify("$/cancelRequest", { id }); } catch {}
        reject(abortError());
      };
      this.pending.set(id, { resolve: (value) => finish(resolveRequest, value), reject });
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        try { this._notify("$/cancelRequest", { id }); } catch {}
        reject(new Error(`Bicep language server request timed out: ${method}`));
      }, timeout);
      try { this._send({ id, method, params }); } catch (error) { reject(error); }
    });
  }

  async request(method, params, options) {
    await this.start();
    if (this.state !== "ready") throw this.failure || new Error("Language server is not ready");
    const result = await this._request(method, params, options);
    this._trackSources(result);
    return result;
  }

  _receive(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") throw new Error("Invalid language server JSON-RPC message");
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) {
        let result = null;
        switch (message.method) {
          case "workspace/configuration":
            result = (message.params?.items || []).map(({ section }) => {
              if (section === "telemetry") return { enableTelemetry: false, telemetryLevel: "off" };
              if (section === "bicep") return { enableTelemetry: false };
              return null;
            });
            break;
          case "workspace/workspaceFolders":
            result = [{ uri: this.rootUri, name: basename(this.rootPath) }];
            break;
          case "client/registerCapability":
          case "client/unregisterCapability":
          case "window/workDoneProgress/create":
          case "window/showMessageRequest":
            break;
          case "workspace/applyEdit":
            result = { applied: false, failureReason: "The visualizer is read-only" };
            break;
          default:
            this._send({ id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } });
            return;
        }
        this._send({ id: message.id, result });
      } else if (message.method === "textDocument/publishDiagnostics") {
        const { uri, diagnostics = [], version } = message.params || {};
        if (typeof uri !== "string") return;
        const path = this._trackUri(uri);
        const normalized = path ? canonicalUri(path) : uri;
        this.diagnostics.set(normalized, diagnostics);
        this._trackSources(diagnostics);
        this._callback("onDiagnostics", { uri: normalized, diagnostics, version });
      }
      // Telemetry, log messages and progress never leave this process.
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) {
      pending.reject(Object.assign(new Error(message.error.message || "Language server request failed"), {
        code: message.error.code, data: message.error.data,
      }));
    } else pending.resolve(message.result);
  }

  _trackUri(uri) {
    try {
      if (!uri.startsWith("file:")) return;
      const path = resolve(fileURLToPath(uri));
      this.trackedFiles.add(path);
      return path;
    } catch {}
  }

  _trackSources(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 30) return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        if (/uri$/i.test(key)) this._trackUri(child);
        else if (/^(filePath|path)$/i.test(key) && isAbsolute(child) && relevant(child)) this.trackedFiles.add(resolve(child));
      } else this._trackSources(child, depth + 1);
    }
  }

  async open(filePath) {
    await this.start();
    const path = resolve(this.rootPath, filePath);
    const uri = canonicalUri(path);
    if (this.opening.has(uri)) return this.opening.get(uri);
    const operation = this._open(path, uri);
    this.opening.set(uri, operation);
    try { return await operation; } finally { this.opening.delete(uri); }
  }

  async _open(path, uri) {
    if (!/\.(bicep|bicepparam)$/i.test(path)) throw new Error("Only .bicep and .bicepparam documents can be opened");
    if (this.refreshPromise) await this.refreshPromise;
    const text = await readFile(path, "utf8");
    if (this.state !== "ready") throw this.failure || new Error("Language server is not ready");
    const document = this.documents.get(uri);
    if (!document || !document.present) {
      const version = (document?.version || 0) + 1;
      this._notify("textDocument/didOpen", {
        textDocument: { uri, languageId: path.endsWith(".bicepparam") ? "bicep-params" : "bicep", version, text },
      });
      this.documents.set(uri, { path, text, version, present: true });
    } else if (document.text !== text) {
      document.text = text;
      this._notify("textDocument/didChange", {
        textDocument: { uri, version: ++document.version }, contentChanges: [{ text }],
      });
    }
    this.trackedFiles.add(path);
    return uri;
  }

  _schedulePoll() {
    if (this.state !== "ready" || this.pollInterval <= 0) return;
    this.pollTimer = setTimeout(async () => {
      try { await this.refresh(); } catch (error) { this._callback("onError", error); }
      this._schedulePoll();
    }, this.pollInterval);
    this.pollTimer.unref();
  }

  async _scan() {
    const paths = new Set(this.trackedFiles);
    const walk = async (directory) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries) {
        if ([".git", "node_modules", "bin", "obj", ".terraform", ".turbo"].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (relevant(path)) paths.add(path);
      }
    };
    await walk(this.rootPath);
    // Config discovery follows Bicep's upward search, including absent configs so
    // a later creation outside the workspace is observed.
    const addConfigs = (path) => {
      for (let directory = dirname(path);;) {
        paths.add(join(directory, "bicepconfig.json"));
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    };
    for (const path of paths) if (/\.(bicep|bicepparam)$/i.test(path)) addConfigs(path);
    const next = new Map();
    for (const path of paths) {
      let info;
      try { info = await stat(path); } catch (error) { if (missing(error)) continue; throw error; }
      if (!info.isFile()) continue;
      const previous = this.snapshot.get(path);
      let text;
      try {
        text = previous && previous.mtime === info.mtimeMs && previous.ctime === info.ctimeMs && previous.size === info.size
          ? previous.text : await readFile(path, "utf8");
      } catch (error) { if (missing(error)) continue; throw error; }
      next.set(path, { mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size, text });
      if (/\.(bicep|bicepparam)$/i.test(path)) {
        // Local module/using/import references. Registry references are learned
        // from server diagnostics and source responses after normal restore.
        for (const match of text.matchAll(/'([^'\r\n]+\.(?:bicep|bicepparam))'/gi)) {
          const reference = match[1];
          if (reference.includes("${") || /^[a-z][a-z\d+.-]*:/i.test(reference)) continue;
          const dependency = resolve(dirname(path), reference);
          this.trackedFiles.add(dependency);
          paths.add(dependency);
          addConfigs(dependency);
        }
        for (const match of text.matchAll(/\bload(?:TextContent|JsonContent|YamlContent|FileAsBase64)\s*\(\s*'([^'\r\n]+)'/g)) {
          if (match[1].includes("${") || /^[a-z][a-z\d+.-]*:/i.test(match[1])) continue;
          const dependency = resolve(dirname(path), match[1]);
          this.trackedFiles.add(dependency);
          paths.add(dependency);
        }
      }
    }
    return next;
  }

  async refresh() {
    await this.start();
    if (!this.refreshPromise) {
      this.refreshPromise = this._refresh().finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async _refresh() {
    const next = await this._scan();
    if (this.state !== "ready") throw this.failure || new Error("Language server is not ready");
    const changes = [];
    for (const [path, value] of next) {
      const old = this.snapshot.get(path);
      if (!old || old.text !== value.text) changes.push({ uri: canonicalUri(path), type: old ? 2 : 1 });
    }
    for (const path of this.snapshot.keys()) {
      if (!next.has(path)) changes.push({ uri: canonicalUri(path), type: 3 });
    }
    this.snapshot = next;
    if (!changes.length) return [];
    for (const { uri, type } of changes) {
      const document = this.documents.get(uri);
      if (!document) continue;
      if (type === 3) {
        if (document.present) this._notify("textDocument/didClose", { textDocument: { uri } });
        document.present = false;
      } else {
        const text = next.get(document.path).text;
        if (!document.present) {
          this._notify("textDocument/didOpen", {
            textDocument: { uri, languageId: document.path.endsWith(".bicepparam") ? "bicep-params" : "bicep", version: ++document.version, text },
          });
          document.present = true;
        } else if (document.text !== text) {
          this._notify("textDocument/didChange", {
            textDocument: { uri, version: ++document.version }, contentChanges: [{ text }],
          });
        }
        document.text = text;
      }
    }
    this._notify("workspace/didChangeWatchedFiles", { changes });
    this._callback("onChange", changes);
    return changes;
  }

  close() {
    if (!this.closePromise) this.closePromise = this._close();
    return this.closePromise;
  }

  async _close() {
    const wasReady = this.state === "ready";
    this.state = "closing";
    clearTimeout(this.pollTimer);
    for (const pending of [...this.pending.values()]) pending.reject(abortError());
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (this.refreshPromise) await this.refreshPromise.catch(() => {});
    if (wasReady && this.child?.stdin.writable) {
      for (const [uri, document] of this.documents) {
        if (document.present) {
          try { this._notify("textDocument/didClose", { textDocument: { uri } }); } catch {}
        }
      }
      try { await this._request("shutdown", null, { timeout: 1500 }); } catch {}
      try { this._notify("exit"); } catch {}
      this.child.stdin.end();
    }
    this._terminate();
    if (this.exitPromise) await this.exitPromise;
    clearTimeout(this.killTimer);
    this.documents.clear();
    this.opening.clear();
    this.trackedFiles.clear();
    this.snapshot.clear();
    this.state = "closed";
  }
}
