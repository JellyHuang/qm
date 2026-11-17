import {
  GitMcpUnreachable,
  type AckEntry,
  type GitMcpClient,
  type RepoUpdates,
  type UpdatedCommit,
} from "../../src/zq/git-mcp/client.ts";
import { GitMcpContractError } from "../../src/zq/git-mcp/contract.ts";

export interface FakeRequest {
  kind: "verify" | "check_updates";
  caller: string;
  ack: AckEntry[];
}

export function fakeCommit(sha: string): UpdatedCommit {
  return {
    sha,
    authorName: "A",
    authorEmail: "a@corp.example",
    date: "2025-01-01T00:00:00Z",
    subject: sha,
    branch: "main",
  };
}

export function createFakeGitMcp() {
  const history = new Map<string, string[]>();
  const tips = new Map<string, string>();
  const requests: FakeRequest[] = [];
  const state = { down: false, drift: false, gate: undefined as undefined | Promise<void> };

  async function checkUpdates(caller: string, ack: readonly AckEntry[] = []) {
    requests.push({ kind: "check_updates", caller, ack: [...ack] });
    await state.gate;
    if (state.down) throw new GitMcpUnreachable("connect ECONNREFUSED");
    for (const entry of ack) if (tips.get(entry.repo) === entry.from && entry.to) tips.set(entry.repo, entry.to);
    const repos: RepoUpdates[] = [];
    const nextAck: AckEntry[] = [];
    for (const [repo, shas] of history) {
      const head = shas[shas.length - 1];
      const tip = tips.get(repo);
      if (tip === undefined && head !== undefined) {
        tips.set(repo, head);
        repos.push({ repo, status: "first_run", branches: 1 });
      } else if (tip === head) repos.push({ repo, status: "unchanged", branches: 1 });
      else {
        const commits = shas.slice(shas.indexOf(tip as string) + 1).map(fakeCommit);
        repos.push({
          repo,
          status: "changed",
          branches: 1,
          updates: [{ branch: "main", status: "updated", oldTip: tip as string, newTip: head as string, commits }],
        });
        nextAck.push({ repo, branch: "main", from: tip as string, to: head as string });
      }
    }
    return { repos, ack: nextAck, acknowledged: ack.length };
  }

  const client: GitMcpClient = {
    async verify() {
      requests.push({ kind: "verify", caller: "qm-verify", ack: [] });
      if (state.down) throw new GitMcpUnreachable("connect ECONNREFUSED");
      if (state.drift)
        throw new GitMcpContractError({ missing: [], forbidden: ["push_files"], unexpected: [], rawInputs: [] });
    },
    async call() {
      throw new Error("the fake service has no other tools");
    },
    checkUpdates,
  };

  return {
    client,
    state,
    requests,
    polls: () => requests.filter((r) => r.kind === "check_updates"),
    storedTip: (repo: string) => tips.get(repo),
    push(repo: string, ...shas: string[]) {
      history.set(repo, [...(history.get(repo) ?? []), ...shas]);
    },
  };
}

export function sharedLease() {
  const held = new Set<string>();
  const keys: string[] = [];
  return {
    keys,
    hold: async <T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> => {
      keys.push(key);
      if (held.has(key)) return null;
      held.add(key);
      try {
        return await fn(new Promise<void>(() => {}));
      } finally {
        held.delete(key);
      }
    },
  };
}
