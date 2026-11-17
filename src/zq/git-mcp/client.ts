import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { errMessage, swallow } from "../../util/errors.ts";
import { GitMcpContractError, assertGitMcpListing } from "./contract.ts";

export interface AckEntry {
  repo: string;
  branch: string;
  from: string | null;
  to: string | null;
}

export interface UpdatedCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  branch: string;
}

export interface BranchUpdate {
  branch: string;
  status: "new" | "updated" | "rewritten" | "deleted";
  oldTip?: string;
  newTip?: string;
  commits: UpdatedCommit[];
  partial?: boolean;
}

export interface RepoUpdates {
  repo: string;
  status: "first_run" | "unchanged" | "changed" | "error";
  error?: string;
  branches?: number;
  updates?: BranchUpdate[];
}

export interface UpdatesResponse {
  repos: RepoUpdates[];
  ack: AckEntry[];
  acknowledged: number;
}

export class GitMcpUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitMcpUnreachable";
  }
}

export class GitMcpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`zq-git-mcp ${code}: ${message}`);
    this.name = "GitMcpError";
    this.code = code;
  }
}

export interface GitMcpClient {
  verify(): Promise<void>;
  call(tool: string, args: Record<string, unknown>, caller: string): Promise<Record<string, unknown>>;
  checkUpdates(caller: string, ack?: readonly AckEntry[], repo?: string): Promise<UpdatesResponse>;
}

export function createGitMcpClient(options: { url: string; secret: string }): GitMcpClient {
  const url = new URL(options.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("the zq-git-mcp url must be http(s) without credentials, query or fragment");
  if (!options.secret) throw new Error("the zq-git-mcp shared secret is required");

  const scrub = (text: string) => text.split(options.secret).join("[secret]");

  async function session<T>(caller: string, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "qm", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${options.secret}`, "x-qm-caller": caller } },
    });
    try {
      await client.connect(transport);
      return await work(client);
    } catch (e) {
      if (e instanceof GitMcpError || e instanceof GitMcpContractError) throw e;
      throw new GitMcpUnreachable(scrub(errMessage(e)));
    } finally {
      await client.close().catch((e) => swallow("close zq-git-mcp client", e));
    }
  }

  async function call(tool: string, args: Record<string, unknown>, caller: string): Promise<Record<string, unknown>> {
    return session(caller, async (client) => {
      const result = await client.callTool({ name: tool, arguments: args });
      const text =
        (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "{}";
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new GitMcpError("bad_response", "the service did not answer with JSON");
      }
      if (result.isError === true) {
        const error = body.error as { code?: string; message?: string } | undefined;
        throw new GitMcpError(error?.code ?? "error", scrub(error?.message ?? "the call failed"));
      }
      return body;
    });
  }

  return {
    verify: () =>
      session("qm-verify", async (client) => {
        const listing = await client.listTools();
        assertGitMcpListing(listing.tools);
      }),
    call,
    async checkUpdates(caller, ack = [], repo) {
      const body = await call(
        "check_updates",
        { ...(repo ? { repo } : {}), ...(ack.length ? { ack: [...ack] } : {}) },
        caller,
      );
      return {
        repos: (body.repos as RepoUpdates[] | undefined) ?? [],
        ack: (body.ack as AckEntry[] | undefined) ?? [],
        acknowledged: Number(body.acknowledged ?? 0),
      };
    },
  };
}
