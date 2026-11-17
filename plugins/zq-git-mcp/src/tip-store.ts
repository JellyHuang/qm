interface BranchTip {
  tip: string;
  seenAt: number;
}

export interface TipStore {
  list(repo: string): Promise<Map<string, BranchTip>>;
  put(repo: string, branch: string, tip: string, seenAt: number): Promise<void>;
  delete(repo: string, branch: string): Promise<void>;
}

export function createMemoryTipStore(): TipStore {
  const tips = new Map<string, Map<string, BranchTip>>();
  const forRepo = (repo: string) => {
    const existing = tips.get(repo);
    if (existing) return existing;
    const created = new Map<string, BranchTip>();
    tips.set(repo, created);
    return created;
  };
  return {
    async list(repo) {
      return new Map(forRepo(repo));
    },
    async put(repo, branch, tip, seenAt) {
      forRepo(repo).set(branch, { tip, seenAt });
    },
    async delete(repo, branch) {
      forRepo(repo).delete(branch);
    },
  };
}
