import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfig(homeDir, allowedRepos = []) {
  const playsafeDir = join(homeDir, ".playsafe");
  mkdirSync(playsafeDir, { recursive: true });
  writeFileSync(join(playsafeDir, "config.json"), JSON.stringify({ allowedRepos }, null, 2));
}

function writeRef(stagingPath, branch, sha = "abc123") {
  const refPath = join(stagingPath, "refs", "heads", ...branch.split("/"));
  mkdirSync(dirname(refPath), { recursive: true });
  writeFileSync(refPath, `${sha}\n`);
}

test("getAllowedRepo matches registered repos by real path", () => {
  const homeDir = makeTempDir("playsafe-home-");
  try {
    const repoDir = join(homeDir, "registered");
    mkdirSync(repoDir, { recursive: true });
    const canonicalRepoDir = realpathSync(repoDir);
    writeConfig(homeDir, [{ path: canonicalRepoDir, owner: "tester" }]);

    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { getAllowedRepo } from ${JSON.stringify("/Users/magicseth/Projects/playsafe/src/utils.mjs")};
       console.log(JSON.stringify(getAllowedRepo(${JSON.stringify(repoDir)})));`,
    ], {
      env: { ...process.env, HOME: homeDir, SUDO_USER: "" },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      path: canonicalRepoDir,
      owner: "tester",
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("listStagingBranches finds nested playsafe branches", () => {
  const homeDir = makeTempDir("playsafe-home-");
  try {
    const stagingPath = join(homeDir, "staging.git");
    writeRef(stagingPath, "playsafe/alice/feature-one");
    writeRef(stagingPath, "playsafe/bob/fix-two");

    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { listStagingBranches } from ${JSON.stringify("/Users/magicseth/Projects/playsafe/src/utils.mjs")};
       console.log(JSON.stringify(listStagingBranches(${JSON.stringify(stagingPath)})));`,
    ], {
      env: { ...process.env, HOME: homeDir, SUDO_USER: "" },
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [
      "playsafe/alice/feature-one",
      "playsafe/bob/fix-two",
    ]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("cli help no longer advertises request subcommands", () => {
  const result = spawnSync(process.execPath, [
    "/Users/magicseth/Projects/playsafe/bin/cli.mjs",
    "--help",
  ], {
    cwd: "/Users/magicseth/Projects/playsafe",
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\brequest\b/);
});
