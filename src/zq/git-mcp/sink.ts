import type { CommitBatch } from "./poller.ts";

export interface CommitSink {
  record(batches: readonly CommitBatch[]): Promise<void>;
}

export function dedupeBySha(sink: CommitSink, capacity: number): CommitSink {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("dedupeBySha needs a capacity of at least 1");
  const seen = new Set<string>();
  const touch = (key: string) => {
    seen.delete(key);
    seen.add(key);
  };
  return {
    async record(batches) {
      const fresh = new Set<string>();
      const kept = batches.flatMap((batch) => {
        const commits = batch.commits.filter((commit) => {
          const key = `${batch.repo}\n${commit.sha}`;
          if (seen.has(key)) touch(key);
          else if (!fresh.has(key)) {
            fresh.add(key);
            return true;
          }
          return false;
        });
        return batch.commits.length > 0 && commits.length === 0 ? [] : [{ ...batch, commits }];
      });
      if (kept.length > 0) await sink.record(kept);
      for (const key of fresh) touch(key);
      for (const key of seen) {
        if (seen.size <= capacity) break;
        seen.delete(key);
      }
    },
  };
}
