import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirSize } from "../src/fs-util.ts";
import {
  ALICE,
  BOB,
  SECRET_MARKER,
  buildFixture,
  commitAll,
  makeRoot,
  pushAll,
  type Fixture,
} from "./support/fixtures.ts";
import { loggingGit } from "./support/fake-git.ts";
import { startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot();
let fx: Fixture;
let h: Harness;
const logger = loggingGit(root);

before(async () => {
  fx = buildFixture(root);
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: logger.bin });
});
after(async () => {
  await h.stop();
  cleanup();
});

interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  message: string;
  author: { name: string; email: string; date: string };
}

async function commits(args: Record<string, unknown>): Promise<Commit[]> {
  const out = await h.call("list_commits", { repo: "client", ...args });
  assert.equal(out.isError, false, JSON.stringify(out.body));
  return out.body.commits as Commit[];
}

describe("tool registry", () => {
  test("lists exactly the implemented read-only tools and no input takes a url or raw git arguments", async () => {
    const client = await h.connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_commit", "list_commits", "list_repos"]);
    for (const tool of tools) {
      assert.doesNotMatch(tool.name, /write|push|commit_create|delete|merge|archive|clone/);
      const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown> };
      assert.equal(schema.additionalProperties, false);
      for (const key of Object.keys(schema.properties ?? {})) assert.doesNotMatch(key, /url|args|remote|command/);
    }
  });
});

describe("list_repos", () => {
  test("reports all seven repositories with their default branches before and after the first fetch", async () => {
    const before = await h.call("list_repos", {});
    const repos = before.body.repos as {
      name: string;
      defaultBranch: string;
      cloned: boolean;
      lastFetchAt: string | null;
    }[];
    assert.deepEqual(repos.map((r) => r.name).sort(), [
      "CommonMessage",
      "client",
      "clientcode",
      "gameconfig",
      "jenkinstasks",
      "server",
      "zq-ui",
    ]);
    assert.equal(repos.find((r) => r.name === "jenkinstasks")?.defaultBranch, "master");
    assert.equal(repos.find((r) => r.name === "client")?.defaultBranch, "main");
    assert.equal(before.body.truncated, false);
    await commits({ limit: 1 });
    await h.call("list_commits", { repo: "jenkinstasks", limit: 1 });
    const after = await h.call("list_repos", {});
    const byName = new Map(
      (after.body.repos as typeof repos & { head: string; cloneSizeBytes: number }[]).map((r) => [r.name, r]),
    );
    const client = byName.get("client") as unknown as {
      cloned: boolean;
      head: string;
      cloneSizeBytes: number;
      lastFetchAt: string;
    };
    assert.equal(client.cloned, true);
    assert.equal(client.head, "main");
    assert.ok(client.cloneSizeBytes > 0);
    assert.ok(Date.now() - Date.parse(client.lastFetchAt) < 60_000);
    assert.equal((byName.get("jenkinstasks") as unknown as { head: string }).head, "master");
    assert.equal(byName.get("server")?.cloned, false);
    const cache = after.body.cache as { usedBytes: number; capBytes: number };
    assert.equal(cache.usedBytes, 0);
    assert.ok(cache.capBytes > 0);
  });
});

describe("list_commits", () => {
  test("returns commit metadata newest first, with parents, authors and committers", async () => {
    const list = await commits({});
    assert.deepEqual(
      list.map((c) => c.sha),
      [fx.client.third, fx.client.second, fx.client.first, list[3]?.sha],
    );
    assert.equal(list[0]?.subject, "touch empties and update cafe");
    assert.deepEqual(list[0]?.parents, [fx.client.second]);
    assert.equal(list[0]?.author.email, BOB.email);
    assert.equal(list[2]?.message, "add sources\n\nbody of the first commit");
    assert.equal(list[3]?.parents.length, 0);
  });

  test("filters by branch, path, author, since, until and limit", async () => {
    assert.equal((await commits({ branch: "feature/login" }))[0]?.sha, fx.client.featureTip);
    assert.deepEqual(
      (await commits({ path: "数据/配置.txt" })).map((c) => c.sha),
      [fx.client.first],
    );
    assert.deepEqual(
      (await commits({ author: "ALICE" })).map((c) => c.author.email),
      [ALICE.email, ALICE.email],
    );
    assert.deepEqual((await commits({ author: ".*" })).length, 0);
    assert.deepEqual(
      (await commits({ since: "2024-03-15" })).map((c) => c.sha),
      [fx.client.third],
    );
    assert.deepEqual(
      (await commits({ until: "2024-02-15" })).map((c) => c.subject),
      ["add sources", "init client"],
    );
    const limited = await h.call("list_commits", { repo: "client", limit: 2 });
    assert.equal((limited.body.commits as unknown[]).length, 2);
    assert.equal(limited.body.more, true);
    assert.equal(limited.body.truncated, false);
    assert.equal(limited.body.branch, "main");
  });

  test("does not download blobs: the clone does not grow", async () => {
    await commits({ path: "dir/café.txt" });
    const before = await dirSize(join(root, "data", "clones", "client.git"));
    await commits({ path: "src/b.txt" });
    assert.equal(await dirSize(join(root, "data", "clones", "client.git")), before);
  });

  test("an unknown branch is refused as not found", async () => {
    const out = await h.call("list_commits", { repo: "client", branch: "nope" });
    assert.equal(out.isError, true);
    assert.equal((out.body.error as { code: string }).code, "not_found");
  });
});

describe("get_commit", () => {
  const files = async (sha: string) => {
    const out = await h.call("get_commit", { repo: "client", sha });
    assert.equal(out.isError, false, JSON.stringify(out.body));
    return out.body.files as { path: string; status: string; oldPath?: string; oldOid?: string; newOid?: string }[];
  };

  test("returns message, author, committer, parents and marks line counts as on demand", async () => {
    const out = await h.call("get_commit", { repo: "client", sha: fx.client.first.slice(0, 10) });
    assert.equal(out.body.sha, fx.client.first);
    assert.equal(out.body.message, "add sources\n\nbody of the first commit");
    assert.deepEqual(out.body.parents, [(await commits({ until: "2024-01-15" }))[0]?.sha]);
    assert.equal((out.body.author as { email: string }).email, ALICE.email);
    assert.equal((out.body.committer as { name: string }).name, ALICE.name);
    assert.equal(out.body.lineCounts, "on_demand");
    assert.equal(out.body.truncated, false);
    for (const file of out.body.files as Record<string, unknown>[]) {
      assert.equal("additions" in file, false);
      assert.equal("deletions" in file, false);
    }
  });

  test("lists files with unquoted non-ASCII paths and the root commit against the empty tree", async () => {
    const list = await files(fx.client.first);
    assert.deepEqual(
      list.map((f) => `${f.status} ${f.path}`).sort(),
      ["A big.bin", "A dir/café.txt", "A src/a.txt", "A 数据/配置.txt"].sort(),
    );
    const root = (await commits({})).at(-1)?.sha ?? "";
    assert.deepEqual(
      (await files(root)).map((f) => `${f.status} ${f.path}`),
      ["A README.md"],
    );
  });

  test("pairs an exact rename by identical object id and leaves empty files unpaired", async () => {
    const list = await files(fx.client.second);
    const renamed = list.find((f) => f.status === "R");
    assert.equal(renamed?.path, "src/b.txt");
    assert.equal(renamed?.oldPath, "src/a.txt");
    assert.equal(renamed?.oldOid, fx.client.renamedOid);
    assert.equal(renamed?.newOid, fx.client.renamedOid);
    assert.equal(
      list.some((f) => f.path === "src/a.txt"),
      false,
    );
    assert.deepEqual(
      list.filter((f) => f.path.startsWith("empty")).map((f) => `${f.status} ${f.path}`),
      ["A empty1", "A empty2"],
    );
    assert.equal(list.find((f) => f.path === "README.md")?.status, "M");
    const third = await files(fx.client.third);
    assert.deepEqual(
      third.filter((f) => f.path.startsWith("empty")).map((f) => `${f.status} ${f.path}`),
      ["D empty1", "A empty3"],
    );
  });

  test("an unknown sha is refused as not found", async () => {
    const out = await h.call("get_commit", { repo: "client", sha: "deadbeefdeadbeef" });
    assert.equal(out.isError, true);
    assert.equal((out.body.error as { code: string }).code, "not_found");
  });
});

describe("refused calls start no git process", () => {
  const hostile: [string, Record<string, unknown>, string][] = [
    ["list_commits", { repo: "qm-test" }, "repo_not_allowed"],
    ["list_commits", { repo: "git@evil.example:x/y.git" }, "repo_not_allowed"],
    ["list_commits", { repo: "../client" }, "repo_not_allowed"],
    ["list_commits", { repo: "client", branch: "--upload-pack=touch /tmp/x" }, "bad_branch"],
    ["list_commits", { repo: "client", branch: "a..b" }, "bad_branch"],
    ["list_commits", { repo: "client", path: "../../etc/passwd" }, "bad_path"],
    ["list_commits", { repo: "client", path: "/etc/passwd" }, "bad_path"],
    ["list_commits", { repo: "client", path: "a\u0000b" }, "bad_path"],
    ["list_commits", { repo: "client", path: ":(top)x" }, "bad_path"],
    ["list_commits", { repo: "client", since: "yesterday; rm -rf" }, "bad_date"],
    ["list_commits", { repo: "client", author: "a\nb" }, "bad_author"],
    ["list_commits", { repo: "client", limit: -1 }, "bad_number"],
    ["list_commits", { repo: "client", url: "git@evil.example:x.git" }, "bad_arguments"],
    ["list_commits", { repo: "client", args: ["--all"] }, "bad_arguments"],
    ["list_commits", { branch: "main" }, "bad_arguments"],
    ["get_commit", { repo: "client", sha: "HEAD" }, "bad_sha"],
    ["get_commit", { repo: "client", sha: "--output=/tmp/x" }, "bad_sha"],
    ["get_commit", { repo: "client", sha: "main..feature" }, "bad_sha"],
    ["get_commit", { repo: "nope", sha: "abcdef1" }, "repo_not_allowed"],
    ["push", { repo: "client" }, "unknown_tool"],
  ];

  test("hostile repo, ref, sha, range, path and extra arguments are refused before any process starts", async () => {
    const started = logger.calls().length;
    for (const [tool, args, reason] of hostile) {
      const out = await h.call(tool, args);
      assert.equal(out.isError, true, `${tool} ${JSON.stringify(args)}`);
      assert.equal((out.body.error as { code: string }).code, reason, `${tool} ${JSON.stringify(args)}`);
    }
    assert.equal(logger.calls().length, started);
  });
});

describe("audit", () => {
  test("records ok, refused and failed calls with the caller label and no content", async () => {
    const mark = h.audit.rows().length;
    await h.call("get_commit", { repo: "client", sha: fx.client.first }, "alice-bot");
    await h.call("list_commits", { repo: "client", path: "../x" }, "alice-bot");
    await h.call("list_commits", { repo: "client", branch: "missing" }, "alice-bot");
    const rows = h.audit.rows().slice(mark);
    assert.equal(rows.length, 3);
    const [ok, refused, notFound] = rows;
    assert.equal(ok?.result, "ok");
    assert.equal(ok?.caller, "alice-bot");
    assert.equal(ok?.tool, "get_commit");
    assert.equal(ok?.repo, "client");
    assert.equal(ok?.ref, fx.client.first);
    assert.ok((ok?.bytes ?? 0) > 100);
    assert.equal(ok?.truncated, false);
    assert.equal(ok?.cacheHit, false);
    assert.ok((ok?.durationMs ?? -1) >= 0);
    assert.deepEqual(JSON.parse(ok?.args ?? ""), { repo: "client", sha: fx.client.first });
    assert.equal(refused?.result, "refused:bad_path");
    assert.equal(refused?.path, "../x");
    assert.equal(refused?.bytes, 0);
    assert.equal(notFound?.result, "refused:not_found");
    assert.equal(notFound?.ref, "missing");
    const dump = JSON.stringify(rows);
    for (const content of ["body of the first commit", SECRET_MARKER, "add sources"])
      assert.equal(dump.includes(content), false);
  });

  test("a failing git run is recorded as an error with the clean message returned", async () => {
    const broken = await startHarness(
      testConfig(root, `file://${root}/missing/`, { clonesDir: join(root, "broken-clones") }),
    );
    try {
      const out = await broken.call("list_commits", { repo: "client" });
      assert.equal(out.isError, true);
      assert.equal((out.body.error as { code: string }).code, "error");
      const [row] = broken.audit.rows();
      assert.equal(row?.result, "error");
      assert.equal(row?.bytes, 0);
    } finally {
      await broken.stop();
    }
  });

  test("an unknown caller header is labelled unknown", async () => {
    const response = await fetch(h.url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret-0123456789",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_repos", arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(h.audit.rows().at(-1)?.caller, "unknown");
  });
});

describe("response truncation", () => {
  test("cuts a long commit list to the configured size and says how much was cut", async () => {
    const dir = fx.work.server;
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(dir, "f.txt"), `${i}\n`);
      commitAll(dir, `commit number ${i} ${"m".repeat(200)}`, ALICE, `2024-06-01T10:${String(i).padStart(2, "0")}:00Z`);
    }
    pushAll(dir);
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 5000, clonesDir: join(root, "small-clones") }),
    );
    try {
      const out = await small.call("list_commits", { repo: "server", limit: 100 });
      assert.equal(out.isError, false);
      assert.equal(out.body.truncated, true);
      const kept = (out.body.commits as unknown[]).length;
      const cut = (out.body.cut as { items: number }).items;
      assert.ok(kept > 0 && kept < 61);
      assert.equal(kept + cut, 61);
      assert.ok(JSON.stringify(out.body).length <= 5000);
      assert.equal(small.audit.rows().at(-1)?.truncated, true);
      const full = await small.call("list_commits", { repo: "server", limit: 2 });
      assert.equal(full.body.truncated, false);
      assert.equal("cut" in full.body, false);
    } finally {
      await small.stop();
    }
  });

  test("clips an over-long commit message instead of dropping the commit", async () => {
    const dir = fx.work.clientcode;
    writeFileSync(join(dir, "g.txt"), "g\n");
    const sha = commitAll(dir, `long message ${"x".repeat(20_000)}`, BOB, "2024-07-01T10:00:00Z");
    pushAll(dir);
    const small = await startHarness(
      testConfig(root, fx.remoteBase, { truncateChars: 4000, clonesDir: join(root, "small-clones-2") }),
    );
    try {
      const out = await small.call("get_commit", { repo: "clientcode", sha });
      assert.equal(out.body.truncated, true);
      assert.ok((out.body.cut as { chars: number }).chars > 10_000);
      assert.ok((out.body.message as string).startsWith("long message xxx"));
      assert.deepEqual(
        (out.body.files as { path: string }[]).map((f) => f.path),
        ["g.txt"],
      );
      assert.ok(JSON.stringify(out.body).length <= 4000);
    } finally {
      await small.stop();
    }
  });
});

describe("bearer authentication", () => {
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  test("refuses a missing, malformed or wrong secret and serves the right one", async () => {
    for (const authorization of [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      "Bearer wrong-secret-0123456789",
      "Basic dGVzdA==",
      "test-secret-0123456789",
    ]) {
      const response = await fetch(h.url, {
        method: "POST",
        headers: { ...headers, ...(authorization === undefined ? {} : { authorization }) },
        body: rpc,
      });
      assert.equal(response.status, 401, String(authorization));
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
    const ok = await fetch(h.url, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer test-secret-0123456789" },
      body: rpc,
    });
    assert.equal(ok.status, 200);
  });

  test("only POST on the mcp path is served", async () => {
    const auth = { authorization: "Bearer test-secret-0123456789" };
    assert.equal((await fetch(h.url, { method: "GET", headers: { ...headers, ...auth } })).status, 405);
    assert.equal((await fetch(h.url, { method: "DELETE", headers: auth })).status, 405);
    assert.equal(
      (await fetch(`http://127.0.0.1:${h.port}/other`, { method: "POST", headers: { ...headers, ...auth }, body: rpc }))
        .status,
      404,
    );
    assert.equal(
      (await fetch(h.url, { method: "POST", headers: { ...headers, ...auth }, body: "{not json" })).status,
      400,
    );
  });

  test("unauthenticated requests are never audited as tool calls", async () => {
    const before = h.audit.rows().length;
    await fetch(h.url, { method: "POST", headers: headers, body: rpc });
    assert.equal(h.audit.rows().length, before);
  });
});
