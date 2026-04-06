import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_USER, PR_REQUEST_DIR, PLIST_NAME, exec, execFile, ensureDir } from "./utils.mjs";

const USAGE = `
playsafe watch — Watch for PR requests, push branches, and create draft PRs

Runs in the foreground as your user. Uses your 'gh' CLI auth to push the
agent's local branch and create a draft PR.

Usage:
  playsafe watch [--install]

Options:
  --install   Install as a launchd agent (runs in background on login)
  --uninstall Remove the launchd agent
  -h, --help  Show this help
`.trim();

function writeResult(path, data) {
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function processRequest(requestFile) {
  let request;
  try {
    const expectedUid = parseInt(exec(`id -u ${AGENT_USER}`), 10);
    const st = statSync(requestFile);
    if (st.uid !== expectedUid) {
      throw new Error(`Unexpected request owner UID ${st.uid}`);
    }
    request = JSON.parse(readFileSync(requestFile, "utf8"));
  } catch (err) {
    console.error(`[${ts()}] Bad request file ${requestFile}: ${err.message}`);
    try { unlinkSync(requestFile); } catch {}
    return;
  }

  const { id, repo_path, branch, base = "main", title, body = "" } = request;
  console.log(`[${ts()}] Processing ${id}`);
  console.log(`  Repo: ${repo_path}`);
  console.log(`  Branch: ${branch} -> ${base}`);
  console.log(`  Title: ${title}`);

  const resultFile = requestFile.replace(".json", ".result");

  try {
    // Determine the remote repo (owner/repo) from git remote
    const remoteUrl = execFile("git", ["-C", repo_path, "remote", "get-url", "origin"]);
    const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (!match) {
      throw new Error(`Could not parse GitHub repo from remote URL: ${remoteUrl}`);
    }
    const repo = match[1];
    console.log(`  Remote: ${repo}`);

    // Enforce branch prefix
    const BRANCH_PREFIX = "playsafe/";
    let pushBranch = branch;
    if (!branch.startsWith(BRANCH_PREFIX)) {
      pushBranch = `playsafe/${request.requested_by || "agent"}/${branch}`;
      console.log(`  Renaming branch to '${pushBranch}' (enforcing playsafe/ prefix)`);
      try { execFile("git", ["-C", repo_path, "-c", "safe.directory=*", "branch", "-m", branch, pushBranch]); } catch {}
    }

    // Refuse to push to protected branches
    const blocked = ["main", "master", "develop", "release"];
    if (blocked.includes(pushBranch) || !pushBranch.startsWith(BRANCH_PREFIX)) {
      throw new Error(`Refusing to push to '${pushBranch}'. Only playsafe/* branches are allowed.`);
    }

    // Push the branch (no --force flags)
    execFile("git", ["config", "--global", "--add", "safe.directory", repo_path]);
    console.log(`  Pushing branch '${pushBranch}'...`);
    execFile("git", ["-C", repo_path, "-c", "credential.helper=!gh auth git-credential", "push", "origin", pushBranch]);
    console.log(`  Branch pushed.`);

    // Create the draft PR using execFileSync to avoid shell escaping issues
    const prUrl = execFileSync("gh", [
      "pr", "create",
      "--repo", repo,
      "--head", pushBranch,
      "--base", base,
      "--title", title,
      "--body", body,
      "--draft",
    ], { encoding: "utf8", stdio: "pipe" }).trim();

    console.log(`  Created draft PR: ${prUrl}`);
    try { execFile("open", [prUrl]); } catch {}
    writeResult(resultFile, { status: "success", pr_url: prUrl, id });
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    writeResult(resultFile, { status: "error", error: err.message, id });
  }

  try { unlinkSync(requestFile); } catch {}
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function processExisting() {
  if (!existsSync(PR_REQUEST_DIR)) return;
  for (const file of readdirSync(PR_REQUEST_DIR)) {
    if (file.endsWith(".json")) {
      processRequest(join(PR_REQUEST_DIR, file));
    }
  }
}

export async function watch(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      install: { type: "boolean", default: false },
      uninstall: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  // Verify gh is authenticated
  try {
    exec("gh auth status");
  } catch {
    console.error("Error: gh CLI is not authenticated. Run 'gh auth login' first.");
    process.exit(1);
  }

  const os = await import("node:os");
  const plistDir = join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, `${PLIST_NAME}.plist`);
  const logDir = join(os.homedir(), "Library", "Logs", "playsafe");

  if (values.uninstall) {
    const uid = exec("id -u");
    try { exec(`launchctl bootout gui/${uid}/${PLIST_NAME}`); } catch {}
    try { unlinkSync(plistPath); } catch {}
    console.log("PR watcher launchd agent removed.");
    return;
  }

  if (values.install) {
    ensureDir(plistDir);
    ensureDir(logDir);
    ensureDir(PR_REQUEST_DIR);

    const cliPath = exec("which playsafe");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${cliPath}</string>
        <string>watch</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/pr-watcher.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/pr-watcher.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>`;

    writeFileSync(plistPath, plist);
    const uid = exec("id -u");
    try { exec(`launchctl bootout gui/${uid}/${PLIST_NAME}`); } catch {}
    exec(`launchctl bootstrap gui/${uid} "${plistPath}"`);

    console.log("PR watcher installed as launchd agent.");
    console.log(`Logs: ${logDir}/pr-watcher.stdout.log`);
    console.log(`\nTo stop:  playsafe watch --uninstall`);
    return;
  }

  // Foreground mode
  ensureDir(PR_REQUEST_DIR);
  console.log(`[${ts()}] Watching ${PR_REQUEST_DIR} for PR requests...`);
  console.log("Press Ctrl+C to stop.\n");

  processExisting();

  setInterval(() => {
    processExisting();
  }, 500);

  // Keep the process alive
  await new Promise(() => {});
}
