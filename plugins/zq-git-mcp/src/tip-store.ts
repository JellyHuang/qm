export const TOMBSTONE_TIP = "0".repeat(40);

interface BranchTip {
  tip: string;
  seenAt: number;
}

export interface TipStore {
  list(repo: string): Promise<Map<string, BranchTip>>;
  record(repo: string, branch: string, tip: string, seenAt: number): Promise<void>;
  advance(repo: string, branch: string, from: string | null, to: string, seenAt: number): Promise<boolean>;
  markDeleted(repo: string, branch: string, from: string, seenAt: number): Promise<boolean>;
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
    async record(repo, branch, tip, seenAt) {
      const branches = forRepo(repo);
      if (!branches.has(branch)) branches.set(branch, { tip, seenAt });
    },
    async advance(repo, branch, from, to, seenAt) {
      const branches = forRepo(repo);
      if ((branches.get(branch)?.tip ?? null) !== from) return false;
      branches.set(branch, { tip: to, seenAt });
      return true;
    },
    async markDeleted(repo, branch, from, seenAt) {
      const branches = forRepo(repo);
      if (from === TOMBSTONE_TIP || branches.get(branch)?.tip !== from) return false;
      branches.set(branch, { tip: TOMBSTONE_TIP, seenAt });
      return true;
    },
  };
}
