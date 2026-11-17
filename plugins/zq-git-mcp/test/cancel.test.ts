import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sleep } from "../src/async.ts";
import { fakeGit } from "./support/fake-git.ts";
import { buildFixture, makeRoot, type Fixture } from "./support/fixtures.ts";
import { SECRET, startHarness, testConfig, type Harness } from "./support/harness.ts";

const { root, cleanup } = makeRoot("zqgit-cancel-");
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const pidFile = join(root, "sleeper.pid");
let fx: Fixture;
let h: Harness;

before(async () => {
  fx = buildFixture(root);
  const stall = fakeGit(
    root,
    `case " $* " in *" fetch "*) case " $* " in *" --prune "*) ;; *) sleep 60 &\necho $! > ${pidFile}\nwait;; esac;; esac\nexec ${REAL_GIT} "$@"`,
  );
  h = await startHarness(testConfig(root, fx.remoteBase), { gitBinary: stall });
});
after(async () => {
  await h.stop();
  cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

test("a cancelled request kills the fetch process group, removes its scratch and is audited", async () => {
  const scratch = join(root, "data", "scratch");
  const abort = new AbortController();
  const request = fetch(h.url, {
    method: "POST",
    signal: abort.signal,
    headers: {
      authorization: `Bearer ${SECRET}`,
      "x-qm-caller": "canceller",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "read_file",
        arguments: { repo: "client", ref: "main", path: "README.md" },
      },
    }),
  }).catch(() => undefined);
  assert.equal(await until(() => existsSync(pidFile)), true);
  const sleeper = Number(readFileSync(pidFile, "utf8").trim());
  assert.equal(alive(sleeper), true);
  assert.equal(readdirSync(scratch).length, 1);
  abort.abort();
  await request;
  assert.equal(await until(() => !alive(sleeper)), true);
  assert.equal(await until(() => readdirSync(scratch).length === 0), true);
  assert.equal(await until(() => h.audit.rows().some((row) => row.caller === "canceller")), true);
  const row = h.audit.rows().find((entry) => entry.caller === "canceller");
  assert.equal(row?.tool, "read_file");
  assert.equal(row?.result, "error");
});

test("after a cancellation the service keeps answering and its concurrency slots are free", async () => {
  const out = await h.call("list_commits", { repo: "client", limit: 1 });
  assert.equal(out.isError, false);
  assert.equal((out.body.commits as unknown[]).length, 1);
});
