/**
 * Lets a grist-oss installation convert itself into the full edition at runtime,
 * instead of switching to the `grist`/`grist-ee` images.
 *
 * We download a complete, self-contained copy of the full edition (the exact `grist`
 * image app payload) into a writable directory and run that instead of the baked-in
 * OSS build:
 *   - `resolveFullEditionWorker()` is consulted by the RestartShell on every fork. If a
 *     valid, current copy is on disk it returns the fork spec for the relocated worker;
 *     otherwise the baked-in OSS worker runs.
 *   - `maybeManageFullEdition()` runs at boot and makes the on-disk copy match the
 *     `useExternalFullEdition` home-DB flag -- downloading it when enabled, removing it
 *     when disabled -- then requests a restart so the resolver picks the right worker.
 *
 * The choice is persisted as the `useExternalFullEdition` install pref, so every server
 * in a multi-server deployment converges on its next boot. Each server must use its own
 * GRIST_FULL_EDITION_DIR; sharing one across servers is not supported.
 *
 * Active only when GRIST_FULL_EDITION_DIR and GRIST_FULL_EDITION_REF are set (the
 * grist-oss image; see Dockerfile). Clearing those is an operator kill-switch that stops
 * new conversions even if the pref is set, and makes a booting server ignore the pref
 * and come up on the baked-in OSS build.
 */

import { delay } from "app/common/delay";
import { ActivationsManager } from "app/gen-server/lib/ActivationsManager";
import { HomeDBManager } from "app/gen-server/lib/homedb/HomeDBManager";
import { Edition } from "app/server/lib/configCore";
import { getGlobalConfig } from "app/server/lib/globalConfig";
import log from "app/server/lib/log";
import { ForkSpec } from "app/server/lib/RestartShell";

import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as stream from "stream";
import { promisify } from "util";

import * as fse from "fs-extra";
import { AbortController } from "node-abort-controller";
import fetch from "node-fetch";
import * as tar from "tar";

const pipeline = promisify(stream.pipeline);

export const Deps = {
  // Generous download timeout: full edition tarball is 100+ MBs.
  downloadTimeoutMs: 15 * 60 * 1000,
  // Bounded install retries within a single boot (covers a transient download
  // failure), then we give up and stay on core for this boot. A later restart
  // retries from scratch.
  installAttempts: 3,
  installRetryDelayMs: 10 * 1000,
};

// Marker file written (last) into the runtime dir, holding the installed ref.
const STAMP_FILE = ".grist-full-edition-stamp";

// Subdirectories of GRIST_FULL_EDITION_DIR that hold the downloaded payload.
const PAYLOAD_SUBDIRS = ["grist", "node_modules"];

/**
 * If a valid, current full-edition copy is present on disk, returns the fork spec to
 * run it (the RestartShell forks this instead of the baked-in OSS worker), else null.
 * Pure filesystem check with no DB access, so it's cheap to call on every fork. Never throws.
 */
export function resolveFullEditionWorker(): ForkSpec | null {
  try {
    const dir = process.env.GRIST_FULL_EDITION_DIR;
    const ref = process.env.GRIST_FULL_EDITION_REF;
    if (!dir || !ref) { return null; }
    let stamp: string;
    try {
      stamp = fse.readFileSync(path.join(dir, STAMP_FILE), "utf8").trim();
    } catch (e) {
      // No stamp = no installed copy yet (the common pre-conversion case, and the
      // expected state on the refork right after enabling). Fall back to baked-in
      // OSS quietly; only an unexpected read error is worth warning about.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("bootstrapFullEdition: cannot read full-edition stamp, using baked-in: %s", e);
      }
      return null;
    }
    if (stamp !== ref) { return null; }

    const root = path.join(dir, "grist");
    return {
      entryPoint: path.join(root, "_build", "stubs", "app", "server", "server.js"),
      cwd: root,
      env: {
        // Resolve the relocated tree's compiled code. node_modules (core under
        // `${root}/node_modules`, ext under `${dir}/node_modules`) are found by
        // Node's standard walk-up from the worker's location.
        NODE_PATH: [
          path.join(root, "_build"),
          path.join(root, "_build", "ext"),
          path.join(root, "_build", "stubs"),
        ].join(path.delimiter),
        // Deliberately no GRIST_FORCE_ENABLE_ENTERPRISE: forcing it would lock the admin
        // UI into a revert-only state. The relocated worker instead derives enterprise mode
        // from the `edition` config, which maybeManageFullEdition() keeps in sync, so the
        // converted server presents as a normal, switchable full-edition install.
      },
    };
  } catch (e) {
    log.warn("bootstrapFullEdition: resolveFullEditionWorker failed, using baked-in: %s", e);
    return null;
  }
}

/**
 * Whether the runtime external-full-edition switch is available on this image: the
 * payload coordinates (GRIST_FULL_EDITION_DIR / _REF) are baked in (grist-oss). Shared by
 * the admin UI, the install-prefs endpoint, and maybeManageFullEdition, so unsetting those
 * env vars is a real operator kill-switch (not just a UI hint): the feature disappears
 * from the UI and a booting server ignores the pref and comes up on the baked-in OSS build.
 */
export function isExternalFullEditionConfigured(): boolean {
  return Boolean(process.env.GRIST_FULL_EDITION_DIR) &&
    Boolean(process.env.GRIST_FULL_EDITION_REF);
}

/**
 * Make the on-disk full-edition copy match the desired state (per the home-DB flag),
 * downloading or removing it as needed. Returns whether a restart was requested,
 * in which case the caller should ask the RestartShell to refork (so the resolver
 * picks the right worker). Safe to call on every boot in either worker; a no-op
 * when already in the desired state, or when the feature isn't configured.
 */
export async function maybeManageFullEdition(): Promise<{ restartRequested: boolean }> {
  const dir = process.env.GRIST_FULL_EDITION_DIR;
  const ref = process.env.GRIST_FULL_EDITION_REF;
  // No-op unless configured. The `!dir || !ref` also narrows them to strings.
  if (!isExternalFullEditionConfigured() || !dir || !ref) {
    return { restartRequested: false };
  }

  const enabled = await isFullEditionEnabled();
  const current = await isStampCurrent(dir, ref);

  if (enabled && !current) {
    // Convert (or update after a version bump): fetch the matching copy. Retry a few
    // times in case of a transient download failure, then give up and stay on core for
    // this boot (a later restart retries).
    for (let attempt = 1; attempt <= Deps.installAttempts; attempt++) {
      try {
        const installed = await downloadAndInstall(dir, ref);
        // Mark the config enterprise only now that the copy is installed, so a failed
        // download can't leave the core worker labelled enterprise. Still before the
        // restart, so the relocated worker boots with it.
        await syncEditionConfig(true);
        return { restartRequested: installed };
      } catch (e) {
        const willRetry = attempt < Deps.installAttempts;
        log.error("bootstrapFullEdition: install attempt %d/%d failed%s: %s",
          attempt, Deps.installAttempts, willRetry ? ", retrying" : "; giving up, staying on core", e);
        if (willRetry) { await delay(Deps.installRetryDelayMs); }
      }
    }
    return { restartRequested: false };
  }

  // Keep the `edition` config in sync for the cases that don't install. The relocated worker
  // derives enterprise mode from it (not GRIST_FORCE_ENABLE_ENTERPRISE), and both workers
  // share GRIST_INST_DIR. Written before any restart so it's in place for the next fork.
  await syncEditionConfig(enabled);

  if (!enabled && current) {
    // Revert: we're running the relocated full edition. Drop the stamp so the next fork
    // falls back to the baked-in OSS worker, and request a restart. Do NOT delete the
    // payload here -- we're executing from it; the OSS worker reclaims it after the refork.
    await fse.remove(path.join(dir, STAMP_FILE)).catch(() => undefined);
    log.info("bootstrapFullEdition: full edition disabled; reverting to core on restart");
    return { restartRequested: true };
  }

  if (!enabled) {
    // Not running the full edition, but a stamp and/or downloaded payload may linger
    // (the second half of a revert, an interrupted delete, or a stale copy after a
    // version bump). It's safe to reclaim the disk now since the baked-in OSS worker
    // doesn't run from `dir`; a re-enable re-downloads from scratch.
    await reclaimFullEditionDir(dir);
  }

  return { restartRequested: false };
}

// Remove the downloaded full-edition payload (stamp first, so the resolver immediately
// falls back to baked-in OSS, then the large subdirs) to reclaim disk. Best-effort: a
// partial removal is finished on a later boot, since this runs whenever the feature is
// disabled and anything remains. Must only be called when NOT executing from the payload.
async function reclaimFullEditionDir(dir: string): Promise<void> {
  const remnants = [STAMP_FILE, ...PAYLOAD_SUBDIRS].map(name => path.join(dir, name));
  if (!(await anyPathExists(remnants))) { return; }
  log.info("bootstrapFullEdition: removing unused full-edition copy to reclaim disk");
  // Stamp first: invalidates the resolver before the (slower) payload delete.
  for (const p of remnants) {
    await fse.remove(p).catch(() => undefined);
  }
}

// Make the persisted `edition` config match whether full edition is enabled, so the
// relocated full-edition worker boots into the right edition (it reads this config rather
// than GRIST_FORCE_ENABLE_ENTERPRISE). Only writes on an actual change.
async function syncEditionConfig(enabled: boolean): Promise<void> {
  const desired: Edition = enabled ? "enterprise" : "core";
  const edition = getGlobalConfig().edition;
  if (edition.get() === desired) { return; }
  log.info("bootstrapFullEdition: setting edition config to %s", desired);
  await edition.set(desired);
}

async function isFullEditionEnabled(): Promise<boolean> {
  // Throwaway HomeDBManager, mirroring initializeAppSettings().
  const db = new HomeDBManager();
  await db.connect();
  const activation = await new ActivationsManager(db).current();
  return Boolean(activation.prefs?.useExternalFullEdition);
}

async function isStampCurrent(dir: string, ref: string): Promise<boolean> {
  try {
    const stamp = await fse.readFile(path.join(dir, STAMP_FILE), "utf8");
    return stamp.trim() === ref;
  } catch {
    return false;
  }
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (await fse.pathExists(p)) { return true; }
  }
  return false;
}

/**
 * Download and install the full-edition copy into `dir`. Returns true once installed.
 * Throws on download/verification/extraction failure. Each server uses its own `dir`
 * (shared dirs are unsupported), so no cross-process locking is needed; the
 * staging->swap below keeps a crash mid-install from leaving a partial tree behind.
 */
async function downloadAndInstall(dir: string, ref: string): Promise<boolean> {
  const arch = dockerArch();
  if (!arch) {
    throw new Error(`unsupported architecture ${process.arch}`);
  }

  await fse.mkdirp(dir);

  const stagingDir = `${dir}.staging`;
  const oldDir = `${dir}.old`;
  const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), "grist-full-edition-dl-"));
  try {
    log.info("bootstrapFullEdition: downloading full edition (ref %s, arch %s)", ref, arch);
    const tarball = path.join(tmpDir, "grist-full-edition.tar.gz");
    // The publisher bakes the exact per-arch download URL into the image, so we fetch it
    // verbatim; download() verifies the bytes against the baked checksum.
    const url = expectedUrl(arch);
    if (!url) { throw new Error(`missing full-edition download URL for arch ${arch}`); }
    await download(url, tarball, expectedSha(arch));

    // Extract into a staging dir, then swap into place, so a crash mid-extract
    // never leaves a partially-populated runtime dir that the resolver would run.
    await fse.remove(stagingDir);
    await fse.mkdirp(stagingDir);
    // The payload contains links (e.g. the pyodide deno binary); node-tar resolves them
    // against the extraction dir, and auto-detects the gzip.
    await tar.x({ file: tarball, cwd: stagingDir });  // -> grist/, node_modules/
    await fse.writeFile(path.join(stagingDir, STAMP_FILE), ref);  // commit marker, last

    await fse.remove(oldDir);
    await fse.move(dir, oldDir, { overwrite: true });
    await fse.move(stagingDir, dir, { overwrite: true });
    await fse.remove(oldDir).catch(() => undefined);

    log.info("bootstrapFullEdition: installed full edition; requesting restart");
    return true;
  } finally {
    await fse.remove(tmpDir).catch(() => undefined);
    await fse.remove(stagingDir).catch(() => undefined);
  }
}

async function download(url: string, dest: string, expectedSha256?: string): Promise<void> {
  if (!expectedSha256) {
    // Refuse to install unverified content. A missing baked-in checksum means the
    // image wasn't built with the expected metadata.
    throw new Error(`missing expected checksum for ${url}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Deps.downloadTimeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) { throw new Error(`download failed (${res.status}) for ${url}`); }
    if (!res.body) { throw new Error(`download failed (empty response body) for ${url}`); }
    await pipeline(res.body, fse.createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
  const actual = await sha256File(dest);
  if (normalizeSha(actual) !== normalizeSha(expectedSha256)) {
    throw new Error(`checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fse.createReadStream(file), hash);
  return hash.digest("hex");
}

function normalizeSha(s: string): string {
  return s.trim().toLowerCase().replace(/^sha256[:-]/, "");
}

// Maps process.arch onto the Docker arch used to select the baked per-arch URL/checksum.
function dockerArch(): string | undefined {
  switch (process.arch) {
    case "x64": return "amd64";
    case "arm64": return "arm64";
    default: return undefined;
  }
}

function expectedSha(arch: string): string | undefined {
  return arch === "amd64" ?
    process.env.GRIST_FULL_EDITION_SHA256_AMD64 :
    process.env.GRIST_FULL_EDITION_SHA256_ARM64;
}

// The publisher bakes the exact per-arch download URL into the image (see the
// GRIST_FULL_EDITION_URL_* build args in the Dockerfile / docker workflows).
function expectedUrl(arch: string): string | undefined {
  return arch === "amd64" ?
    process.env.GRIST_FULL_EDITION_URL_AMD64 :
    process.env.GRIST_FULL_EDITION_URL_ARM64;
}
