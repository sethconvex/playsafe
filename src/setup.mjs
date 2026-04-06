import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { writeFileSync, chmodSync, chownSync, existsSync } from "node:fs";
import {
  AGENT_USER, AGENT_HOME, SANDBOX_DIR, SANDBOX_GIT_DIR, SANDBOX_WORKSPACE,
  PR_REQUEST_DIR, CONFIG_FILE, exec, isRoot, userExists, ensureDir,
} from "./utils.mjs";

const USAGE = `
agent-sandbox setup — Configure the sandbox (interactive)

Usage:
  agent-sandbox setup [options]

Walks you through creating a GitHub PAT and configuring the sandbox.
Opens your browser to GitHub's token creation page.

By default, uses directory-based isolation (no sudo needed). Use --os-user
for stronger OS-level isolation via a separate macOS user.

Options:
  --os-user   Create a separate macOS user (requires sudo)
  --password  Password for the macOS user (only with --os-user)
  --pat       Agent's GitHub PAT (prompted if not provided)
  -h, --help  Show this help
`.trim();

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function openBrowser(url) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(`open "${url}"`, { stdio: "ignore" });
  } catch {
    console.log(`  Could not open browser. Visit this URL manually:\n  ${url}`);
  }
}

export async function setup(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "os-user": { type: "boolean", default: false },
      password: { type: "string" },
      pat: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const osUserMode = values["os-user"];

  if (osUserMode && !isRoot()) {
    console.error("Error: --os-user requires sudo. Use: sudo agent-sandbox setup --os-user");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\nagent-sandbox setup\n");

    if (osUserMode) {
      console.log("Mode: OS-user isolation (separate macOS user)\n");
    } else {
      console.log("Mode: Directory isolation (no sudo required)\n");
    }

    // Step 1: Password (os-user mode only)
    let password;
    if (osUserMode) {
      password = values.password;
      if (!password) {
        password = await prompt(rl, "Password for the new macOS user: ");
        if (!password) {
          console.error("Error: password is required.");
          process.exit(1);
        }
      }
    }

    // Step 2: Agent PAT
    let pat = values.pat;
    if (!pat) {
      console.log("\n--- Step 1: Create the Agent PAT ---\n");
      console.log("The agent needs a GitHub PAT that can push branches but CANNOT create PRs.");
      console.log("Opening GitHub to create a fine-grained token...\n");
      console.log("  Required permissions:");
      console.log("    Contents: Read and Write");
      console.log("    (leave everything else at No Access)\n");

      await openBrowser("https://github.com/settings/personal-access-tokens/new");

      pat = await prompt(rl, "Paste the agent PAT here: ");
      if (!pat) {
        console.error("Error: PAT is required.");
        process.exit(1);
      }
    }

    // Step 3: Check reviewer auth
    console.log("\n--- Step 2: Verify your reviewer auth ---\n");
    console.log("The PR watcher needs YOUR GitHub auth to create draft PRs.");
    console.log("Checking if 'gh' CLI is authenticated...\n");

    let ghOk = false;
    if (osUserMode && process.env.SUDO_USER) {
      try {
        exec(`sudo -u ${process.env.SUDO_USER} gh auth status`);
        ghOk = true;
      } catch {}
    } else {
      try {
        exec("gh auth status");
        ghOk = true;
      } catch {}
    }

    if (ghOk) {
      console.log("  gh CLI is authenticated. You're all set.\n");
    } else {
      console.log("  gh CLI is NOT authenticated.");
      console.log("  After setup, run:\n");
      console.log("    gh auth login\n");
      console.log("  Make sure your account has Pull Request read+write access");
      console.log("  on the repos you want to create draft PRs for.\n");

      const cont = await prompt(rl, "Continue anyway? (y/n) ");
      if (cont.toLowerCase() !== "y") {
        console.log("Setup cancelled.");
        process.exit(0);
      }
    }

    // Step 4: Create sandbox
    console.log("\n--- Creating sandbox ---\n");

    if (osUserMode) {
      // Create macOS user
      if (userExists(AGENT_USER)) {
        console.log(`User '${AGENT_USER}' already exists, skipping creation.`);
      } else {
        console.log(`Creating macOS user '${AGENT_USER}'...`);
        exec(`sysadminctl -addUser ${AGENT_USER} -fullName "Sandbox Agent" -password "${password}" -home "${AGENT_HOME}"`);
        console.log("  User created.");
      }

      console.log("Configuring git...");
      exec(`sudo -u ${AGENT_USER} git config --global user.name "${AGENT_USER}"`);
      exec(`sudo -u ${AGENT_USER} git config --global user.email "${AGENT_USER}@localhost"`);
      exec(`sudo -u ${AGENT_USER} git config --global credential.helper store`);

      const credFile = `${AGENT_HOME}/.git-credentials`;
      writeFileSync(credFile, `https://${AGENT_USER}:${pat}@github.com\n`);
      const uid = parseInt(exec(`id -u ${AGENT_USER}`));
      const gid = parseInt(exec(`id -g ${AGENT_USER}`));
      chownSync(credFile, uid, gid);
      chmodSync(credFile, 0o600);
      console.log("  Git credentials stored.");
    } else {
      // Directory-based isolation
      ensureDir(SANDBOX_DIR);
      ensureDir(SANDBOX_GIT_DIR);
      ensureDir(SANDBOX_WORKSPACE);

      // Write isolated git config
      const gitConfigPath = `${SANDBOX_GIT_DIR}/config`;
      writeFileSync(gitConfigPath, [
        "[user]",
        `\tname = sandbox-agent`,
        `\temail = sandbox-agent@localhost`,
        "[credential]",
        `\thelper = store --file ${SANDBOX_GIT_DIR}/credentials`,
        "",
      ].join("\n"));
      chmodSync(gitConfigPath, 0o600);

      // Write isolated git credentials
      const credFile = `${SANDBOX_GIT_DIR}/credentials`;
      writeFileSync(credFile, `https://sandbox-agent:${pat}@github.com\n`);
      chmodSync(credFile, 0o600);
      console.log(`  Sandbox directory created at ${SANDBOX_DIR}`);
      console.log("  Git credentials stored.");
    }

    // PR request directory
    ensureDir(PR_REQUEST_DIR);
    if (osUserMode) {
      chmodSync(PR_REQUEST_DIR, 0o1777);
    }

    // Save config
    ensureDir(SANDBOX_DIR);
    writeFileSync(CONFIG_FILE, JSON.stringify({
      mode: osUserMode ? "os-user" : "directory",
      created_at: new Date().toISOString(),
    }, null, 2));

    const runPrefix = osUserMode ? "sudo " : "";
    const agentExample = osUserMode
      ? "sudo agent-sandbox run https://github.com/owner/repo --agent claude -- --dangerously-skip-permissions"
      : "agent-sandbox run https://github.com/owner/repo --agent claude -- --dangerously-skip-permissions";

    console.log(`
Setup complete!

Next steps:
  1. Start the PR watcher (creates draft PRs when the agent asks):
     agent-sandbox watch

     Or install it as a background service:
     agent-sandbox watch --install

  2. Run a coding agent:
     ${agentExample}

  3. Or add the MCP server to your agent's config so it gets
     a create_draft_pr tool automatically:

     {
       "mcpServers": {
         "agent-sandbox": {
           "command": "agent-sandbox",
           "args": ["serve"]
         }
       }
     }
`);
  } finally {
    rl.close();
  }
}
