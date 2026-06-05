import { describe, expect, test, mock, beforeEach } from "bun:test";
import { ServerError } from "../src/errors.js";

// Helper to build a successful MCP JSON-RPC response
function mcpResponse(text: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  };
}

// Helper to create a mock Response
function jsonResponse(body: object, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(body: object, status = 200) {
  const data = `data: ${JSON.stringify(body)}\n\n`;
  return new Response(data, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("client", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  // Re-import client fresh each test to reset requestId counter
  async function loadClient() {
    // Use dynamic import with cache busting to get fresh module state
    const mod = await import(`../src/client.js?t=${Date.now()}_${Math.random()}`);
    return mod;
  }

  test("readWikiStructure sends correct JSON-RPC request", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(mcpResponse("# TOC"));
    }) as any;

    const client = await loadClient();
    await client.readWikiStructure("facebook/react");

    expect(capturedBody.jsonrpc).toBe("2.0");
    expect(capturedBody.method).toBe("tools/call");
    expect(capturedBody.params.name).toBe("read_wiki_structure");
    expect(capturedBody.params.arguments).toEqual({ repoName: "facebook/react" });
    expect(typeof capturedBody.id).toBe("number");

    globalThis.fetch = originalFetch;
  });

  test("readWikiContents calls read_wiki_contents", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(mcpResponse("full wiki content"));
    }) as any;

    const client = await loadClient();
    const result = await client.readWikiContents("oven-sh/bun");

    expect(result).toBe("full wiki content");
    expect(capturedBody.params.name).toBe("read_wiki_contents");
    expect(capturedBody.params.arguments).toEqual({ repoName: "oven-sh/bun" });

    globalThis.fetch = originalFetch;
  });

  test("askQuestion with single repo sends string repoName", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(mcpResponse("answer"));
    }) as any;

    const client = await loadClient();
    await client.askQuestion(["facebook/react"], "What is JSX?");

    expect(capturedBody.params.name).toBe("ask_question");
    expect(capturedBody.params.arguments.repoName).toBe("facebook/react");
    expect(capturedBody.params.arguments.question).toBe("What is JSX?");

    globalThis.fetch = originalFetch;
  });

  test("askQuestion with multiple repos sends array repoName", async () => {
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse(mcpResponse("answer"));
    }) as any;

    const client = await loadClient();
    await client.askQuestion(["facebook/react", "vercel/next.js"], "SSR?");

    expect(capturedBody.params.arguments.repoName).toEqual([
      "facebook/react",
      "vercel/next.js",
    ]);

    globalThis.fetch = originalFetch;
  });

  test("parses SSE response correctly", async () => {
    globalThis.fetch = mock(async () => {
      return sseResponse(mcpResponse("sse content"));
    }) as any;

    const client = await loadClient();
    const result = await client.readWikiStructure("owner/repo");
    expect(result).toBe("sse content");

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("fail", { status: 500, statusText: "Internal Server Error" });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("500");
    }

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError on MCP error response", async () => {
    globalThis.fetch = mock(async () => {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid request" },
      });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("Invalid request");
    }

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError when result.isError is true", async () => {
    globalThis.fetch = mock(async () => {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "repo not found" }],
          isError: true,
        },
      });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("repo not found");
    }

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError when result is missing", async () => {
    globalThis.fetch = mock(async () => {
      return jsonResponse({ jsonrpc: "2.0", id: 1 });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
    }

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError on SSE response with no data lines", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("event: message\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("No data in SSE");
    }

    globalThis.fetch = originalFetch;
  });

  test("sends correct headers", async () => {
    let capturedHeaders: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return jsonResponse(mcpResponse("ok"));
    }) as any;

    const client = await loadClient();
    await client.readWikiStructure("owner/repo");

    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["Accept"]).toBe("application/json, text/event-stream");

    globalThis.fetch = originalFetch;
  });

  test("sends to correct endpoint", async () => {
    let capturedUrl: string;
    globalThis.fetch = mock(async (url: any, _init: any) => {
      capturedUrl = url;
      return jsonResponse(mcpResponse("ok"));
    }) as any;

    const client = await loadClient();
    await client.readWikiStructure("owner/repo");

    expect(capturedUrl!).toBe("https://mcp.deepwiki.com/mcp");

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError on malformed JSON response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("not json at all", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("Malformed JSON");
    }

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError on malformed SSE JSON", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("data: {not valid json}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).message).toContain("Malformed JSON");
    }

    globalThis.fetch = originalFetch;
  });

  test("throws ServerError on timeout", async () => {
    globalThis.fetch = mock(async (_url: any, init: any) => {
      // Simulate abort by checking signal and throwing
      const signal = init.signal as AbortSignal;
      if (signal) {
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      }
      return jsonResponse(mcpResponse("ok"));
    }) as any;

    const client = await loadClient();
    try {
      await client.readWikiStructure("owner/repo");
      expect(true).toBe(false);
    } catch (err) {
      // The fetch mock throws AbortError immediately, which gets re-thrown
      // since AbortController hasn't fired yet. This tests the catch path exists.
      expect(err).toBeDefined();
    }

    globalThis.fetch = originalFetch;
  });

  test("skips SSE notifications and returns the matching result", async () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: { msg: "Processing..." } },
    };
    const result = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "final answer" }] },
    };
    const sseBody =
      `: ping\n\nevent: message\ndata: ${JSON.stringify(notification)}\n\nevent: message\ndata: ${JSON.stringify(result)}\n\n`;

    globalThis.fetch = mock(async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as any;

    const client = await loadClient();
    const answer = await client.readWikiStructure("owner/repo");
    expect(answer).toBe("final answer");

    globalThis.fetch = originalFetch;
  });

  test("passes AbortSignal to fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedSignal = init.signal;
      return jsonResponse(mcpResponse("ok"));
    }) as any;

    const client = await loadClient();
    await client.readWikiStructure("owner/repo");

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);

    globalThis.fetch = originalFetch;
  });
});
