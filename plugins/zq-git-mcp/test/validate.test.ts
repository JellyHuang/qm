import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitDenied,
  checkAuthor,
  checkBranch,
  checkCount,
  checkOid,
  checkPath,
  checkRange,
  checkRepo,
  checkSha,
  checkSince,
  printable,
} from "../src/validate.ts";

function denies(fn: () => unknown, reason: string) {
  assert.throws(fn, (e) => e instanceof GitDenied && e.reason === reason);
}

test("only the seven repositories pass and nothing resembling a url or path does", () => {
  for (const name of ["client", "clientcode", "CommonMessage", "gameconfig", "jenkinstasks", "server", "zq-ui"])
    assert.equal(checkRepo(name), name);
  for (const bad of [
    "qm-test",
    "Client",
    "client.git",
    "../client",
    "client/",
    "git@lab.skyunion.net:x/client.git",
    "toString",
    "__proto__",
    "",
    1,
    null,
    undefined,
  ])
    denies(() => checkRepo(bad), "repo_not_allowed");
});

test("branch names and ranges reject flags, traversal and odd shapes", () => {
  assert.equal(checkBranch("feature/login-2"), "feature/login-2");
  for (const bad of [
    "--upload-pack=x",
    "-x",
    "a..b",
    "a//b",
    "a/",
    "a.",
    "a b",
    "a;b",
    "a\nb",
    "$(x)",
    "",
    "x".repeat(201),
    5,
  ])
    denies(() => checkBranch(bad), "bad_branch");
  assert.deepEqual(checkRange("main..feature/x"), { base: "main", head: "feature/x" });
  assert.equal(checkRange("main"), undefined);
  denies(() => checkRange("a..b..c"), "bad_range");
  denies(() => checkRange("--output=x..main"), "bad_ref");
  denies(() => checkRange("main..--help"), "bad_ref");
  denies(() => checkRange("a;rm..b"), "bad_ref");
});

test("shas and object ids must be hex of the right length", () => {
  assert.equal(checkSha("ABCDEF1"), "abcdef1");
  for (const bad of ["HEAD", "abc", "main..x", "--stat", "g".repeat(10), "a".repeat(65), 1])
    denies(() => checkSha(bad), "bad_sha");
  assert.equal(checkOid("a".repeat(40)), "a".repeat(40));
  for (const bad of ["abcdef1", "A".repeat(40), "a".repeat(41), "HEAD", ""]) denies(() => checkOid(bad), "bad_oid");
});

test("paths must be repository relative with no traversal, control characters or pathspec magic", () => {
  assert.equal(checkPath("数据/配置.txt"), "数据/配置.txt");
  for (const bad of [
    "",
    "/etc/passwd",
    "-rf",
    ":(top)x",
    "../x",
    "a/../b",
    "a/./b",
    "a//b",
    "a/",
    "a\u0000b",
    "a\tb",
    "x".repeat(1025),
  ])
    denies(() => checkPath(bad), "bad_path");
});

test("authors, dates and counts are bounded", () => {
  assert.equal(checkAuthor("alice@example.test"), "alice@example.test");
  denies(() => checkAuthor(""), "bad_author");
  denies(() => checkAuthor("a\nb"), "bad_author");
  assert.equal(checkSince("2024-03-01"), "2024-03-01");
  assert.equal(checkSince("2024-03-01T10:00:00Z"), "2024-03-01T10:00:00Z");
  for (const bad of ["yesterday", "2024-13-45", "2024-03-01; rm", "--since=x", 5])
    denies(() => checkSince(bad), "bad_date");
  assert.equal(checkCount(undefined, 50, 100), 50);
  assert.equal(checkCount(500, 50, 100), 100);
  for (const bad of [0, -1, 1.5, "3", Number.NaN]) denies(() => checkCount(bad, 50, 100), "bad_number");
});

test("printable replaces control characters and bounds the length for audit labels", () => {
  assert.equal(printable("a\u0000b\nc"), "a?b?c");
  assert.equal(printable("x".repeat(2000))?.length, 1024);
  assert.equal(printable(5), undefined);
});
