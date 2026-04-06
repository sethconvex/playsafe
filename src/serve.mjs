import { parseArgs } from "node:util";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PR_REQUEST_DIR, ensureDir } from "./utils.mjs";

const USAGE = `
agent-sandbox serve — Start the MCP server

Exposes draft PR creation as MCP tools that coding agents can call directly.
Uses stdio transport (JSON-RPC over stdin/stdout).

Configure in your agent's MCP settings:
  {
    "mcpServers": {
      "agent-sandbox": {
        "command": "agent-sandbox",
        "args": ["serve"]
      }
    }
  }

Options:
  -h, --help  Show this help
`.trim();

// Minimal MCP JSON-RPC server over stdio (no dependencies).
// Implements just enough of the protocol to expose tools.

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
      "Request a draft pull request. The PR is created by the reviewer's GitHub account, not yours. " +
      "Push your branch first, then call this tool. Returns the draft PR URL.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub repo in owner/repo format" },
        branch: { type: "string", description: "Branch name to create the PR from (must be pushed already)" },
        base: { type: "string", description: "Base branch to merge into (default: main)", default: "main" },
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR description (markdown)", default: "" },
      },
      required: ["repo", "branch", "title"],
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
  const { repo, branch, base = "main", title, body = "" } = args;

  if (!repo || !branch || !title) {
    return { content: [{ type: "text", text: "Error: repo, branch, and title are required" }], isError: true };
  }

  ensureDir(PR_REQUEST_DIR);

  const id = `pr-${Date.now()}-${process.pid}`;
  const requestFile = join(PR_REQUEST_DIR, `${id}.json`);

  const request = {
    id,
    repo,
    branch,
    base,
    title,
    body,
    requested_by: process.env.USER || "agent",
    requested_at: new Date().toISOString(),
  };

  writeFileSync(requestFile, JSON.stringify(request, null, 2));

  // Wait for result (up to 60 seconds)
  const resultFile = join(PR_REQUEST_DIR, `${id}.result`);
  const deadline = Date.now() + 60_000;

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
              text: `PR request submitted (ID: ${id}) but timed out waiting for result.\nIs 'agent-sandbox watch' running?\n\nYou can check status later with get_pr_status.`,
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
        serverInfo: { name: "agent-sandbox", version: "0.1.0" },
      });

    case "notifications/initialized":
      return null; // no response needed for notifications

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

  // stderr for logging (stdout is the JSON-RPC channel)
  console.error("[agent-sandbox] MCP server starting on stdio...");

  ensureDir(PR_REQUEST_DIR);

  // Read JSON-RPC messages from stdin, line-delimited
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;

    // MCP uses Content-Length framed messages
    while (buffer.length > 0) {
      // Try to parse Content-Length header
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Not a valid header, try to find the next one
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) break; // need more data

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        console.error(`[agent-sandbox] <- ${msg.method || "response"} (id: ${msg.id})`);

        const response = await handleMessage(msg);
        if (response) {
          const bytes = Buffer.byteLength(response, "utf8");
          process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${response}`);
          console.error(`[agent-sandbox] -> response (id: ${msg.id})`);
        }
      } catch (err) {
        console.error(`[agent-sandbox] Error processing message: ${err.message}`);
      }
    }
  });

  process.stdin.on("end", () => {
    console.error("[agent-sandbox] stdin closed, shutting down.");
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}
