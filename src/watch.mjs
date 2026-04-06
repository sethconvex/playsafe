import { parseArgs } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_USER,
  PLIST_NAME,
  exec,
  execFile,
  ensureDir,
  listAllowedRepos,
  listStagingBranches,
  loadWatchState,
  saveWatchState,
} from "./utils.mjs";

const USAGE = `
playsafe watch — Promote staged branches and create draft PRs

Runs in the foreground as your user. Watches playsafe staging remotes,
pushes staged branches to GitHub, and creates draft PRs with your 'gh' auth.

Usage:
  playsafe watch [--install]

Options:
  --install   Install as a launchd agent (runs in background on login)
  --uninstall Remove the launchd agent
  -h, --help  Show this help
`.trim();

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function parseGitHubRepo(originUrl) {
  const match = originUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) throw new Error(`Could not parse GitHub repo from remote URL: ${originUrl}`);
  return match[1];
}

function branchKey(repoPath, branch) {
  return `${repoPath}::${branch}`;
}

function defaultBranch(repoPath) {
  try {
    const symbolic = execFile("git", ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"]);
    return symbolic.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    return "main";
  }
}

function branchSha(stagingPath, branch) {
  return execFile("git", ["--git-dir", stagingPath, "rev-parse", `refs/heads/${branch}`]);
}

function branchTitle(stagingPath, branch) {
  return execFile("git", ["--git-dir", stagingPath, "log", "-1", "--format=%s", `refs/heads/${branch}`]);
}

function branchBody(stagingPath, branch, base) {
  try {
    return execFile("git", ["--git-dir", stagingPath, "log", "--oneline", `${base}..refs/heads/${branch}`]);
  } catch {
    return execFile("git", ["--git-dir", stagingPath, "log", "--oneline", `refs/heads/${branch}`]);
  }
}

function existingPrUrl(repo, branch) {
  try {
    const output = execFile("gh", ["pr", "view", "--repo", repo, "--head", branch, "--json", "url"]);
    return JSON.parse(output).url;
  } catch {
    return null;
  }
}

function createDraftPr(repo, branch, base, title, body) {
  return execFile("gh", [
    "pr", "create",
    "--repo", repo,
    "--head", branch,
    "--base", base,
    "--title", title,
    "--body", body,
    "--draft",
  ]);
}

function openPrUrl(url, owner) {
  const currentUser = process.env.USER || execFile("id", ["-un"]);
  if (currentUser === owner) {
    execFile("open", [url]);
    return;
  }
  try {
    if (process.getuid?.() === 0) {
      execFile("sudo", ["-u", owner, "open", url]);
      return;
    }
  } catch {}
  execFile("open", [url]);
}

function promoteBranch(repoConfig, branch, state) {
  const { path: repoPath, stagingPath, originUrl, owner } = repoConfig;
  const repo = parseGitHubRepo(originUrl);
  const key = branchKey(repoPath, branch);
  const sha = branchSha(stagingPath, branch);
  const prior = state.branches[key];

  if (prior?.sha === sha) return;

  const base = defaultBranch(repoPath);
  const title = branchTitle(stagingPath, branch);
  const body = branchBody(stagingPath, branch, base);

  console.log(`[${ts()}] Promoting ${branch}`);
  console.log(`  Repo: ${repo}`);
  console.log(`  Base: ${base}`);
  console.log(`  Sha: ${sha}`);

  execFile("git", ["-c", "credential.helper=!gh auth git-credential", "push", "origin", `${sha}:refs/heads/${branch}`], {
    cwd: repoPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  const prUrl = existingPrUrl(repo, branch) || createDraftPr(repo, branch, base, title, body).trim();
  try { openPrUrl(prUrl, owner); } catch {}

  state.branches[key] = { sha, prUrl, updatedAt: new Date().toISOString() };
}

function processStagingRemotes() {
  const repos = listAllowedRepos();
  const state = loadWatchState();
  state.branches = state.branches || {};

  for (const repoConfig of repos) {
    if (!repoConfig.stagingPath) continue;
    for (const branch of listStagingBranches(repoConfig.stagingPath)) {
      try {
        promoteBranch(repoConfig, branch, state);
      } catch (err) {
        console.error(`[${ts()}] Error promoting ${branch}: ${err.message}`);
      }
    }
  }

  saveWatchState(state);
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

  const currentUser = process.env.USER || execFile("id", ["-un"]);
  if (currentUser === AGENT_USER) {
    console.error("Error: playsafe watch must run as the host user, not playsafe-user.");
    process.exit(1);
  }

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
    const uid = execFile("id", ["-u"]);
    try { execFile("launchctl", ["bootout", `gui/${uid}/${PLIST_NAME}`]); } catch {}
    try { unlinkSync(plistPath); } catch {}
    console.log("PR watcher launchd agent removed.");
    return;
  }

  if (values.install) {
    ensureDir(plistDir);
    ensureDir(logDir);

    const cliPath = execFile("which", ["playsafe"]);
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
    const uid = execFile("id", ["-u"]);
    try { execFile("launchctl", ["bootout", `gui/${uid}/${PLIST_NAME}`]); } catch {}
    execFile("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);

    console.log("PR watcher installed as launchd agent.");
    console.log(`Logs: ${logDir}/pr-watcher.stdout.log`);
    console.log(`\nTo stop:  playsafe watch --uninstall`);
    return;
  }

  console.log(`[${ts()}] Watching staging remotes for playsafe branches...`);
  console.log("Press Ctrl+C to stop.\n");

  processStagingRemotes();
  setInterval(processStagingRemotes, 1000);

  await new Promise(() => {});
}
