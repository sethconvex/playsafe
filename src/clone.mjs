import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, chmodSync, chownSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  AGENT_USER, AGENT_HOME, STAGING_REMOTE_DIR, SANDBOX_DIR,
  execFile, execLive, isRoot, userExists, ensureDir, loadConfig, saveConfig, getUserIds, stagingRemoteName,
} from "./utils.mjs";

const USAGE = `
playsafe clone — Clone a repo into a secure sandbox

Creates the sandbox user if needed and clones the repo using a read-only PAT.

Usage:
  playsafe clone <repo-url>

Examples:
  playsafe clone https://github.com/owner/repo
  playsafe clone git@github.com:owner/repo.git

Options:
  --pat       Agent's read-only GitHub PAT (prompted if not provided)
  -h, --help  Show this help
`.trim();

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function addAllowedRepo(repoPath, owner) {
  const config = loadConfig() || {};
  const allowedRepos = Array.isArray(config.allowedRepos) ? config.allowedRepos : [];
  const normalizedPath = realpathSync(repoPath);
  const next = allowedRepos.filter((repo) => repo.path !== normalizedPath);
  const originUrl = execFile("git", ["-C", normalizedPath, "remote", "get-url", "origin"]);
  const remoteName = `${stagingRemoteName(normalizedPath)}.git`;
  const stagingPath = join(STAGING_REMOTE_DIR, remoteName);
  next.push({ path: normalizedPath, owner, originUrl, stagingPath });
  config.allowedRepos = next;
  saveConfig(config);
  return { normalizedPath, originUrl, stagingPath };
}

async function openBrowser(url) {
  try {
    // When running under sudo, open the URL as the real user so it uses their default browser
    const realUser = process.env.SUDO_USER;
    if (realUser) {
      execFile("sudo", ["-u", realUser, "open", url]);
    } else {
      execFile("open", [url]);
    }
  } catch {
    console.log(`  Could not open browser. Visit this URL manually:\n  ${url}`);
  }
}

export async function clone(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      pat: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return { handedOffToSudo: false };
  }

  if (positionals.length === 0) {
    console.log(USAGE);
    process.exit(1);
  }

  const realUser = process.env.SUDO_USER || process.env.USER;

  // Escalate to root upfront — we need it for user creation, chown, etc.
  if (!isRoot()) {
    console.log("playsafe needs sudo to create the sandbox user and finish setup.\n");
    await execLive("sudo", [process.execPath, ...process.argv.slice(1)]);
    return { handedOffToSudo: true };
  }

  const repoUrl = positionals[0];
  const repoName = basename(repoUrl, ".git");
  const repoDir = resolve(repoName);

  // Step 1: Ensure sandbox user exists
  ensureDir(SANDBOX_DIR);
  ensureDir(STAGING_REMOTE_DIR);
  execFile("chown", ["-R", realUser, SANDBOX_DIR]);

  if (userExists(AGENT_USER)) {
    console.log(`Sandbox user '${AGENT_USER}' already exists.`);
  } else {
    console.log(`\nCreating sandboxed macOS user '${AGENT_USER}'...`);
    const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    execFile("sysadminctl", [
      "-addUser", AGENT_USER,
      "-fullName", "Playsafe User",
      "-password", password,
      "-home", AGENT_HOME,
    ]);
    console.log("  User created.");
  }

  const { uid: agentUid, gid: agentGid } = getUserIds(AGENT_USER);

  // Ensure home directory exists (sysadminctl doesn't always create it,
  // and uninstall may have deleted it while the user record persists)
  ensureDir(AGENT_HOME);
  chownSync(AGENT_HOME, agentUid, agentGid);

  // Always update git config, wrapper, and shell env (idempotent)
  execFile("sudo", ["-u", AGENT_USER, "-H", "git", "config", "--global", "user.name", AGENT_USER]);
  execFile("sudo", ["-u", AGENT_USER, "-H", "git", "config", "--global", "user.email", `${AGENT_USER}@localhost`]);
  execFile("sudo", ["-u", AGENT_USER, "-H", "git", "config", "--global", "credential.helper", "store"]);

  // Git wrapper:
  // 1. Adds safe.directory='*' so repos owned by other users work
  // 2. Intercepts 'git push' and routes it through the local staging remote
  const binDir = `${AGENT_HOME}/bin`;
  ensureDir(binDir);
  const realGit = execFile("which", ["git"]);
  const wrapper = `#!/bin/bash
REAL_GIT="${realGit}"
BRANCH_PREFIX="playsafe/${realUser}"

# Intercept branch creation — enforce prefix
# git checkout -b <name> or git switch -c <name>
if [ "$1" = "checkout" ] && [ "$2" = "-b" ] && [ -n "$3" ]; then
  BRANCH_NAME="$3"
  if [[ "$BRANCH_NAME" != "$BRANCH_PREFIX/"* ]]; then
    BRANCH_NAME="$BRANCH_PREFIX/$BRANCH_NAME"
  fi
  shift 3
  exec "$REAL_GIT" -c safe.directory='*' checkout -b "$BRANCH_NAME" "$@"
fi
if [ "$1" = "switch" ] && [ "$2" = "-c" ] && [ -n "$3" ]; then
  BRANCH_NAME="$3"
  if [[ "$BRANCH_NAME" != "$BRANCH_PREFIX/"* ]]; then
    BRANCH_NAME="$BRANCH_PREFIX/$BRANCH_NAME"
  fi
  shift 3
  exec "$REAL_GIT" -c safe.directory='*' switch -c "$BRANCH_NAME" "$@"
fi

# Intercept push commands — route them to the local staging remote
if [ "$1" = "push" ]; then
  BRANCH="$("$REAL_GIT" -c safe.directory='*' rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [[ "$BRANCH" != "$BRANCH_PREFIX/"* ]]; then
    echo "Refusing to push branch '$BRANCH'. Use a playsafe/* branch." >&2
    exit 1
  fi
  echo "Staging branch '\${BRANCH}' for host review..."
  exec "$REAL_GIT" -c safe.directory='*' push --force-with-lease playsafe-staging "HEAD:refs/heads/$BRANCH"
fi

# All other git commands pass through with safe.directory
exec "$REAL_GIT" -c safe.directory='*' "$@"
  `;
  writeFileSync(`${binDir}/git`, wrapper);
  chmodSync(`${binDir}/git`, 0o755);
  chownSync(binDir, agentUid, agentGid);
  chownSync(`${binDir}/git`, agentUid, agentGid);

  // Shell config: ~/bin first in PATH, permissive umask
  writeFileSync(`${AGENT_HOME}/.zshenv`, [
    `export PATH="${binDir}:$PATH"`,
    `umask 0000`,
    ``,
  ].join("\n"));
  chownSync(`${AGENT_HOME}/.zshenv`, agentUid, agentGid);

  // Prompt goes in .zshrc so it loads after system defaults for interactive shells
  writeFileSync(`${AGENT_HOME}/.zshrc`, [
    `PROMPT='%F{yellow}playsafe%f %F{cyan}%1~%f %F{8}$%f '`,
    ``,
  ].join("\n"));
  chownSync(`${AGENT_HOME}/.zshrc`, agentUid, agentGid);

  const runDir = join(AGENT_HOME, "run");
  ensureDir(runDir);
  chownSync(runDir, agentUid, agentGid);
  chmodSync(runDir, 0o700);
  try {
    execFile("chmod", ["-N", AGENT_HOME]);
  } catch {}
  try {
    execFile("chmod", ["-R", "-N", runDir]);
  } catch {}
  try {
    execFile("chmod", ["+a", `${realUser} allow list,search,readattr,readextattr,readsecurity`, AGENT_HOME]);
    execFile("chmod", ["+a", `${realUser} allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit`, runDir]);
  } catch {}
  console.log("  Sandbox configured.");

  // Step 2: Ensure PAT is configured
  const credFile = `${AGENT_HOME}/.git-credentials`;
  let hasPat = false;
  try {
    hasPat = readFileSync(credFile, "utf8").includes("github.com");
  } catch {}

  if (hasPat) {
    console.log("Agent PAT already configured.");
  } else {
    let pat = values.pat;
    if (!pat) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log("\n--- Create a read-only GitHub PAT ---\n");
        console.log("The sandboxed agent needs a read-only GitHub token.");
        console.log("It can clone and fetch but CANNOT push, create PRs, or merge.\n");
        console.log("When the browser opens, configure the token like this:\n");
        console.log("  1. Name:              playsafe-readonly");
        console.log("  2. Expiration:        90 days (or your preference)");
        console.log("  3. Repository access: Select 'All repositories'");
        console.log("  4. Permissions:       Expand 'Repository permissions'");
        console.log("                        Set 'Contents' to 'Read-only'");
        console.log("                        (leave everything else as 'No access')");
        console.log("  5. Click 'Generate token' and copy it\n");

        await prompt(rl, "Press Enter to open GitHub...");
        await openBrowser("https://github.com/settings/personal-access-tokens/new");

        console.log();
        pat = await prompt(rl, "Paste the token here: ");
        if (!pat) {
          console.error("Error: PAT is required.");
          process.exit(1);
        }
      } finally {
        rl.close();
      }
    }

    writeFileSync(credFile, `https://${AGENT_USER}:${pat}@github.com\n`);
    chownSync(credFile, agentUid, agentGid);
    chmodSync(credFile, 0o600);
    console.log("  Agent PAT stored (read-only).");
  }

  // Step 3: Clone the repo
  // Clone as the real user (owns the directory), then grant the sandbox user
  // read+write via ACL so the agent can commit. You keep ownership.
  const credConfig = `${AGENT_HOME}/.gitconfig`;
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: credConfig };

  if (existsSync(repoDir)) {
    console.log(`\n${repoName}/ already exists, fetching latest...`);
    execFile("sudo", ["-u", realUser, "git", "-C", repoDir, "fetch", "--all"], { env: gitEnv });
  } else {
    console.log(`\nCloning ${repoUrl}...`);
    execFile("sudo", ["-u", realUser, "git", "clone", repoUrl, repoDir], { env: gitEnv });
    // Make sure it's owned by the real user
    execFile("chown", ["-R", realUser, repoDir]);
  }

  // Grant sandbox user read+write via ACL (you keep ownership)
  execFile("chmod", ["-R", "+a", `${AGENT_USER} allow read,write,append,execute,delete,file_inherit,directory_inherit`, repoDir]);
  ensureDir(STAGING_REMOTE_DIR);
  const { normalizedPath, stagingPath } = addAllowedRepo(repoDir, realUser);
  if (!existsSync(stagingPath)) {
    execFile("git", ["init", "--bare", stagingPath]);
    execFile("chown", ["-R", realUser, stagingPath]);
  }
  execFile("git", ["-C", stagingPath, "config", "core.sharedRepository", "group"]);
  execFile("chmod", ["-R", "+a", `${AGENT_USER} allow read,write,append,execute,delete,file_inherit,directory_inherit`, stagingPath]);
  execFile("sudo", ["-u", AGENT_USER, "-H", "git", "config", "--global", "--add", "safe.directory", stagingPath]);
  try {
    execFile("git", ["-C", normalizedPath, "remote", "remove", "playsafe-staging"]);
  } catch {}
  execFile("git", ["-C", normalizedPath, "remote", "add", "playsafe-staging", stagingPath]);

  // Step 4: Check watcher auth
  let ghOk = false;
  try {
    execFile("sudo", ["-u", realUser, "gh", "auth", "status"]);
    ghOk = true;
  } catch {}

  console.log(`
Ready!

  cd ${repoName}
  playsafe`);

  if (!ghOk) {
    console.log(`
Note: 'gh' CLI is not authenticated. It's needed to push and create draft PRs.
  Run: gh auth login
`);
  } else {
    console.log();
  }

  return { handedOffToSudo: false };
}
