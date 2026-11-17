import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitBlobId } from "../src/zq/patch-package/files.ts";
import { createGitRunner } from "../src/zq/patch-package/git.ts";
import { classifyChanges, isLfsPointer, type BaseReader, type ChangeRef } from "../src/zq/patch-package/lfs.ts";
import { createServiceReader, type ReadFileCall } from "../src/zq/patch-package/reader.ts";
import { PatchPackageError } from "../src/zq/patch-package/settings.ts";
import { git as realGit, scratchDir } from "./support/patch-package-fixture.ts";

const runner = createGitRunner({ name: "QM Bot", email: "qm-bot@invalid" });
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12\n`;

function memoryReader(files: Record<string, string | Buffer>): BaseReader {
  return {
    async stat(path) {
      const content = files[path];
      if (content === undefined) return null;
      const bytes = Buffer.from(content);
      const pointer = isLfsPointer(bytes);
      return {
        blobId: gitBlobId(bytes),
        size: bytes.length,
        kind: pointer ? "lfs_pointer" : "text",
        ...(pointer ? { pointer: bytes } : {}),
      };
    },
    async bytes(path) {
      const content = files[path];
      return content === undefined ? null : Buffer.from(content);
    },
  };
}

const change = (path: string, over: Partial<ChangeRef> = {}): ChangeRef => ({
  path,
  status: "M",
  binary: false,
  sameBlob: false,
  newPointer: false,
  ...over,
});

async function expectRefusal(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof PatchPackageError, String(e));
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test("check-attr decides lfs, nested negation, macros and new directories through the attribute chain", async (t) => {
  const tmp = scratchDir(t);
  const reader = memoryReader({
    ".gitattributes":
      "[attr]lfs filter=lfs diff=lfs merge=lfs -text\n*.xlsx lfs\n*.png lfs\n/assets/raw/** filter=lfs\n",
    "assets/ui/.gitattributes": "*.png -filter\nicons/*.psd filter=lfs\nbig.dat filter=lfs\n",
    "src/nested/.gitattributes": "*.xlsx !filter\n",
    "a.xlsx": POINTER,
    "docs/readme.md": "text\n",
  });
  const paths = [
    "a.xlsx",
    "we ird/sp ace.xlsx",
    "assets/ui/b.png",
    "assets/ui/icons/x.psd",
    "assets/ui/sub/big.dat",
    "assets/raw/deep/sub/t.bin",
    "src/nested/s.xlsx",
    "docs/readme.md",
    "no/such/dir/new.xlsx",
  ];
  const result = await classifyChanges(
    runner,
    reader,
    paths.map((path) => change(path, { status: path === "a.xlsx" || path === "docs/readme.md" ? "M" : "A" })),
    tmp,
  );
  const kinds = Object.fromEntries(paths.map((p) => [p, result.get(p)?.kind]));
  assert.deepEqual(kinds, {
    "a.xlsx": "lfs",
    "we ird/sp ace.xlsx": "lfs",
    "assets/ui/b.png": "text",
    "assets/ui/icons/x.psd": "lfs",
    "assets/ui/sub/big.dat": "lfs",
    "assets/raw/deep/sub/t.bin": "lfs",
    "src/nested/s.xlsx": "text",
    "docs/readme.md": "text",
    "no/such/dir/new.xlsx": "lfs",
  });
  assert.equal(result.get("a.xlsx")?.baseBlob, gitBlobId(Buffer.from(POINTER)));
  assert.deepEqual(result.get("a.xlsx")?.warnings, []);
  assert.match(result.get("no/such/dir/new.xlsx")?.warnings[0] ?? "", /stored as a Git LFS pointer/);
  assert.equal(result.get("src/nested/s.xlsx")?.kind, "text");
  assert.deepEqual(readdirSync(tmp), []);
});

test("binary content without an LFS rule is classified binary, and an unset rule overrides the root rule", async (t) => {
  const reader = memoryReader({ ".gitattributes": "*.dat filter=lfs\n", "keep/.gitattributes": "*.dat -filter\n" });
  const result = await classifyChanges(
    runner,
    reader,
    [change("keep/x.dat", { status: "A", binary: true }), change("x.dat", { status: "A", binary: true })],
    scratchDir(t),
  );
  assert.equal(result.get("keep/x.dat")?.kind, "binary");
  assert.equal(result.get("x.dat")?.kind, "lfs");
});

test("mismatches, other filters, case dependent rules and attribute changes are refused", async (t) => {
  const tmp = scratchDir(t);
  await expectRefusal(
    classifyChanges(runner, memoryReader({ "a.dat": POINTER }), [change("a.dat")], tmp),
    "lfs_attribute_mismatch",
    /pointer at the base commit/,
  );
  await expectRefusal(
    classifyChanges(
      runner,
      memoryReader({ ".gitattributes": "*.dat filter=crypt\n", "a.dat": "x" }),
      [change("a.dat")],
      tmp,
    ),
    "unsupported_filter",
    /crypt/,
  );
  await expectRefusal(
    classifyChanges(
      runner,
      memoryReader({ ".gitattributes": "*.xlsx filter=lfs\n", "Sub/UPPER.XLSX": "x" }),
      [change("Sub/UPPER.XLSX")],
      tmp,
    ),
    "attributes_case_dependent",
    /letter case/,
  );
  await expectRefusal(
    classifyChanges(runner, memoryReader({}), [change("sub/.gitattributes")], tmp),
    "attributes_changed",
  );
  await expectRefusal(
    classifyChanges(runner, memoryReader({}), [change("new.txt", { oldPath: ".gitattributes", status: "R" })], tmp),
    "attributes_changed",
  );
  await expectRefusal(
    classifyChanges(
      runner,
      memoryReader({ ".gitattributes": "*.dat filter=lfs\n" }),
      [change("b.dat", { status: "A", newPointer: true })],
      tmp,
    ),
    "lfs_pointer_content",
  );
  await expectRefusal(
    classifyChanges(runner, memoryReader({}), [change("b.txt", { status: "A", newPointer: true })], tmp),
    "lfs_attribute_mismatch",
  );
  const same = await classifyChanges(
    runner,
    memoryReader({ ".gitattributes": "*.dat filter=lfs\n", "a.dat": POINTER }),
    [change("a.dat", { sameBlob: true, newPointer: true })],
    tmp,
  );
  assert.equal(same.get("a.dat")?.kind, "lfs");
});

function fakeService(
  files: Record<string, Buffer | { pointer: { oid: string; size: number }; blob: string }>,
  cut = 0,
) {
  const calls: { path: string; offset?: number; length?: number }[] = [];
  const read: ReadFileCall = async (args) => {
    calls.push(args);
    const file = files[args.path];
    if (file === undefined) return null;
    if (!Buffer.isBuffer(file))
      return {
        kind: "lfs_pointer",
        oid: file.blob,
        size: Buffer.byteLength(POINTER),
        lfsOid: file.pointer.oid,
        lfsSize: file.pointer.size,
      };
    const binary = file.includes(0);
    const from = Math.min(args.offset ?? 0, file.length);
    const wanted = Math.min(args.length ?? file.length - from, file.length - from);
    const take = cut > 0 ? Math.min(wanted, cut) : wanted;
    const slice = file.subarray(from, from + take);
    const common = { kind: binary ? "binary" : "text", oid: gitBlobId(file), size: file.length };
    return binary
      ? { ...common, offset: from, length: slice.length, base64: slice.toString("base64") }
      : { ...common, offset: from, length: slice.length, content: slice.toString("utf8") };
  };
  return { read, calls };
}

test("the service reader returns exact bytes for CRLF, a BOM, a missing final newline and multibyte text at chunk boundaries", async () => {
  const cases: Record<string, Buffer> = {
    "crlf.txt": Buffer.from("one\r\ntwo\r\nthree"),
    "bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名前\n値\n")]),
    "cjk.txt": Buffer.from("日本語のテキスト、境界をまたぐ文字。\n".repeat(7)),
    "emoji.txt": Buffer.from("a😀b😀c😀d😀e😀f\n".repeat(5)),
    "replacement.txt": Buffer.from("legit � char\n".repeat(9)),
    "bin.dat": Buffer.concat([Buffer.alloc(100, 1), Buffer.from([0, 255, 254]), Buffer.alloc(100, 2)]),
    "empty.txt": Buffer.alloc(0),
  };
  for (const chunkBytes of [16, 17, 19, 64]) {
    for (const cut of [0, 5]) {
      const service = fakeService(cases, cut);
      const reader = createServiceReader(service.read, { chunkBytes });
      for (const [path, expected] of Object.entries(cases)) {
        const got = await reader.bytes(path);
        assert.ok(got !== null && got.equals(expected), `${path} chunk ${chunkBytes} cut ${cut}`);
      }
      assert.equal(await reader.bytes("absent.txt"), null);
    }
  }
});

test("the service reader refuses non UTF-8 text, a service that lies and a changing file", async () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]);
  const service = fakeService({ "gbk.txt": gbk, "ok.txt": Buffer.from("fine\n") });
  const reader = createServiceReader(service.read, { chunkBytes: 16 });
  await expectRefusal(reader.bytes("gbk.txt"), "not_utf8", /not valid UTF-8/);

  const lying: ReadFileCall = async (args) => {
    const result = await service.read(args);
    return result && { ...result, content: "tampered\n" };
  };
  await expectRefusal(createServiceReader(lying).bytes("ok.txt"), "oid_mismatch", /object id/);

  const stuck: ReadFileCall = async (args) => {
    const result = await service.read(args);
    return result && args.length !== 1 ? { ...result, content: "" } : result;
  };
  await expectRefusal(createServiceReader(stuck).bytes("ok.txt"), "bad_input", /advance/);

  const vanishing: ReadFileCall = async (args) => (args.length === 1 ? service.read(args) : null);
  await expectRefusal(createServiceReader(vanishing).bytes("ok.txt"), "bad_input", /changed while/);

  const submodule: ReadFileCall = async () => ({ kind: "submodule", commit: "c".repeat(40) });
  await expectRefusal(createServiceReader(submodule).stat("sub"), "unsupported", /submodule/);
});

test("an LFS pointer from the service is rebuilt from lfsOid and lfsSize and checked against its object id", async () => {
  const pointer = Buffer.from(POINTER);
  const service = fakeService({
    "p.xlsx": { pointer: { oid: "a".repeat(64), size: 12 }, blob: gitBlobId(pointer) },
    "odd.xlsx": { pointer: { oid: "a".repeat(64), size: 12 }, blob: "0".repeat(40) },
  });
  const reader = createServiceReader(service.read);
  const info = await reader.stat("p.xlsx");
  assert.equal(info?.kind, "lfs_pointer");
  assert.equal(info?.pointer?.toString("utf8"), POINTER);
  assert.ok((await reader.bytes("p.xlsx"))?.equals(pointer));
  await expectRefusal(reader.bytes("odd.xlsx"), "oid_mismatch");
});

test("the blob id helper agrees with git hash-object --no-filters", (t) => {
  const repo = scratchDir(t);
  realGit(repo, "init", "-q");
  for (const bytes of [Buffer.from("日本語\r\nline\n"), Buffer.alloc(0), Buffer.from([0, 255, 10])]) {
    writeFileSync(join(repo, "f"), bytes);
    assert.equal(gitBlobId(bytes), realGit(repo, "hash-object", "--no-filters", "--", "f"));
  }
});
