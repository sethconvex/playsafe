import { parseArgs } from "node:util";
import { writeFileSync, readFileSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { PR_REQUEST_DIR, ensureDir } from "./utils.mjs";

const USAGE = `
playsafe serve — Start the MCP server

Exposes draft PR creation as MCP tools that coding agents can call directly.
Uses stdio transport (JSON-RPC over stdin/stdout).

Configure in your agent's MCP settings:
  {
    "mcpServers": {
      "playsafe": {
        "command": "playsafe",
        "args": ["serve"]
      }
    }
  }

Options:
  -h, --help  Show this help
`.trim();

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "create_draft_pr",
    description:
      "Request a draft pull request. Commit your changes to a local branch, then call " +
      "this tool with the repo path and branch name. The reviewer's watcher service will " +
      "push the branch and create a draft PR. You do NOT need to push — the watcher handles that.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Absolute path to the local git repo" },
        branch: { type: "string", description: "Local branch name with your commits" },
        base: { type: "string", description: "Base branch to merge into (default: main)", default: "main" },
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR description (markdown)", default: "" },
      },
      required: ["repo_path", "branch", "title"],
    },
  },
  {
    name: "get_pr_status",
    description: "Check the status of a previously requested draft PR.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "The request ID returned by create_draft_pr" },
      },
      required: ["request_id"],
    },
  },
];

function handleCreateDraftPr(args) {
  const { repo_path, branch, base = "main", title, body = "" } = args;

  if (!repo_path || !branch || !title) {
    return { content: [{ type: "text", text: "Error: repo_path, branch, and title are required" }], isError: true };
  }

  const absPath = resolve(repo_path);
  if (!existsSync(absPath)) {
    return { content: [{ type: "text", text: `Error: repo path does not exist: ${absPath}` }], isError: true };
  }

  ensureDir(PR_REQUEST_DIR);

  const id = `pr-${Date.now()}-${process.pid}`;
  const requestFile = join(PR_REQUEST_DIR, `${id}.json`);

  const request = {
    id,
    repo_path: absPath,
    branch,
    base,
    title,
    body,
    requested_by: process.env.USER || "agent",
    requested_at: new Date().toISOString(),
  };

  writeFileSync(requestFile, JSON.stringify(request, null, 2), { mode: 0o600 });
  try { chmodSync(requestFile, 0o600); } catch {}

  // Wait for result (up to 120 seconds — push + PR creation can take a moment)
  const resultFile = join(PR_REQUEST_DIR, `${id}.result`);
  const deadline = Date.now() + 120_000;

  return new Promise((resolve) => {
    const check = () => {
      if (existsSync(resultFile)) {
        try {
          const result = JSON.parse(readFileSync(resultFile, "utf8"));
          unlinkSync(resultFile);
          if (result.status === "success") {
            resolve({
              content: [{ type: "text", text: `Draft PR created: ${result.pr_url}\n\nRequest ID: ${id}` }],
            });
          } else {
            resolve({
              content: [{ type: "text", text: `PR creation failed: ${result.error}` }],
              isError: true,
            });
          }
        } catch (err) {
          resolve({
            content: [{ type: "text", text: `Error reading result: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }

      if (Date.now() > deadline) {
        resolve({
          content: [
            {
              type: "text",
              text: `PR request submitted (ID: ${id}) but timed out waiting for result.\nIs 'playsafe watch' running?\n\nYou can check status later with get_pr_status.`,
            },
          ],
          isError: true,
        });
        return;
      }

      setTimeout(check, 1000);
    };
    check();
  });
}

function handleGetPrStatus(args) {
  const { request_id } = args;
  if (!request_id) {
    return { content: [{ type: "text", text: "Error: request_id is required" }], isError: true };
  }

  const resultFile = join(PR_REQUEST_DIR, `${request_id}.result`);
  const requestFile = join(PR_REQUEST_DIR, `${request_id}.json`);

  if (existsSync(resultFile)) {
    const result = JSON.parse(readFileSync(resultFile, "utf8"));
    unlinkSync(resultFile);
    if (result.status === "success") {
      return { content: [{ type: "text", text: `Draft PR created: ${result.pr_url}` }] };
    }
    return { content: [{ type: "text", text: `PR creation failed: ${result.error}` }], isError: true };
  }

  if (existsSync(requestFile)) {
    return { content: [{ type: "text", text: `Request ${request_id} is still pending. The watcher hasn't processed it yet.` }] };
  }

  return { content: [{ type: "text", text: `No request or result found for ID: ${request_id}` }], isError: true };
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "playsafe", version: "0.1.0" },
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      let result;
      if (toolName === "create_draft_pr") {
        result = await handleCreateDraftPr(toolArgs);
      } else if (toolName === "get_pr_status") {
        result = handleGetPrStatus(toolArgs);
      } else {
        result = { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
      }
      return jsonRpcResponse(id, result);
    }

    case "ping":
      return jsonRpcResponse(id, {});

    default:
      if (method?.startsWith("notifications/")) return null;
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function serve(argv) {
  if (argv?.includes("-h") || argv?.includes("--help")) {
    console.log(USAGE);
    return;
  }

  console.error("[playsafe] MCP server starting on stdio...");

  ensureDir(PR_REQUEST_DIR);

  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;

    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        console.error(`[playsafe] <- ${msg.method || "response"} (id: ${msg.id})`);

        const response = await handleMessage(msg);
        if (response) {
          const bytes = Buffer.byteLength(response, "utf8");
          process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${response}`);
          console.error(`[playsafe] -> response (id: ${msg.id})`);
        }
      } catch (err) {
        console.error(`[playsafe] Error processing message: ${err.message}`);
      }
    }
  });

  process.stdin.on("end", () => {
    console.error("[playsafe] stdin closed, shutting down.");
    process.exit(0);
  });

  await new Promise(() => {});
}
