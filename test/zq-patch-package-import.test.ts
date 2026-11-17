import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED_GIT_SUBCOMMANDS } from "../src/zq/patch-package/git.ts";

test("importing the patch package library reads no environment, spawns nothing and opens no connection", () => {
  const out = execFileSync(
    process.execPath,
    [
      join(import.meta.dirname, "support", "patch-package-import-probe.ts"),
      join(import.meta.dirname, "..", "src", "zq", "patch-package"),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  const probe = JSON.parse(out) as { events: string[]; exported: number };
  assert.deepEqual(probe.events, []);
  assert.ok(probe.exported > 20);
});

test("the git allowlist gained check-attr only and still has no network or history rewriting subcommand", () => {
  assert.ok(ALLOWED_GIT_SUBCOMMANDS.includes("check-attr"));
  assert.deepEqual([...ALLOWED_GIT_SUBCOMMANDS].sort(), [
    "add",
    "am",
    "apply",
    "cat-file",
    "check-attr",
    "commit",
    "diff",
    "format-patch",
    "init",
    "read-tree",
    "rev-parse",
    "update-ref",
  ]);
});
