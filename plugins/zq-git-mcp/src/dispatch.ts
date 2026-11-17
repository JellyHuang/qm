import { z } from "zod";
import { errMessage, swallow } from "../../chassis/src/errors.ts";
import type { AuditResult, AuditSink } from "./audit.ts";
import { DiskSpaceLowError } from "./scratch.ts";
import type { ToolContext, ToolDef, Services } from "./tools/types.ts";
import { fitToChars } from "./truncate.ts";
import { GitDenied, printable } from "./validate.ts";

interface ToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolReply {
  text: string;
  isError: boolean;
}

export interface Dispatcher {
  list(): ToolListing[];
  call(name: string, rawArgs: unknown, caller: string): Promise<ToolReply>;
}

export interface DispatcherOptions {
  tools: readonly ToolDef[];
  services: Services;
  audit: AuditSink;
  truncateChars: number;
  now?: () => number;
}

const MAX_ARGS_JSON = 4096;
const ENVELOPE_RESERVE = 160;

function describeFailure(e: unknown): { code: string; message: string; result: AuditResult } {
  if (e instanceof GitDenied) return { code: e.reason, message: e.message, result: `refused:${e.reason}` };
  if (e instanceof DiskSpaceLowError) return { code: "disk_space_low", message: e.message, result: "error" };
  return { code: "error", message: errMessage(e), result: "error" };
}

function targetOf(rawArgs: unknown) {
  const args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  const repo = printable(args.repo);
  const ref = printable(args.ref ?? args.sha ?? args.range ?? args.branch);
  const path = printable(args.path);
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(ref === undefined ? {} : { ref }),
    ...(path === undefined ? {} : { path }),
  };
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { tools, services, audit, truncateChars } = options;
  const now = options.now ?? Date.now;

  async function execute(name: string, rawArgs: unknown, ctx: ToolContext) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new GitDenied("unknown_tool", "no such tool");
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success)
      throw new GitDenied("bad_arguments", parsed.error.issues.map((issue) => issue.message).join("; "));
    const data = await (tool.run as (ctx: ToolContext, args: unknown) => Promise<Record<string, unknown>>)(
      ctx,
      parsed.data,
    );
    const fitted = fitToChars(data, truncateChars - ENVELOPE_RESERVE);
    return {
      ...fitted.value,
      truncated: data.truncated === true || fitted.truncated,
      ...(fitted.truncated ? { cut: { items: fitted.cutItems, chars: fitted.cutChars } } : {}),
    };
  }

  return {
    list: () =>
      tools.map((tool) => {
        const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
        return { name: tool.name, description: tool.description, inputSchema };
      }),
    async call(name, rawArgs, caller) {
      const started = now();
      const ctx: ToolContext = {
        ...services,
        caller,
        state: { cacheHit: false },
        git: (repo, args, opts) => services.runner.run(services.repos.dir(repo), args, opts),
      };
      let reply: ToolReply;
      let result: AuditResult = "ok";
      let truncated = false;
      try {
        const body = await execute(name, rawArgs, ctx);
        truncated = body.truncated;
        reply = { text: JSON.stringify(body), isError: false };
      } catch (e) {
        const failure = describeFailure(e);
        result = failure.result;
        reply = { text: JSON.stringify({ error: { code: failure.code, message: failure.message } }), isError: true };
      }
      const argsJson = JSON.stringify(rawArgs ?? {}) ?? "{}";
      try {
        await audit.record({
          at: started,
          caller,
          tool: printable(name) ?? "",
          ...targetOf(rawArgs),
          args: argsJson.slice(0, MAX_ARGS_JSON),
          bytes: reply.isError ? 0 : Buffer.byteLength(reply.text),
          truncated,
          result,
          durationMs: now() - started,
          cacheHit: ctx.state.cacheHit,
        });
      } catch (e) {
        swallow("audit record", e);
      }
      return reply;
    },
  };
}
