import type { DurableMap } from "../../persistence/durable-map.ts";
import { displayName, encodeNameId, isGenericName, nameKey, normaliseEmail } from "./names.ts";

export type UnmappedReason = "no_match" | "invalid_email" | "ambiguous";
type UnmappedStatus = "open" | "resolved" | "ignored";

const EMAILS_MAX = 10;

export interface UnmappedAuthor {
  nameKey: string;
  emails: string[];
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

interface UnmappedAuthorRef {
  name: string;
  email: string;
}

interface UnmappedSighting {
  name: string;
  emails: readonly string[];
  reason: UnmappedReason;
  candidates?: readonly string[];
  commits: ReadonlyArray<{ repo: string; sha: string }>;
}

export interface UnmappedQueue {
  record(sighting: UnmappedSighting): Promise<UnmappedAuthor>;
  list(status?: UnmappedStatus): Promise<UnmappedAuthor[]>;
  idOf(author: UnmappedAuthorRef): string;
  resolve(author: UnmappedAuthorRef, personId: string, by: string): Promise<UnmappedAuthor | null>;
  ignore(author: UnmappedAuthorRef, by: string): Promise<UnmappedAuthor | null>;
  prune(): Promise<number>;
}

const SHA_WINDOW = 200;
const DAY_MS = 86_400_000;
export const UNMAPPED_RETENTION_DAYS = 180;

export function unmappedCutoff(now: number, days = UNMAPPED_RETENTION_DAYS): number {
  if (!Number.isInteger(days) || days < 1) throw new Error("the retention is a whole number of days from 1");
  return now - days * DAY_MS;
}

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
  const emails = [...new Set([...entry.emails, ...sighting.emails.map(normaliseEmail)].filter(Boolean))].slice(
    0,
    EMAILS_MAX,
  );
  return {
    ...entry,
    emails,
    name: displayName(sighting.name) || entry.name,
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
  genericNames: readonly string[];
  retentionDays?: number;
  reopenIgnoredAfterDays?: number;
  now?: () => number;
}): UnmappedQueue {
  const reopenAfter = opts.reopenIgnoredAfterDays ?? 0;
  const now = opts.now ?? (() => Date.now());
  const idOf = ({ name, email }: UnmappedAuthorRef) => {
    const key = nameKey(name);
    const mail = normaliseEmail(email);
    if (!key) return mail ? `email:${mail}` : "(none)";
    return isGenericName(key, opts.genericNames) ? `${encodeNameId(key)}|${mail}` : encodeNameId(key);
  };
  const close = (author: UnmappedAuthorRef, status: "resolved" | "ignored", by: string, personId?: string) =>
    opts.map.update(idOf(author), (entry) => ({
      ...entry,
      status,
      closedBy: by,
      closedAt: now(),
      ...(personId ? { personId } : {}),
    }));
  return {
    idOf,
    async record(sighting) {
      const key = idOf({ name: sighting.name, email: sighting.emails[0] ?? "" });
      const first = sighting.commits[0];
      if (!first) throw new Error("a sighting needs at least one commit");
      const at = now();
      const fresh: UnmappedAuthor = {
        nameKey: nameKey(sighting.name),
        emails: [],
        name: displayName(sighting.name),
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
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.nameKey.localeCompare(b.nameKey));
    },
    resolve: (author, personId, by) => close(author, "resolved", by, personId),
    ignore: (author, by) => close(author, "ignored", by),
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
