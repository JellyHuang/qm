import { crc32 } from "node:zlib";
import { PatchPackageError } from "./settings.ts";
import { sha256Hex } from "./files.ts";

export interface ZipEntry {
  name: string;
  bytes: Buffer;
  executable: boolean;
}

export interface PackageZip {
  name: string;
  sha256: string;
  bytes: number;
  data: Buffer;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 10;
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
const FLAG_UTF8_NAMES = 0x0800;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATE_1980_01_01 = 0x21;
const REGULAR_FILE = 0o100000;
const MAX_ENTRIES = 0xfffe;
const MAX_OFFSET = 0xffffffff;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

function checkName(name: string): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    Buffer.byteLength(name) > 0xffff ||
    segments.some((s) => s === "" || s === "." || s === "..") ||
    /[\u0000-\u001f\u007f\\:]/.test(name)
  )
    throw new PatchPackageError("bad_input", `the file name ${name} cannot go into a zip`);
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  if (sorted.length > MAX_ENTRIES) throw new PatchPackageError("too_large", "the package has too many files for a zip");
  sorted.forEach((entry, i) => {
    checkName(entry.name);
    if (sorted[i - 1]?.name === entry.name)
      throw new PatchPackageError("bad_input", `the file name ${entry.name} is listed twice`);
  });
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(LOCAL_HEADER);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc32(entry.bytes), 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(CENTRAL_HEADER);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    local.copy(header, 6, 4, LOCAL_HEADER);
    header.writeUInt32LE(((REGULAR_FILE | (entry.executable ? 0o755 : 0o644)) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    parts.push(local, name, entry.bytes);
    offset += LOCAL_HEADER + name.length + entry.bytes.length;
    if (offset > MAX_OFFSET) throw new PatchPackageError("too_large", "the package is too large for a zip (4 GiB)");
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(END_RECORD);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export function packageZip(id: string, files: readonly { name: string; bytes: Buffer }[]): PackageZip {
  const data = buildZip(
    files.map((file) => ({ name: `${id}/${file.name}`, bytes: file.bytes, executable: file.name === "apply.sh" })),
  );
  return { name: `${id}.zip`, sha256: sha256Hex(data), bytes: data.length, data };
}
