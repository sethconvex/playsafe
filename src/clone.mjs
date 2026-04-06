import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, chownSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  AGENT_USER, AGENT_HOME, PR_REQUEST_DIR,
  exec, execLive, isRoot, userExists, ensureDir,
} from "./utils.mjs";

const USAGE = `
playsafe clone — Clone a repo into a secure sandbox

Creates the sandbox user if needed, clones the repo using a read-only PAT,
and configures MCP so the agent gets a create_draft_pr tool automatically.

Usage:
  playsafe clone <repo-url>

Examples:
  playsafe clone https://github.com/owner/repo
  playsafe clone git@github.com:owner/repo.git

Options:
  --pat       Agent's read-only GitHub PAT (prompted if not provided)
  -h, --help  Show this help
`.trim();

function getMcpConfig() {
  // Use absolute paths so the sandbox user can find node and the script
  const nodePath = process.execPath;
  let binPath;
  try {
    binPath = exec("which playsafe");
  } catch {
    binPath = process.argv[1];
  }
  return {
    mcpServers: {
      "playsafe": {
        command: nodePath,
        args: [binPath, "serve"],
      },
    },
  };
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function openBrowser(url) {
  try {
    // When running under sudo, open the URL as the real user so it uses their default browser
    const realUser = process.env.SUDO_USER;
    if (realUser) {
      exec(`sudo -u ${realUser} open "${url}"`);
    } else {
      exec(`open "${url}"`);
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
    return;
  }

  if (positionals.length === 0) {
    console.log(USAGE);
    process.exit(1);
  }

  const realUser = process.env.SUDO_USER || process.env.USER;

  // Escalate to root upfront — we need it for user creation, chown, etc.
  if (!isRoot()) {
    console.log("playsafe needs sudo to set up the sandbox.\n");
    await execLive("sudo", [process.execPath, ...process.argv.slice(1)]);
    return;
  }

  const repoUrl = positionals[0];
  const repoName = basename(repoUrl, ".git");
  const repoDir = resolve(repoName);

  // Step 1: Ensure sandbox user exists
  if (userExists(AGENT_USER)) {
    console.log(`Sandbox user '${AGENT_USER}' already exists.`);
  } else {
    console.log(`\nCreating sandboxed macOS user '${AGENT_USER}'...`);
    const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    exec(`sysadminctl -addUser ${AGENT_USER} -fullName "Playsafe User" -password "${password}" -home "${AGENT_HOME}"`);
    console.log("  User created.");
  }

  // Ensure home directory exists (sysadminctl doesn't always create it,
  // and uninstall may have deleted it while the user record persists)
  ensureDir(AGENT_HOME);
  exec(`chown $(id -u ${AGENT_USER}):$(id -g ${AGENT_USER}) "${AGENT_HOME}"`);

  // Always update git config, wrapper, and shell env (idempotent)
  exec(`sudo -u ${AGENT_USER} -H git config --global user.name "${AGENT_USER}"`);
  exec(`sudo -u ${AGENT_USER} -H git config --global user.email "${AGENT_USER}@localhost"`);
  exec(`sudo -u ${AGENT_USER} -H git config --global credential.helper store`);

  // Git wrapper:
  // 1. Adds safe.directory='*' so repos owned by other users work
  // 2. Intercepts 'git push' and routes it through the PR watcher
  const binDir = `${AGENT_HOME}/bin`;
  ensureDir(binDir);
  const realGit = exec("which git");
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

# Intercept push commands — route through the watcher
if [ "$1" = "push" ]; then
  # Figure out repo path and branch
  REPO_PATH="$("$REAL_GIT" -c safe.directory='*' rev-parse --show-toplevel 2>/dev/null || pwd)"
  BRANCH="$("$REAL_GIT" -c safe.directory='*' rev-parse --abbrev-ref HEAD 2>/dev/null)"

  # Get the PR title from the last commit message
  TITLE="$("$REAL_GIT" -c safe.directory='*' log -1 --format=%s 2>/dev/null || echo "$BRANCH")"

  # Get a summary of commits for the body
  DEFAULT_BRANCH="$("$REAL_GIT" -c safe.directory='*' symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')"
  DEFAULT_BRANCH="\${DEFAULT_BRANCH:-main}"
  BODY="$("$REAL_GIT" -c safe.directory='*' log --oneline "\${DEFAULT_BRANCH}..HEAD" 2>/dev/null || echo "")"

  REQUEST_DIR="${PR_REQUEST_DIR}"
  REQUEST_ID="pr-$(date +%s)-$$"
  REQUEST_FILE="\${REQUEST_DIR}/\${REQUEST_ID}.json"
  RESULT_FILE="\${REQUEST_DIR}/\${REQUEST_ID}.result"

  mkdir -p "\${REQUEST_DIR}"

  cat > "\${REQUEST_FILE}" <<REQEOF
{
  "id": "\${REQUEST_ID}",
  "repo_path": "\${REPO_PATH}",
  "branch": "\${BRANCH}",
  "base": "\${DEFAULT_BRANCH}",
  "title": "\${TITLE}",
  "body": "\${BODY}",
  "requested_by": "$(whoami)",
  "requested_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
REQEOF

  echo "Pushing branch '\${BRANCH}' and creating draft PR..."

  # Wait for the watcher to process it
  TIMEOUT=120
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    if [ -f "\${RESULT_FILE}" ]; then
      STATUS=$(cat "\${RESULT_FILE}" 2>/dev/null)
      rm -f "\${RESULT_FILE}" >/dev/null 2>&1 || true
      if echo "\${STATUS}" | grep -q '"success"'; then
        PR_URL=$(echo "\${STATUS}" | grep -o '"pr_url": *"[^"]*"' | head -1 | sed 's/"pr_url": *"//;s/"$//')
        echo "Branch pushed and draft PR created successfully."
        echo "PR: \${PR_URL}"
        exit 0
      else
        ERROR=$(echo "\${STATUS}" | grep -o '"error": *"[^"]*"' | head -1 | sed 's/"error": *"//;s/"$//')
        echo "Failed to create draft PR: \${ERROR}" >&2
        exit 1
      fi
    fi
    sleep 0.5
    ELAPSED=$((ELAPSED + 1))
  done

  echo "Timed out waiting for PR creation. Is the playsafe watcher running?" >&2
  exit 1
fi

# All other git commands pass through with safe.directory
exec "$REAL_GIT" -c safe.directory='*' "$@"
`;
  writeFileSync(`${binDir}/git`, wrapper);
  chmodSync(`${binDir}/git`, 0o755);
  exec(`chown -R $(id -u ${AGENT_USER}):$(id -g ${AGENT_USER}) "${binDir}"`);

  // Shell config: ~/bin first in PATH, permissive umask
  writeFileSync(`${AGENT_HOME}/.zshenv`, [
    `export PATH="${binDir}:$PATH"`,
    `umask 0000`,
    ``,
  ].join("\n"));
  exec(`chown $(id -u ${AGENT_USER}):$(id -g ${AGENT_USER}) "${AGENT_HOME}/.zshenv"`);

  // Prompt goes in .zshrc so it loads after system defaults for interactive shells
  writeFileSync(`${AGENT_HOME}/.zshrc`, [
    `PROMPT='%F{yellow}playsafe%f %F{cyan}%1~%f %F{8}$%f '`,
    ``,
  ].join("\n"));
  exec(`chown $(id -u ${AGENT_USER}):$(id -g ${AGENT_USER}) "${AGENT_HOME}/.zshrc"`);

  ensureDir(PR_REQUEST_DIR);
  chmodSync(PR_REQUEST_DIR, 0o777);
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
    const uid = parseInt(exec(`id -u ${AGENT_USER}`));
    const gid = parseInt(exec(`id -g ${AGENT_USER}`));
    chownSync(credFile, uid, gid);
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
    exec(`sudo -u ${realUser} git -C "${repoDir}" fetch --all`, { env: gitEnv });
  } else {
    console.log(`\nCloning ${repoUrl}...`);
    exec(`sudo -u ${realUser} git clone "${repoUrl}" "${repoDir}"`, { env: gitEnv });
    // Make sure it's owned by the real user
    exec(`chown -R ${realUser} "${repoDir}"`);
  }

  // Grant sandbox user read+write via ACL (you keep ownership)
  exec(`chmod -R +a "${AGENT_USER} allow read,write,append,execute,delete,file_inherit,directory_inherit" "${repoDir}"`);

  // Step 4: Write .mcp.json
  const mcpPath = join(repoDir, ".mcp.json");
  let mcpContent;
  if (existsSync(mcpPath)) {
    const existing = JSON.parse(readFileSync(mcpPath, "utf8"));
    existing.mcpServers = existing.mcpServers || {};
    existing.mcpServers["playsafe"] = getMcpConfig().mcpServers["playsafe"];
    mcpContent = JSON.stringify(existing, null, 2) + "\n";
    console.log("Updated .mcp.json with playsafe MCP server.");
  } else {
    mcpContent = JSON.stringify(getMcpConfig(), null, 2) + "\n";
    console.log("Created .mcp.json with playsafe MCP server.");
  }
  writeFileSync(mcpPath, mcpContent);

  // Step 5: Check watcher auth
  let ghOk = false;
  try {
    exec(`sudo -u ${realUser} gh auth status`);
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
}
