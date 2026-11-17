interface BlobMeta {
  size: number;
  binary?: boolean;
}

export interface BlobMetaLedger {
  get(repo: string, oid: string): BlobMeta | undefined;
  record(repo: string, oid: string, meta: BlobMeta): void;
}

export function createMemoryBlobMetaLedger(): BlobMetaLedger {
  const metas = new Map<string, BlobMeta>();
  return {
    get: (repo, oid) => metas.get(`${repo}:${oid}`),
    record(repo, oid, meta) {
      const key = `${repo}:${oid}`;
      metas.set(key, { ...metas.get(key), ...meta });
    },
  };
}
