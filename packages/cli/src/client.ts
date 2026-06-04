import { ServerError } from "./errors.js";

const MCP_ENDPOINT = "https://mcp.deepwiki.com/mcp";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id: number;
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: McpToolResult;
  error?: { code: number; message: string };
}

let requestId = 0;

function makeRequest(
  method: string,
  params: Record<string, unknown>,
): JsonRpcRequest {
  requestId += 1;
  return {
    jsonrpc: "2.0",
    method,
    params,
    id: requestId,
  };
}

async function parseSSE(
  stream: ReadableStream<Uint8Array> | null,
  requestId: number,
): Promise<JsonRpcResponse> {
  if (!stream) {
    throw new ServerError("No data in SSE response");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasData = false;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        hasData = true;
        try {
          const message = JSON.parse(line.slice(6)) as JsonRpcResponse;
          // DeepWiki progress notifications contain no useful CLI output.
          if (!("method" in message) && message.id === requestId) {
            await reader.cancel();
            return message;
          }
        } catch {
          throw new ServerError("Malformed JSON in SSE response");
        }
      }
    }

    if (done) {
      break;
    }
  }

  throw new ServerError(
    hasData
      ? "No matching response in SSE response"
      : "No data in SSE response",
  );
}

async function callMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const body = makeRequest("tools/call", { name: toolName, arguments: args });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  let rpc: JsonRpcResponse;
  try {
    const res = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new ServerError(
        `DeepWiki server returned ${res.status}: ${res.statusText}`,
      );
    }

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      rpc = await parseSSE(res.body, body.id);
    } else {
      try {
        rpc = JSON.parse(await res.text());
      } catch {
        throw new ServerError("Malformed JSON in response");
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ServerError("Request timed out after 60s");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (rpc.error) {
    throw new ServerError(`MCP error: ${rpc.error.message}`);
  }

  if (!rpc.result || rpc.result.isError) {
    const text = rpc.result?.content?.[0]?.text || "Unknown error";
    throw new ServerError(text);
  }

  return rpc.result.content[0].text;
}

export async function readWikiStructure(repoName: string): Promise<string> {
  return callMcp("read_wiki_structure", { repoName });
}

export async function readWikiContents(repoName: string): Promise<string> {
  return callMcp("read_wiki_contents", { repoName });
}

export async function askQuestion(
  repoNames: string[],
  question: string,
): Promise<string> {
  const repoName = repoNames.length === 1 ? repoNames[0] : repoNames;
  return callMcp("ask_question", { repoName, question });
}
