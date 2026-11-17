export interface FileChange {
  path: string;
  status: "A" | "D" | "M" | "T" | "R";
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
  oldMode: string;
  newMode: string;
}

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const GITLINK = "160000";
const ZERO = /^0+$/;

export function parseRawDiff(output: string): FileChange[] {
  const tokens = output.split("\0");
  const changes: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i] ?? "";
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldOid = "", newOid = "", status = "M"] = meta.slice(1).split(" ");
    const path = tokens[++i] ?? "";
    changes.push({
      path,
      status: status.slice(0, 1) as FileChange["status"],
      ...(ZERO.test(oldOid) ? {} : { oldOid }),
      ...(ZERO.test(newOid) ? {} : { newOid }),
      oldMode,
      newMode,
    });
  }
  return changes;
}

const pairable = (change: FileChange, oid: string | undefined): oid is string =>
  oid !== undefined && oid !== EMPTY_BLOB && change.oldMode !== GITLINK && change.newMode !== GITLINK;

export function pairExactRenames(changes: FileChange[]): FileChange[] {
  const deleted = new Map<string, FileChange[]>();
  for (const change of changes) {
    if (change.status === "D" && pairable(change, change.oldOid))
      deleted.set(change.oldOid, [...(deleted.get(change.oldOid) ?? []), change]);
  }
  const consumed = new Set<FileChange>();
  const out: FileChange[] = [];
  for (const change of changes) {
    if (change.status === "A" && pairable(change, change.newOid)) {
      const source = deleted.get(change.newOid)?.shift();
      if (source) {
        consumed.add(source);
        out.push({ ...change, status: "R", oldPath: source.path, oldOid: source.oldOid, oldMode: source.oldMode });
        continue;
      }
    }
    out.push(change);
  }
  return out.filter((change) => !consumed.has(change));
}
