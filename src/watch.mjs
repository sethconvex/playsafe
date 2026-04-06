import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PR_REQUEST_DIR, PLIST_NAME, exec, ensureDir } from "./utils.mjs";

const USAGE = `
agent-sandbox watch — Watch for PR requests and create draft PRs

Runs in the foreground as your user. Uses your 'gh' CLI auth to create draft PRs.

Usage:
  agent-sandbox watch [--install]

Options:
  --install   Install as a launchd agent (runs in background on login)
  --uninstall Remove the launchd agent
  -h, --help  Show this help
`.trim();

function createDraftPr(requestFile) {
  let request;
  try {
    request = JSON.parse(readFileSync(requestFile, "utf8"));
  } catch (err) {
    console.error(`[${ts()}] Bad request file ${requestFile}: ${err.message}`);
    unlinkSync(requestFile);
    return;
  }

  const { id, repo, branch, base = "main", title, body = "" } = request;
  console.log(`[${ts()}] Processing ${id}: ${repo} ${branch} -> ${base}`);
  console.log(`  Title: ${title}`);

  const resultFile = requestFile.replace(".json", ".result");

  try {
    const prUrl = exec(
      `gh pr create --repo "${repo}" --head "${branch}" --base "${base}" --title "${title}" --body "${body}" --draft`
    );
    console.log(`  Created draft PR: ${prUrl}`);
    writeFileSync(resultFile, JSON.stringify({ status: "success", pr_url: prUrl, id }));
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    writeFileSync(resultFile, JSON.stringify({ status: "error", error: err.message, id }));
  }

  unlinkSync(requestFile);
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function processExisting() {
  if (!existsSync(PR_REQUEST_DIR)) return;
  for (const file of readdirSync(PR_REQUEST_DIR)) {
    if (file.endsWith(".json")) {
      createDraftPr(join(PR_REQUEST_DIR, file));
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
  const logDir = join(os.homedir(), "Library", "Logs", "agent-sandbox");

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

    const cliPath = exec("which agent-sandbox");

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
    console.log(`\nTo stop:  agent-sandbox watch --uninstall`);
    return;
  }

  // Foreground mode
  ensureDir(PR_REQUEST_DIR);
  console.log(`[${ts()}] Watching ${PR_REQUEST_DIR} for PR requests...`);
  console.log("Press Ctrl+C to stop.\n");

  processExisting();

  setInterval(() => {
    processExisting();
  }, 2000);
}
