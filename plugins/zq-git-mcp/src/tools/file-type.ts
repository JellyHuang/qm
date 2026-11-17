const OFFICE = /\.(xlsx|xlsm|docx|pptx)$/i;

const SIGNATURES: [string, number[]][] = [
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["jpeg", [0xff, 0xd8, 0xff]],
  ["gif", [0x47, 0x49, 0x46, 0x38]],
  ["pdf", [0x25, 0x50, 0x44, 0x46]],
  ["gzip", [0x1f, 0x8b]],
  ["psd", [0x38, 0x42, 0x50, 0x53]],
  ["elf", [0x7f, 0x45, 0x4c, 0x46]],
  ["sqlite", [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66]],
];

const startsWith = (head: Buffer, signature: number[], at = 0) => signature.every((byte, i) => head[at + i] === byte);

export function detectType(head: Buffer, path: string): string {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]))
    return OFFICE.test(path) ? (/\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? "zip") : "zip";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  return SIGNATURES.find(([, signature]) => startsWith(head, signature))?.[0] ?? "unknown";
}
