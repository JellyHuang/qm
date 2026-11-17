import type { DurableMap } from "../../persistence/durable-map.ts";
import type { AuthorAliases } from "./author-aliases.ts";
import { normaliseEmail, type Person } from "./people.ts";

export type UnmappedReason = "no_match" | "invalid_email" | "ambiguous";
type UnmappedStatus = "open" | "resolved" | "ignored";

export interface UnmappedAuthor {
  email: string;
  name: string;
  reason: UnmappedReason;
  candidates: string[];
  status: UnmappedStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  exampleRepo: string;
  exampleSha: string;
  recentShas: string[];
  closedBy?: string;
  closedAt?: number;
  personId?: string;
}

interface UnmappedSighting {
  email: string;
  name: string;
  reason: UnmappedReason;
  candidates?: readonly string[];
  commits: ReadonlyArray<{ repo: string; sha: string }>;
}

export interface UnmappedQueue {
  record(sighting: UnmappedSighting): Promise<UnmappedAuthor>;
  list(status?: UnmappedStatus): Promise<UnmappedAuthor[]>;
  resolve(email: string, person: Person, by: string): Promise<UnmappedAuthor | null>;
  ignore(email: string, by: string): Promise<UnmappedAuthor | null>;
  prune(): Promise<number>;
}

const SHA_WINDOW = 200;
const DAY_MS = 86_400_000;
export const UNMAPPED_RETENTION_DAYS = 180;

export function unmappedCutoff(now: number, days = UNMAPPED_RETENTION_DAYS): number {
  if (!Number.isInteger(days) || days < 1) throw new Error("the retention is a whole number of days from 1");
  return now - days * DAY_MS;
}

const keyOf = (email: string) => normaliseEmail(email) || "(none)";

function absorb(
  entry: UnmappedAuthor,
  sighting: UnmappedSighting,
  now: number,
  reopenIgnoredAfterDays: number,
): UnmappedAuthor {
  const reopen =
    entry.status === "resolved" ||
    (entry.status === "ignored" &&
      reopenIgnoredAfterDays > 0 &&
      now - (entry.closedAt ?? entry.lastSeenAt) >= reopenIgnoredAfterDays * DAY_MS);
  const seen = new Set(entry.recentShas);
  const fresh = sighting.commits.filter((c, i, all) => !seen.has(c.sha) && all.findIndex((o) => o.sha === c.sha) === i);
  return {
    ...entry,
    name: sighting.name || entry.name,
    reason: sighting.reason,
    candidates: [...(sighting.candidates ?? [])],
    status: reopen ? "open" : entry.status,
    lastSeenAt: now,
    count: entry.count + fresh.length,
    recentShas: [...entry.recentShas, ...fresh.map((c) => c.sha)].slice(-SHA_WINDOW),
  };
}

export function createUnmappedQueue(opts: {
  map: DurableMap<UnmappedAuthor>;
  aliases: Pick<AuthorAliases, "add">;
  retentionDays?: number;
  reopenIgnoredAfterDays?: number;
  now?: () => number;
}): UnmappedQueue {
  const reopenAfter = opts.reopenIgnoredAfterDays ?? 0;
  const now = opts.now ?? (() => Date.now());
  const close = (email: string, status: "resolved" | "ignored", by: string, personId?: string) =>
    opts.map.update(keyOf(email), (entry) => ({
      ...entry,
      status,
      closedBy: by,
      closedAt: now(),
      ...(personId ? { personId } : {}),
    }));
  return {
    async record(sighting) {
      const key = keyOf(sighting.email);
      const first = sighting.commits[0];
      if (!first) throw new Error("a sighting needs at least one commit");
      const at = now();
      const fresh: UnmappedAuthor = {
        email: normaliseEmail(sighting.email),
        name: sighting.name,
        reason: sighting.reason,
        candidates: [...(sighting.candidates ?? [])],
        status: "open",
        firstSeenAt: at,
        lastSeenAt: at,
        count: 0,
        exampleRepo: first.repo,
        exampleSha: first.sha,
        recentShas: [],
      };
      if (await opts.map.insertIfAbsent(key, absorb(fresh, sighting, at, reopenAfter)))
        return (await opts.map.get(key))!;
      return (await opts.map.update(key, (entry) => absorb(entry, sighting, now(), reopenAfter)))!;
    },
    async list(status = "open") {
      return (await opts.map.all())
        .filter((entry) => entry.status === status)
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.email.localeCompare(b.email));
    },
    async resolve(email, person, by) {
      if (!(await opts.map.get(keyOf(email)))) return null;
      await opts.aliases.add(email, person, by);
      return close(email, "resolved", by, person.personId);
    },
    ignore: (email, by) => close(email, "ignored", by),
    async prune() {
      const cutoff = unmappedCutoff(now(), opts.retentionDays);
      const stale = (entry: UnmappedAuthor) =>
        entry.status !== "open" && Math.max(entry.closedAt ?? 0, entry.lastSeenAt) < cutoff;
      let removed = 0;
      for (const [key, entry] of await opts.map.entries())
        if (stale(entry) && (await opts.map.deleteIf(key, stale))) removed++;
      return removed;
    },
  };
}
