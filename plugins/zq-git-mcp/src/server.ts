import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import { PayloadTooLargeError, json, readBody } from "../../chassis/src/http.ts";
import type { Dispatcher } from "./dispatch.ts";
import { printable } from "./validate.ts";

const MCP_PATH = "/mcp";
const CALLER_HEADER = "x-qm-caller";
const ACTOR_HEADER = "x-qm-actor";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CALLER_LENGTH = 64;

const digest = (value: string) => createHash("sha256").update(value).digest();

function bearerMatches(header: string | undefined, secret: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(presented), digest(secret)) && presented.length > 0;
}

function callerLabel(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  return printable(raw?.trim().slice(0, MAX_CALLER_LENGTH)) || "unknown";
}

async function serveMcp(dispatcher: Dispatcher, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const closed = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) closed.abort(new Error("request closed by the caller"));
  });
  const caller = callerLabel(req.headers[CALLER_HEADER] ?? req.headers[ACTOR_HEADER]);
  const server = new Server({ name: "zq-git-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dispatcher.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const reply = await dispatcher.call(
      request.params.name,
      request.params.arguments,
      caller,
      AbortSignal.any([closed.signal, extra.signal]),
    );
    return { content: [{ type: "text" as const, text: reply.text }], isError: reply.isError };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createMcpHttpServer(options: { secret: string; dispatcher: Dispatcher }): HttpServer {
  return createServer((req, res) => {
    void (async () => {
      if (req.url?.split("?")[0] !== MCP_PATH) return json(res, 404, { error: "not found" });
      if (!bearerMatches(req.headers.authorization, options.secret)) {
        res.setHeader("www-authenticate", "Bearer");
        return json(res, 401, { error: "unauthorized" });
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return json(res, 405, { error: "method not allowed" });
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, MAX_REQUEST_BYTES));
      } catch (e) {
        if (e instanceof PayloadTooLargeError) return json(res, 413, { error: "request too large" });
        return json(res, 400, { error: "invalid JSON" });
      }
      await serveMcp(options.dispatcher, req, res, body);
    })().catch((e) => {
      swallow("mcp request", e);
      if (!res.headersSent) json(res, 500, { error: errMessage(e) });
      else res.destroy();
    });
  });
}
