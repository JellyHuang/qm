export interface FileChange {
  kind: "file" | "submodule";
  path: string;
  status: "A" | "D" | "M" | "T" | "R";
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
  oldCommit?: string;
  newCommit?: string;
  oldMode: string;
  newMode: string;
}

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const GITLINK_MODE = "160000";
const ZERO = /^0+$/;

export function parseRawDiff(output: string): FileChange[] {
  const tokens = output.split("\0");
  const changes: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i] ?? "";
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldOid = "", newOid = "", status = "M"] = meta.slice(1).split(" ");
    const path = tokens[++i] ?? "";
    const submodule = oldMode === GITLINK_MODE || newMode === GITLINK_MODE;
    const oldId = ZERO.test(oldOid) ? undefined : oldOid;
    const newId = ZERO.test(newOid) ? undefined : newOid;
    changes.push({
      kind: submodule ? "submodule" : "file",
      path,
      status: status.slice(0, 1) as FileChange["status"],
      ...(submodule
        ? {
            ...(oldId ? { oldCommit: oldId } : {}),
            ...(newId ? { newCommit: newId } : {}),
          }
        : {
            ...(oldId ? { oldOid: oldId } : {}),
            ...(newId ? { newOid: newId } : {}),
          }),
      oldMode,
      newMode,
    });
  }
  return changes;
}

const pairable = (change: FileChange, oid: string | undefined): oid is string =>
  change.kind === "file" && oid !== undefined && oid !== EMPTY_BLOB;

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
