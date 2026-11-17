interface BlobMeta {
  size_bytes: number;
  sha256?: string | null;
}

export interface BlobMetaLedger {
  get(repo: string, oid: string): BlobMeta | undefined;
  record(repo: string, oid: string, meta: BlobMeta): void;
  binary(repo: string, oid: string): boolean | undefined;
  markBinary(repo: string, oid: string, binary: boolean): void;
}

export function createMemoryBlobMetaLedger(): BlobMetaLedger {
  const metas = new Map<string, BlobMeta>();
  const flags = new Map<string, boolean>();
  return {
    get: (repo, oid) => metas.get(`${repo}:${oid}`),
    record(repo, oid, meta) {
      const key = `${repo}:${oid}`;
      const previous = metas.get(key);
      metas.set(key, { size_bytes: meta.size_bytes, sha256: meta.sha256 ?? previous?.sha256 ?? null });
    },
    binary: (repo, oid) => flags.get(`${repo}:${oid}`),
    markBinary(repo, oid, binary) {
      flags.set(`${repo}:${oid}`, binary);
    },
  };
}
