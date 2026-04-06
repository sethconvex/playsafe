# agent-sandbox

Run AI coding agents safely by isolating them with limited GitHub access. The agent can code freely but can only request draft PRs — a watcher service running as your user creates them for your review.

Works with any coding agent: [Claude Code](https://claude.ai/code), [Codex](https://github.com/openai/codex), [Aider](https://aider.chat), [Goose](https://github.com/block/goose), or any CLI tool.

## Quickstart

```bash
# 1. Install
npm install -g agent-sandbox

# 2. Make sure gh CLI is authenticated (used to create draft PRs as you)
gh auth login

# 3. Setup — opens browser to create a GitHub PAT, no sudo needed
agent-sandbox setup

# 4. In one terminal, start the PR watcher
agent-sandbox watch

# 5. In another terminal, run your agent
agent-sandbox run https://github.com/you/your-repo --agent claude -- --dangerously-skip-permissions
```

The agent works in the sandbox with a restricted GitHub PAT (can push branches, can't create PRs). When it's done, it calls `create_draft_pr` (via MCP) or `agent-sandbox request` (via CLI). The watcher creates a **draft PR** for you to review.

## Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  sandbox                    │     │  your user                   │
│                             │     │                              │
│  Any coding agent CLI       │     │  agent-sandbox watch         │
│  Git PAT: push branches     │────>│  gh CLI (authenticated)      │
│  No PR creation ability     │ JSON│  Creates DRAFT PRs only      │
│                             │file │                              │
│  MCP: create_draft_pr tool  │     │  You review & merge          │
└─────────────────────────────┘     └──────────────────────────────┘
```

## Setup

Interactive setup walks you through everything — opens your browser to create a GitHub PAT with the right permissions:

```bash
agent-sandbox setup
```

You'll need:

- **Agent PAT**: fine-grained token with `Contents: Read and Write` only (setup opens the browser for you)
- **Your auth**: `gh auth login` so the watcher can create draft PRs

### OS-user isolation (optional)

For stronger isolation, you can create a separate macOS user. This requires sudo:

```bash
sudo agent-sandbox setup --os-user
```

## Usage

### Start the PR watcher

```bash
# Foreground
agent-sandbox watch

# Or install as a background service (launchd)
agent-sandbox watch --install
```

### Run a coding agent

```bash
# Claude Code
agent-sandbox run https://github.com/owner/repo --agent claude -- --dangerously-skip-permissions

# OpenAI Codex
agent-sandbox run https://github.com/owner/repo --agent codex -- --full-auto

# Aider
agent-sandbox run https://github.com/owner/repo --agent aider

# Goose
agent-sandbox run https://github.com/owner/repo --agent goose

# Any CLI
agent-sandbox run ./local-repo --agent my-custom-agent
```

### Agent requests a draft PR

**Option A: MCP server (recommended)**

Add to your agent's MCP config (e.g. `.mcp.json` in the project, or `~/.claude.json`):

```json
{
  "mcpServers": {
    "agent-sandbox": {
      "command": "agent-sandbox",
      "args": ["serve"]
    }
  }
}
```

The agent gets a `create_draft_pr` tool it can call directly — no special instructions needed.

**Option B: CLI**

The agent pushes a branch, then runs:

```bash
agent-sandbox request \
  --repo owner/repo \
  --branch my-feature \
  --title "Add feature X" \
  --body "Description of changes"
```

Either way, the watcher creates a **draft PR** and the agent gets back the URL.

## MCP Tools

When running `agent-sandbox serve`, the following tools are exposed:

| Tool | Description |
|------|-------------|
| `create_draft_pr` | Push a branch and request a draft PR. Returns the PR URL. |
| `get_pr_status` | Check the status of a previously requested PR. |

## Commands

| Command | Description |
|---------|-------------|
| `agent-sandbox setup` | Interactive setup (opens browser for PATs) |
| `agent-sandbox setup --os-user` | Setup with a separate macOS user (requires sudo) |
| `agent-sandbox watch` | Start the draft PR watcher (foreground) |
| `agent-sandbox watch --install` | Install watcher as a background launchd agent |
| `agent-sandbox watch --uninstall` | Remove the launchd agent |
| `agent-sandbox run <repo> --agent <cmd>` | Run a coding agent in the sandbox |
| `agent-sandbox request` | Request a draft PR via CLI |
| `agent-sandbox serve` | Start the MCP server (stdio) |
| `agent-sandbox uninstall` | Remove everything |

## Security model

- The sandbox uses a restricted GitHub PAT that can push branches but **cannot create PRs**
- All PRs are created as **drafts** requiring your review
- Git credentials are chmod 600 in `~/.agent-sandbox/git/`
- PR requests go through a watched directory (`/tmp/agent-sandbox-pr-requests/`)
- The watcher runs as your user with your GitHub auth
- The MCP server has no credentials — it only writes request files
- Optional: `--os-user` creates a separate macOS user for OS-level isolation

## Uninstall

```bash
agent-sandbox uninstall
```
