import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALICE, BOB, commitAll, git, pushAll, type Fixture } from "./fixtures.ts";

export const LFS_OID_ONE = "a".repeat(64);
export const LFS_OID_TWO = "b".repeat(64);

export const pointerFor = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

export function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000)]);
}

export interface FilesFixture {
  c1: string;
  c2: string;
  c3: string;
  c4: string;
  c5: string;
  c6: string;
  c7: string;
  submoduleCommit: string;
  pointerOneOid: string;
  pointerTwoOid: string;
  realOid: string;
  pngOid: string;
}

export function buildFilesFixture(fx: Fixture): FilesFixture {
  const dir = fx.work.gameconfig;
  mkdirSync(join(dir, "配置"), { recursive: true });
  writeFileSync(join(dir, "app.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(dir, "配置", "说明.txt"), "中文说明\n第二行\n");
  writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(dir, "pointer.bin"), pointerFor(LFS_OID_ONE, 123456));
  writeFileSync(join(dir, "real.bin"), "real content under an lfs attributed path\n");
  writeFileSync(join(dir, "pic.png"), pngBytes());
  writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\n");
  writeFileSync(join(dir, "notes.txt"), Array.from({ length: 10 }, (_, i) => `note number ${i + 1}`).join("\n") + "\n");
  const c1 = commitAll(dir, "first batch", ALICE, "2024-02-01T10:00:00Z");
  writeFileSync(join(dir, "app.txt"), "alpha\nBETA\ngamma\n");
  writeFileSync(join(dir, "pic.png"), Buffer.concat([pngBytes(), Buffer.from([1, 2, 3])]));
  writeFileSync(join(dir, "pointer.bin"), pointerFor(LFS_OID_TWO, 654321));
  const c2 = commitAll(dir, "bob edits", BOB, "2024-03-01T10:00:00Z");
  writeFileSync(join(dir, "app.txt"), "alpha\nBETA\ngamma\ndelta\n");
  const c3 = commitAll(dir, "alice appends", ALICE, "2024-04-01T10:00:00Z");
  git(dir, ["mv", "notes.txt", "notes2.txt"], BOB);
  writeFileSync(
    join(dir, "notes2.txt"),
    Array.from({ length: 10 }, (_, i) => (i === 9 ? "note number ten changed" : `note number ${i + 1}`)).join("\n") +
      "\n",
  );
  const c4 = commitAll(dir, "rename notes", BOB, "2024-05-01T10:00:00Z");
  const inner = join(dir, "vendor", "lib");
  mkdirSync(inner, { recursive: true });
  git(inner, ["init", "-q", "-b", "main"], ALICE);
  writeFileSync(join(inner, "lib.txt"), "library\n");
  const submoduleCommit = commitAll(inner, "library", ALICE, "2024-05-15T10:00:00Z");
  const c5 = commitAll(dir, "add submodule", ALICE, "2024-06-01T10:00:00Z");
  git(dir, ["rm", "-q", "crlf.txt"], BOB);
  writeFileSync(join(dir, "real.bin"), "real content changed\n");
  const c6 = commitAll(dir, "delete and edit", BOB, "2024-07-01T10:00:00Z");
  git(dir, ["mv", "app.txt", "app-renamed.txt"], ALICE);
  const c7 = commitAll(dir, "rename app", ALICE, "2024-08-01T10:00:00Z");
  pushAll(dir);
  return {
    c1,
    c2,
    c3,
    c4,
    c5,
    c6,
    c7,
    submoduleCommit,
    pointerOneOid: git(dir, ["rev-parse", `${c1}:pointer.bin`]),
    pointerTwoOid: git(dir, ["rev-parse", `${c2}:pointer.bin`]),
    realOid: git(dir, ["rev-parse", `${c1}:real.bin`]),
    pngOid: git(dir, ["rev-parse", `${c1}:pic.png`]),
  };
}
