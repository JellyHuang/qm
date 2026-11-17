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
}

const SHA_WINDOW = 200;

const keyOf = (email: string) => normaliseEmail(email) || "(none)";

function absorb(entry: UnmappedAuthor, sighting: UnmappedSighting, now: number): UnmappedAuthor {
  const seen = new Set(entry.recentShas);
  const fresh = sighting.commits.filter((c, i, all) => !seen.has(c.sha) && all.findIndex((o) => o.sha === c.sha) === i);
  return {
    ...entry,
    name: sighting.name || entry.name,
    reason: sighting.reason,
    candidates: [...(sighting.candidates ?? [])],
    status: entry.status === "resolved" ? "open" : entry.status,
    lastSeenAt: now,
    count: entry.count + fresh.length,
    recentShas: [...entry.recentShas, ...fresh.map((c) => c.sha)].slice(-SHA_WINDOW),
  };
}

export function createUnmappedQueue(opts: {
  map: DurableMap<UnmappedAuthor>;
  aliases: Pick<AuthorAliases, "add">;
  now?: () => number;
}): UnmappedQueue {
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
      if (await opts.map.insertIfAbsent(key, absorb(fresh, sighting, at))) return (await opts.map.get(key))!;
      return (await opts.map.update(key, (entry) => absorb(entry, sighting, now())))!;
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
  };
}
