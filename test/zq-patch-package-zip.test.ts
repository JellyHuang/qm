import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";
import { buildZip } from "../src/zq/patch-package/zip.ts";
import { buildFrom, makeApplier, makeClone, makeLfsRepo } from "./support/patch-package-apply.ts";
import { git, put, scratchDir } from "./support/patch-package-fixture.ts";

const haveTool = (command: string, args: string[]) => spawnSync(command, args, { stdio: "ignore" }).status === 0;
const skipUnzip = haveTool("unzip", ["-v"]) ? false : "unzip is not installed";
const skipPython = haveTool("python3", ["-V"]) ? false : "python3 is not installed";

const LISTING = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(bad if bad else "ok")
for i in z.infolist():
    print("|".join(map(str, [i.filename, oct(i.external_attr >> 16), i.date_time, i.compress_type, i.flag_bits, i.create_system])))
`;

function mixedChange(repo: string) {
  put(repo, "readme.txt", "one\nTWO\nthree\n");
  put(repo, "crlf.txt", "first\r\nsecond\r\n");
  put(repo, "blob.bin", Buffer.from([0, 255, 13, 10, 0, 1, 2, 3]));
  put(repo, "tables/items.xlsx", Buffer.from("PK-new-items-workbook-bytes".repeat(60)));
}

test("two builds of the same inputs give byte-identical zips", async (t) => {
  const fixture = makeLfsRepo(t);
  mixedChange(fixture.repo);
  const first = await buildFrom(t, fixture);
  const second = await buildFrom(t, fixture);
  assert.equal(first.zip.sha256, second.zip.sha256);
  assert.deepEqual(first.zip.data, second.zip.data);
  assert.equal(first.zip.name, `${first.id}.zip`);
  assert.equal(first.zip.bytes, first.zip.data.length);
});

test(
  "zip entries are sorted, forward slash, relative, stamped 1980-01-01 and carry unix modes",
  { skip: skipPython },
  async (t) => {
    const fixture = makeLfsRepo(t);
    mixedChange(fixture.repo);
    const pkg = await buildFrom(t, fixture);
    const zipPath = join(scratchDir(t, "pp-zip-"), pkg.zip.name);
    writeFileSync(zipPath, pkg.zip.data);
    const listing = execFileSync("python3", ["-I", "-c", LISTING, zipPath], { encoding: "utf8" }).trim().split("\n");
    assert.equal(listing[0], "ok");
    const rows = listing.slice(1).map((line) => line.split("|"));
    const names = rows.map((row) => row[0] as string);
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(
      names,
      pkg.files.map((file) => `${pkg.id}/${file.name}`),
    );
    for (const name of names) {
      assert.ok(name.startsWith(`${pkg.id}/`) && !name.includes("\\") && !name.includes(".."), name);
    }
    for (const [name, mode, stamp, method, flags, system] of rows) {
      assert.equal(mode, name === `${pkg.id}/apply.sh` ? "0o100755" : "0o100644", name);
      assert.equal(stamp, "(1980, 1, 1, 0, 0, 0)");
      assert.equal(method, "0");
      assert.equal(flags, "2048");
      assert.equal(system, "3");
    }
  },
);

test(
  "the unzipped package keeps every byte and the executable bit, and apply.sh makes the commit from it",
  {
    skip: skipUnzip,
  },
  async (t) => {
    const fixture = makeLfsRepo(t);
    mixedChange(fixture.repo);
    const pkg = await buildFrom(t, fixture);
    const home = scratchDir(t, "pp-unzip-");
    const zipPath = join(home, pkg.zip.name);
    writeFileSync(zipPath, pkg.zip.data);
    const tested = spawnSync("unzip", ["-tq", zipPath], { encoding: "utf8" });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    const extracted = join(home, "out");
    execFileSync("unzip", ["-q", "-d", extracted, zipPath]);
    assert.deepEqual(readdirSync(extracted), [pkg.id]);
    const root = join(extracted, pkg.id);
    for (const file of pkg.files) {
      assert.deepEqual(readFileSync(join(root, file.name)), readFileSync(file.path), file.name);
      assert.equal(statSync(join(root, file.name)).mode & 0o777, file.name === "apply.sh" ? 0o755 : 0o644, file.name);
    }
    assert.ok(readFileSync(join(root, "apply.cmd"), "utf8").includes("\r\n"));
    assert.ok(readFileSync(join(root, "apply.sh"), "utf8").startsWith("#!"));
    assert.ok(!readFileSync(join(root, "apply.sh"), "utf8").includes("\r"));

    const clone = makeClone(t, fixture.repo, { lfs: true });
    const before = git(clone, "rev-parse", "HEAD");
    const result = makeApplier(t).run(root, ["--repo", clone]);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(git(clone, "rev-list", "--count", `${before}..HEAD`), "1");
    const blob = (path: string) => execFileSync("git", ["-C", clone, "cat-file", "blob", `HEAD:${path}`]);
    assert.deepEqual(blob("crlf.txt"), Buffer.from("first\r\nsecond\r\n"));
    assert.deepEqual(blob("blob.bin"), Buffer.from([0, 255, 13, 10, 0, 1, 2, 3]));
    assert.equal(blob("readme.txt").toString(), "one\nTWO\nthree\n");
    assert.match(blob("tables/items.xlsx").toString(), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
  },
);

test("the size cap applies to the real zip: a package just under passes and one byte over is refused", async (t) => {
  const fixture = makeLfsRepo(t);
  put(fixture.repo, "tables/items.xlsx", Buffer.alloc(150_000, 7));
  const reference = await buildFrom(t, fixture);
  const exact = reference.zip.bytes;
  const total = reference.files.reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(total < exact - 1, "the files alone are under the cap, so only the zip measurement can refuse");

  const out = scratchDir(t, "pp-out-");
  const fits = await buildFrom(t, fixture, {}, { maxPackageBytes: exact }, out);
  assert.equal(fits.zip.bytes, exact);
  const refused = scratchDir(t, "pp-out-");
  await assert.rejects(buildFrom(t, fixture, {}, { maxPackageBytes: exact - 1 }, refused), (e: unknown) => {
    assert.ok(e instanceof PatchPackageError);
    assert.equal(e.code, "too_large");
    assert.match(e.message, /ZQ_PATCH_MAX_PACKAGE_BYTES/);
    assert.match(e.message, /another delivery route/);
    assert.match(e.message, new RegExp(String(exact)));
    return true;
  });
  assert.deepEqual(readdirSync(refused), []);
});

test("a package whose files alone exceed the cap is refused before any zip is built", async (t) => {
  const fixture = makeLfsRepo(t);
  put(fixture.repo, "tables/items.xlsx", Buffer.alloc(150_000, 7));
  const refused = scratchDir(t, "pp-out-");
  await assert.rejects(
    buildFrom(t, fixture, {}, { maxPackageBytes: 100_000 }, refused),
    (e: unknown) =>
      e instanceof PatchPackageError && e.code === "too_large" && /another delivery route/.test(e.message),
  );
  assert.deepEqual(readdirSync(refused), []);
});

test("buildZip refuses names that are absolute, climb out, use backslashes or repeat", () => {
  const entry = (name: string) => ({ name, bytes: Buffer.from("x"), executable: false });
  for (const bad of ["/abs", "../up", "a/../b", "a\\b", "a//b", "", "C:evil", "a\u0000b"])
    assert.throws(() => buildZip([entry(bad)]), PatchPackageError, JSON.stringify(bad));
  assert.throws(() => buildZip([entry("a"), entry("a")]), PatchPackageError);
  assert.deepEqual(buildZip([entry("b"), entry("a")]), buildZip([entry("a"), entry("b")]));
});
