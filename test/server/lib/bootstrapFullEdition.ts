import { ActivationsManager } from "app/gen-server/lib/ActivationsManager";
import { HomeDBManager } from "app/gen-server/lib/homedb/HomeDBManager";
import {
  Deps, maybeManageFullEdition, resolveFullEditionWorker,
} from "app/server/lib/bootstrapFullEdition";
import { Edition } from "app/server/lib/configCore";
import * as globalConfig from "app/server/lib/globalConfig";
import { createInitialDb, removeConnection, setUpDB } from "test/gen-server/seed";
import * as testUtils from "test/server/testUtils";
import { EnvironmentSnapshot } from "test/server/testUtils";

import * as crypto from "crypto";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

import { assert } from "chai";
import * as fse from "fs-extra";
import sinon from "sinon";
import * as tar from "tar";

const STAMP_FILE = ".grist-full-edition-stamp";
const REF = "test-ref-1";

describe("bootstrapFullEdition", function() {
  this.timeout(30000);
  testUtils.setTmpLogLevel("error");

  let oldEnv: EnvironmentSnapshot;
  const sandbox = sinon.createSandbox();

  before(function() {
    oldEnv = new EnvironmentSnapshot();
  });

  after(function() {
    oldEnv.restore();
  });

  describe("resolveFullEditionWorker", function() {
    let dir: string;

    beforeEach(async function() {
      dir = await fse.mkdtemp(path.join(os.tmpdir(), "grist-fe-dir-"));
      process.env.GRIST_FULL_EDITION_DIR = dir;
      process.env.GRIST_FULL_EDITION_REF = REF;
    });

    afterEach(async function() {
      await fse.remove(dir).catch(() => undefined);
      sandbox.restore();
    });

    it("returns the relocated fork spec when a current copy is on disk", async function() {
      await fse.writeFile(path.join(dir, STAMP_FILE), `${REF}\n`);

      const spec = resolveFullEditionWorker();
      assert.isNotNull(spec);
      const root = path.join(dir, "grist");
      assert.equal(spec!.entryPoint, path.join(root, "_build", "stubs", "app", "server", "server.js"));
      assert.equal(spec!.cwd, root);
      assert.equal(spec!.env!.NODE_PATH, [
        path.join(root, "_build"),
        path.join(root, "_build", "ext"),
        path.join(root, "_build", "stubs"),
      ].join(path.delimiter));
    });

    it("returns null when there is no stamp", function() {
      assert.isNull(resolveFullEditionWorker());
    });

    it("returns null when the stamp is stale", async function() {
      await fse.writeFile(path.join(dir, STAMP_FILE), "some-other-ref");
      assert.isNull(resolveFullEditionWorker());
    });

    it("returns null when the env vars are unset", function() {
      delete process.env.GRIST_FULL_EDITION_DIR;
      delete process.env.GRIST_FULL_EDITION_REF;
      assert.isNull(resolveFullEditionWorker());
    });

    it("returns null and never throws on an unreadable stamp", async function() {
      // A directory in the stamp's place makes readFileSync throw a non-ENOENT error.
      await fse.mkdirp(path.join(dir, STAMP_FILE));
      assert.isNull(resolveFullEditionWorker());
    });
  });

  describe("maybeManageFullEdition", function() {
    let dir: string;
    let fileServer: http.Server | undefined;
    // In-memory stand-in for the persisted `edition` config, so the test never writes a
    // config.json (getGlobalConfig's path is fixed at module load, outside our control).
    let editionValue: Edition;

    before(async function() {
      await removeConnection();
      process.env.TYPEORM_DATABASE = ":memory:";
      setUpDB(this);
      await createInitialDb();
    });

    after(async function() {
      await removeConnection();
    });

    beforeEach(async function() {
      dir = await fse.mkdtemp(path.join(os.tmpdir(), "grist-fe-dir-"));
      process.env.GRIST_FULL_EDITION_DIR = dir;
      process.env.GRIST_FULL_EDITION_REF = REF;
      editionValue = "core";
      sandbox.stub(globalConfig, "getGlobalConfig").returns({
        edition: {
          get: () => editionValue,
          set: async (value: Edition) => { editionValue = value; },
        },
      } as any);
    });

    afterEach(async function() {
      sandbox.restore();
      if (fileServer) { fileServer.close(); fileServer = undefined; }
      for (const p of [dir, `${dir}.staging`, `${dir}.old`]) {
        await fse.remove(p).catch(() => undefined);
      }
    });

    async function setUseExternalFullEdition(value: boolean): Promise<void> {
      const db = new HomeDBManager();
      await db.connect();
      await new ActivationsManager(db).updatePrefs({ useExternalFullEdition: value });
    }

    function edition(): Edition {
      return editionValue;
    }

    async function writeStamp(ref: string): Promise<void> {
      await fse.writeFile(path.join(dir, STAMP_FILE), ref);
    }

    async function makePayloadDirs(): Promise<void> {
      await fse.mkdirp(path.join(dir, "grist"));
      await fse.mkdirp(path.join(dir, "node_modules"));
    }

    it("is a no-op when the feature is not configured", async function() {
      // Unsetting the payload env vars is the operator kill-switch: the feature goes away
      // even with the pref set.
      delete process.env.GRIST_FULL_EDITION_REF;
      await setUseExternalFullEdition(true);
      await makePayloadDirs();
      await writeStamp("stale");

      const { restartRequested } = await maybeManageFullEdition();
      assert.isFalse(restartRequested);
      // Nothing on disk touched.
      assert.isTrue(await fse.pathExists(path.join(dir, STAMP_FILE)));
      assert.isTrue(await fse.pathExists(path.join(dir, "grist")));
    });

    it("reverts: drops the stamp and requests restart without deleting the payload", async function() {
      editionValue = "enterprise";
      await setUseExternalFullEdition(false);
      await makePayloadDirs();
      await writeStamp(REF);

      const { restartRequested } = await maybeManageFullEdition();
      assert.isTrue(restartRequested);
      assert.equal(edition(), "core");
      assert.isFalse(await fse.pathExists(path.join(dir, STAMP_FILE)), "stamp should be dropped");
      // We're notionally executing from the payload, so it must NOT be deleted here.
      assert.isTrue(await fse.pathExists(path.join(dir, "grist")));
      assert.isTrue(await fse.pathExists(path.join(dir, "node_modules")));
    });

    it("already current: keeps edition in sync and requests no restart", async function() {
      await setUseExternalFullEdition(true);
      await makePayloadDirs();
      await writeStamp(REF);

      const { restartRequested } = await maybeManageFullEdition();
      assert.isFalse(restartRequested);
      assert.equal(edition(), "enterprise");
      assert.isTrue(await fse.pathExists(path.join(dir, STAMP_FILE)));
      assert.isTrue(await fse.pathExists(path.join(dir, "grist")));
    });

    it("disabled cleanup: reclaims a leftover payload", async function() {
      await setUseExternalFullEdition(false);
      await makePayloadDirs();
      // No stamp on disk (the resolver already fell back to OSS).

      const { restartRequested } = await maybeManageFullEdition();
      assert.isFalse(restartRequested);
      assert.equal(edition(), "core");
      assert.isFalse(await fse.pathExists(path.join(dir, "grist")), "payload should be reclaimed");
      assert.isFalse(await fse.pathExists(path.join(dir, "node_modules")));
    });

    describe("install + checksum", function() {
      let tarball: string;
      let tarballSha: string;
      let url: string;

      beforeEach(async function() {
        // Build a minimal fixture payload (grist/ + node_modules/) and serve it locally.
        const src = await fse.mkdtemp(path.join(os.tmpdir(), "grist-fe-fixture-"));
        await fse.mkdirp(path.join(src, "grist"));
        await fse.mkdirp(path.join(src, "node_modules"));
        await fse.writeFile(path.join(src, "grist", "marker"), "x");
        await fse.writeFile(path.join(src, "node_modules", "marker"), "x");
        tarball = path.join(src, "payload.tar.gz");
        await tar.c({ file: tarball, cwd: src, gzip: true }, ["grist", "node_modules"]);
        tarballSha = await sha256File(tarball);

        fileServer = http.createServer((_req, res) => {
          res.writeHead(200);
          fse.createReadStream(tarball).pipe(res);
        });
        await new Promise<void>(resolve => fileServer!.listen(0, resolve));
        url = `http://localhost:${(fileServer.address() as AddressInfo).port}/payload.tar.gz`;

        process.env.GRIST_FULL_EDITION_URL_AMD64 = url;
        process.env.GRIST_FULL_EDITION_URL_ARM64 = url;
        await setUseExternalFullEdition(true);
        // dir is empty (no stamp) => the "enabled && !current" install path.
      });

      it("installs a verified copy, then sets edition and requests restart", async function() {
        process.env.GRIST_FULL_EDITION_SHA256_AMD64 = tarballSha;
        process.env.GRIST_FULL_EDITION_SHA256_ARM64 = tarballSha;

        const { restartRequested } = await maybeManageFullEdition();
        assert.isTrue(restartRequested);
        assert.equal(edition(), "enterprise");
        assert.equal((await fse.readFile(path.join(dir, STAMP_FILE), "utf8")).trim(), REF);
        assert.isTrue(await fse.pathExists(path.join(dir, "grist", "marker")));
        assert.isTrue(await fse.pathExists(path.join(dir, "node_modules", "marker")));
      });

      it("rejects a checksum mismatch: no install, stays on core", async function() {
        sandbox.stub(Deps, "installAttempts").value(1);
        sandbox.stub(Deps, "installRetryDelayMs").value(0);
        process.env.GRIST_FULL_EDITION_SHA256_AMD64 = "deadbeef";
        process.env.GRIST_FULL_EDITION_SHA256_ARM64 = "deadbeef";

        const { restartRequested } = await maybeManageFullEdition();
        assert.isFalse(restartRequested);
        assert.equal(edition(), "core", "edition must not flip to enterprise on a failed install");
        assert.isFalse(await fse.pathExists(path.join(dir, STAMP_FILE)));
      });

      it("refuses to install without a baked-in checksum", async function() {
        sandbox.stub(Deps, "installAttempts").value(1);
        sandbox.stub(Deps, "installRetryDelayMs").value(0);
        delete process.env.GRIST_FULL_EDITION_SHA256_AMD64;
        delete process.env.GRIST_FULL_EDITION_SHA256_ARM64;

        const { restartRequested } = await maybeManageFullEdition();
        assert.isFalse(restartRequested);
        assert.equal(edition(), "core");
        assert.isFalse(await fse.pathExists(path.join(dir, STAMP_FILE)));
      });
    });
  });
});

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const input = fse.createReadStream(file);
  await new Promise<void>((resolve, reject) => {
    input.on("data", d => hash.update(d));
    input.on("end", () => resolve());
    input.on("error", reject);
  });
  return hash.digest("hex");
}
