import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export const BICEP_RELEASE = Object.freeze({
  version: "v0.46.1",
  archiveUrl: "https://github.com/Azure/bicep/releases/download/v0.46.1/bicep-langserver.zip",
  archiveSha256: "b8224c8e941cde9698747ddd97c930a25097bf688e4e43e4acdd21ca8c24656a",
  languageServerSha256: "2756e192acbcc8a1a84b41c54b48349381a3b4cd3c38b6f1fc568207ccb71513",
  fileCount: 241,
});

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const markerName = ".installed-bicep-langserver.json";
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const missing = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const nonce = () => `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

async function readManifest(manifestPath, expectedCount, label) {
  const content = await readFile(manifestPath, "utf8");
  const files = new Map();
  for (const line of content.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid ${label} checksum manifest: ${manifestPath}`);
    const relative = match[2];
    if (isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || relative.includes("\0")) {
      throw new Error(`Unsafe path in ${label} checksum manifest: ${relative}`);
    }
    if (files.has(relative)) throw new Error(`Duplicate path in ${label} checksum manifest: ${relative}`);
    files.set(relative, match[1]);
  }
  if (files.size !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${label} checksums, found ${files.size}.`);
  }
  return { files, sha256: createHash("sha256").update(content).digest("hex") };
}

async function walkFiles(root) {
  const files = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Unsupported language-server archive entry: ${relative}`);
    }
  }
  try { await walk(root); } catch (error) { if (missing(error)) return null; throw error; }
  return files.sort();
}

async function validateRuntime(root, manifest) {
  const actual = await walkFiles(root);
  if (!actual || actual.length !== manifest.files.size) return false;
  const expected = [...manifest.files.keys()].sort();
  if (actual.some((path, index) => path !== expected[index])) return false;
  for (const [relative, checksum] of manifest.files) {
    const path = join(root, ...relative.split("/"));
    if (await sha256(path) !== checksum) return false;
  }
  return true;
}

async function readMarker(path, expected) {
  try {
    const marker = JSON.parse(await readFile(path, "utf8"));
    return Object.entries(expected).every(([key, value]) => marker[key] === value);
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function writeMarker(path, marker) {
  const temporary = `${path}.${nonce()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

async function validateInstall(runtime, markerPath, manifest, marker) {
  return await readMarker(markerPath, marker) && await validateRuntime(runtime, manifest);
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.once("error", (error) => rejectRun(new Error(`Cannot run ${command}: ${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true });
  if (process.platform !== "win32") {
    try {
      await run("unzip", ["-q", archive, "-d", destination]);
      return;
    } catch (error) {
      throw new Error(`Could not extract bicep-langserver.zip. Install unzip and reload extensions. ${error.message}`);
    }
  }
  try {
    await run("tar", ["-xf", archive, "-C", destination]);
    return;
  } catch (tarError) {
    try {
      await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }",
        archive, destination,
      ]);
      return;
    } catch (powershellError) {
      throw new Error(`Could not extract bicep-langserver.zip with tar or PowerShell. ${tarError.message}; ${powershellError.message}`);
    }
  }
}

async function downloadArchive(destination, archivePath, fetchImpl) {
  if (archivePath) {
    await copyFile(resolve(archivePath), destination);
    return;
  }
  if (typeof fetchImpl !== "function") throw new Error("This GitHub Copilot runtime does not provide fetch.");
  const response = await fetchImpl(BICEP_RELEASE.archiveUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Azure Bicep download failed with HTTP ${response.status} ${response.statusText}.`);
  }
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error(`Azure Bicep download redirected to a non-HTTPS URL: ${response.url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function staleLock(lock, staleMilliseconds) {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    return !processAlive(owner.pid);
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    try {
      const info = await stat(lock);
      return Date.now() - info.mtimeMs > staleMilliseconds;
    } catch (statError) {
      if (missing(statError)) return false;
      throw statError;
    }
  }
}

async function removeOwnedLock(lock, token, reason) {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (token && owner.token !== token) return false;
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    if (token) return false;
  }
  const quarantine = `${lock}.${reason}-${nonce()}`;
  try { await rename(lock, quarantine); }
  catch (error) { if (missing(error)) return false; throw error; }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function removeStaleLock(lock, staleMilliseconds) {
  const takeover = `${lock}.takeover`;
  try { await mkdir(takeover); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  try {
    if (!(await staleLock(lock, staleMilliseconds))) return false;
    await rm(lock, { recursive: true, force: true });
    return true;
  } finally {
    await rm(takeover, { recursive: true, force: true });
  }
}

async function acquireLock(lock, ready, {
  lockTimeout = 5 * 60 * 1000,
  staleLockTimeout = 15 * 60 * 1000,
  pollInterval = 250,
} = {}) {
  const started = Date.now();
  while (true) {
    const token = nonce();
    try {
      await mkdir(lock);
      try {
        await writeFile(join(lock, "owner.json"), `${JSON.stringify({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString(),
        })}\n`, { flag: "wx" });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      return async () => { await removeOwnedLock(lock, token, "release"); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await ready()) return null;
      if (await removeStaleLock(lock, staleLockTimeout)) {
        continue;
      }
      if (Date.now() - started > lockTimeout) {
        throw new Error(`Timed out waiting for another Bicep Visualizer process to finish setup. Remove ${lock} if no Copilot process is running.`);
      }
      await delay(pollInterval);
    }
  }
}

async function cleanupArchives(cacheRoot) {
  for (const name of await readdir(cacheRoot)) {
    if (name.startsWith(".bicep-langserver-") && name.endsWith(".zip")) {
      await rm(join(cacheRoot, name), { force: true });
    }
  }
}

async function cleanupCandidates(cacheRoot, component, keep = new Set()) {
  for (const name of await readdir(cacheRoot)) {
    if (!name.startsWith(`.${component}.stage-`) && !name.startsWith(`.${component}.backup-`)) continue;
    const path = join(cacheRoot, name);
    if (!keep.has(path)) await rm(path, { recursive: true, force: true });
  }
}

async function recover(cacheRoot, runtime, markerPath, manifest, marker, component) {
  if (await validateRuntime(runtime, manifest)) {
    if (!(await readMarker(markerPath, marker))) await writeMarker(markerPath, marker);
    await cleanupCandidates(cacheRoot, component);
    return true;
  }
  const entries = (await readdir(cacheRoot))
    .filter((name) => name.startsWith(`.${component}.stage-`) || name.startsWith(`.${component}.backup-`))
    .sort().reverse();
  for (const name of entries) {
    const candidate = join(cacheRoot, name);
    if (!(await validateRuntime(candidate, manifest))) continue;
    await rm(runtime, { recursive: true, force: true });
    await rename(candidate, runtime);
    await writeMarker(markerPath, marker);
    await cleanupCandidates(cacheRoot, component);
    return true;
  }
  await cleanupCandidates(cacheRoot, component);
  return false;
}

export function defaultCacheRoot() {
  const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
  return resolve(process.env.BICEP_VISUALIZER_CACHE || join(copilotHome, "cache", "bicep-visualizer", BICEP_RELEASE.version));
}

export async function ensureLanguageServer({
  extensionRoot = moduleRoot,
  cacheRoot = defaultCacheRoot(),
  archivePath = process.env.BICEP_VISUALIZER_LANGSERVER_ARCHIVE,
  fetchImpl = globalThis.fetch,
  lockOptions,
} = {}) {
  const manifest = await readManifest(
    join(extensionRoot, "language-server.sha256"),
    BICEP_RELEASE.fileCount,
    "language-server",
  );
  const expectedMarker = {
    version: BICEP_RELEASE.version,
    archiveUrl: BICEP_RELEASE.archiveUrl,
    archiveSha256: BICEP_RELEASE.archiveSha256,
    manifestSha256: manifest.sha256,
  };
  const bundledRuntime = join(extensionRoot, "vendor", "language-server");
  const bundledMarker = join(extensionRoot, "vendor", markerName);
  if (await validateInstall(bundledRuntime, bundledMarker, manifest, expectedMarker)) {
    return join(bundledRuntime, "Bicep.LangServer.dll");
  }

  const root = resolve(cacheRoot);
  const runtime = join(root, "language-server");
  const marker = join(root, markerName);
  const lock = join(root, ".install-lock");
  await mkdir(root, { recursive: true });
  const ready = () => validateInstall(runtime, marker, manifest, expectedMarker);
  if (await ready()) return join(runtime, "Bicep.LangServer.dll");

  const releaseLock = await acquireLock(lock, ready, lockOptions);
  if (!releaseLock) return join(runtime, "Bicep.LangServer.dll");
  try {
    await cleanupArchives(root);
    if (await recover(root, runtime, marker, manifest, expectedMarker, "language-server")) {
      return join(runtime, "Bicep.LangServer.dll");
    }

    const id = nonce();
    const archive = join(root, `.bicep-langserver-${id}.zip`);
    const stage = join(root, `.language-server.stage-${id}`);
    const backup = join(root, `.language-server.backup-${id}`);
    try {
      await downloadArchive(archive, archivePath, fetchImpl);
      const archiveChecksum = await sha256(archive);
      if (archiveChecksum !== BICEP_RELEASE.archiveSha256) {
        throw new Error(`Refusing Azure Bicep archive with SHA-256 ${archiveChecksum}; expected ${BICEP_RELEASE.archiveSha256}.`);
      }
      await extractArchive(archive, stage);
      if (!(await validateRuntime(stage, manifest))) {
        throw new Error("Extracted Azure Bicep language-server files do not match the pinned v0.46.1 checksum manifest.");
      }

      if (await exists(runtime)) await rename(runtime, backup);
      try {
        await rename(stage, runtime);
        await writeMarker(marker, expectedMarker);
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        if (!(await exists(runtime)) && await exists(backup)) await rename(backup, runtime);
        throw error;
      }
    } finally {
      await rm(archive, { force: true });
      await rm(stage, { recursive: true, force: true });
    }
    return join(runtime, "Bicep.LangServer.dll");
  } catch (error) {
    throw new Error(`Bicep Visualizer could not prepare Azure Bicep ${BICEP_RELEASE.version}: ${error.message} Check network access to github.com and write access to ${root}, then reload extensions.`);
  } finally {
    await releaseLock();
  }
}

async function unpackRenderer(extensionRoot, destination, manifest) {
  const files = new Map();
  for (const name of ["renderer.bundle-1.json", "renderer.bundle-2.json"]) {
    const bundle = JSON.parse(await readFile(join(extensionRoot, name), "utf8"));
    if (!bundle || typeof bundle.files !== "object" || Array.isArray(bundle.files)) {
      throw new Error(`Invalid renderer text bundle: ${name}`);
    }
    for (const [relative, content] of Object.entries(bundle.files)) {
      if (!manifest.files.has(relative)) throw new Error(`Unexpected renderer bundle path: ${relative}`);
      if (files.has(relative)) throw new Error(`Duplicate renderer bundle path: ${relative}`);
      if (typeof content !== "string") throw new Error(`Renderer bundle entry is not text: ${relative}`);
      files.set(relative, content);
    }
  }
  if (files.size !== manifest.files.size) {
    throw new Error(`Expected ${manifest.files.size} renderer files in text bundles, found ${files.size}.`);
  }
  for (const [relative, content] of files) {
    const path = join(destination, ...relative.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  }
}

export async function ensureRenderer({
  extensionRoot = moduleRoot,
  cacheRoot = defaultCacheRoot(),
  lockOptions,
} = {}) {
  const manifest = await readManifest(join(extensionRoot, "renderer.sha256"), 154, "renderer");
  const expectedMarker = {
    version: BICEP_RELEASE.version,
    source: "committed-text-bundles",
    manifestSha256: manifest.sha256,
  };
  const root = resolve(cacheRoot);
  const renderer = join(root, "renderer");
  const marker = join(root, ".installed-bicep-renderer.json");
  const lock = join(root, ".renderer-install-lock");
  await mkdir(root, { recursive: true });
  const ready = () => validateInstall(renderer, marker, manifest, expectedMarker);
  if (await ready()) return renderer;

  const releaseLock = await acquireLock(lock, ready, lockOptions);
  if (!releaseLock) return renderer;
  try {
    if (await recover(root, renderer, marker, manifest, expectedMarker, "renderer")) return renderer;
    const id = nonce();
    const stage = join(root, `.renderer.stage-${id}`);
    const backup = join(root, `.renderer.backup-${id}`);
    try {
      await mkdir(stage);
      await unpackRenderer(extensionRoot, stage, manifest);
      if (!(await validateRuntime(stage, manifest))) {
        throw new Error("Reconstructed renderer files do not match the pinned v0.46.1 checksum manifest.");
      }
      if (await exists(renderer)) await rename(renderer, backup);
      try {
        await rename(stage, renderer);
        await writeMarker(marker, expectedMarker);
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        if (!(await exists(renderer)) && await exists(backup)) await rename(backup, renderer);
        throw error;
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    return renderer;
  } catch (error) {
    throw new Error(`Bicep Visualizer could not prepare the renderer: ${error.message} Check write access to ${root}, then reload extensions.`);
  } finally {
    await releaseLock();
  }
}

export async function ensureBicepRuntime(options = {}) {
  const [serverPath, rendererPath] = await Promise.all([
    ensureLanguageServer(options),
    ensureRenderer(options),
  ]);
  return { serverPath, rendererPath };
}
