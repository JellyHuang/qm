export interface SizeLedger {
  size(repo: string, oid: string): number | undefined;
  record(repo: string, oid: string, size: number): void;
}

export function createMemorySizeLedger(): SizeLedger {
  const sizes = new Map<string, number>();
  return {
    size: (repo, oid) => sizes.get(`${repo}:${oid}`),
    record: (repo, oid, size) => void sizes.set(`${repo}:${oid}`, size),
  };
}
