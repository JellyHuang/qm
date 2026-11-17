import type { AuditLog } from "../../audit/audit-log.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { ZqConfig } from "../config.ts";
import { createAuthorAliases, type AuthorAlias, type AuthorAliases, type IgnoreReason } from "./author-aliases.ts";
import { createAuthorResolver, type AuthorClass, type AuthorResolver } from "./authors.ts";
import { createIdentityService, type IdentityService } from "./identity.ts";
import { displayName, hashEmail, hashName, nameKey, normaliseEmail } from "./names.ts";
import type { CommitBatch } from "./poller.ts";
import type { PeopleDirectory, Person } from "./people.ts";
import { createUnmappedQueue, type UnmappedAuthor, type UnmappedQueue, type UnmappedReason } from "./unmapped-queue.ts";

interface MappedCommit {
  repo: string;
  branch: string;
  sha: string;
  date: string;
}

interface PersonCommits {
  person: Person;
  commits: MappedCommit[];
}

interface DepartedCommits extends PersonCommits {
  authorName: string;
}

export interface AuthorNotificationSink {
  deliver(notice: PersonCommits): Promise<void>;
  deliverToPm(notice: DepartedCommits): Promise<void>;
  deliverClaimAttempt(holder: Person): Promise<void>;
}

interface ClassifiedCommit extends MappedCommit {
  author: AuthorClass;
  authorName: string;
}

interface UnmappedItem {
  email: string;
  name: string;
  reason: UnmappedReason;
  commits: number;
}

interface IgnoredItem {
  nameHash: string;
  reason: IgnoreReason;
  commits: number;
}

interface MappingResult {
  commits: ClassifiedCommit[];
  byPerson: PersonCommits[];
  departed: DepartedCommits[];
  unmapped: UnmappedItem[];
  ignored: IgnoredItem[];
}

export interface RecordingSink extends AuthorNotificationSink {
  sent: PersonCommits[];
  sentToPm: DepartedCommits[];
  claimAttempts: Person[];
}

export function createRecordingSink(): RecordingSink {
  const sent: PersonCommits[] = [];
  const sentToPm: DepartedCommits[] = [];
  const claimAttempts: Person[] = [];
  return {
    sent,
    sentToPm,
    claimAttempts,
    async deliver(notice) {
      sent.push(notice);
    },
    async deliverToPm(notice) {
      sentToPm.push(notice);
    },
    async deliverClaimAttempt(holder) {
      claimAttempts.push(holder);
    },
  };
}

interface AuthorMapper {
  map(batches: readonly CommitBatch[]): Promise<MappingResult>;
  handle(batches: CommitBatch[]): Promise<void>;
}

function groupPeople<T extends PersonCommits>(
  commits: readonly ClassifiedCommit[],
  wanted: (author: AuthorClass) => author is Extract<AuthorClass, { kind: "person" }>,
  make: (person: Person, authorName: string) => T,
): T[] {
  const groups = new Map<string, T>();
  for (const { author, authorName, repo, branch, sha, date } of commits) {
    if (!wanted(author)) continue;
    const group =
      groups.get(author.personId) ??
      make({ personId: author.personId, mattermostUser: author.mattermostUser }, authorName);
    group.commits.push({ repo, branch, sha, date });
    groups.set(author.personId, group);
  }
  return [...groups.values()];
}

function createAuthorMapper(deps: {
  resolver: AuthorResolver;
  queue: Pick<UnmappedQueue, "record" | "idOf">;
  sink: AuthorNotificationSink;
  log?: (line: string) => void;
}): AuthorMapper {
  async function map(batches: readonly CommitBatch[]): Promise<MappingResult> {
    const resolved = new Map<string, AuthorClass>();
    const classified: ClassifiedCommit[] = [];
    const unmappedCommits = new Map<
      string,
      { author: AuthorClass; name: string; emails: Set<string>; commits: ClassifiedCommit[] }
    >();
    for (const batch of batches)
      for (const commit of batch.commits) {
        const cacheKey = `${nameKey(commit.authorName)}\n${normaliseEmail(commit.authorEmail)}`;
        let author = resolved.get(cacheKey);
        if (!author) {
          author = await deps.resolver.resolve({ email: commit.authorEmail, name: commit.authorName });
          resolved.set(cacheKey, author);
        }
        const entry: ClassifiedCommit = {
          repo: batch.repo,
          branch: commit.branch || batch.branch,
          sha: commit.sha,
          date: commit.date,
          author,
          authorName: displayName(commit.authorName),
        };
        classified.push(entry);
        if (author.kind === "unmapped" || author.kind === "ambiguous") {
          const key = deps.queue.idOf({ name: commit.authorName, email: commit.authorEmail });
          const group = unmappedCommits.get(key) ?? {
            author,
            name: commit.authorName,
            emails: new Set<string>(),
            commits: [],
          };
          group.emails.add(commit.authorEmail);
          group.commits.push(entry);
          unmappedCommits.set(key, group);
        }
      }

    const unmapped: UnmappedItem[] = [];
    for (const { author, name, emails, commits } of unmappedCommits.values()) {
      if (author.kind !== "unmapped" && author.kind !== "ambiguous") continue;
      const item: UnmappedItem = {
        email: author.email,
        name,
        reason: author.kind === "ambiguous" ? "ambiguous" : author.reason,
        commits: commits.length,
      };
      await deps.queue.record({
        name,
        emails: [...emails],
        reason: item.reason,
        ...(author.kind === "ambiguous" ? { candidates: author.candidates.map((p) => p.personId) } : {}),
        commits: commits.map(({ repo, sha }) => ({ repo, sha })),
      });
      deps.log?.(
        `zq git author needs review: ${hashName(name)} ${hashEmail(item.email)} ${item.reason} commits=${item.commits}`,
      );
      unmapped.push(item);
    }

    const ignoredCounts = new Map<string, IgnoredItem>();
    for (const { author } of classified) {
      if (author.kind !== "ignored") continue;
      const item = ignoredCounts.get(author.nameKey) ?? {
        nameHash: hashName(author.nameKey),
        reason: author.reason,
        commits: 0,
      };
      item.commits++;
      ignoredCounts.set(author.nameKey, item);
    }
    const ignored = [...ignoredCounts.values()];
    for (const item of ignored)
      deps.log?.(`zq git author ignored: ${item.nameHash} reason=${item.reason} commits=${item.commits}`);

    const isPerson = (author: AuthorClass): author is Extract<AuthorClass, { kind: "person" }> =>
      author.kind === "person" && !author.departed;
    const isDeparted = (author: AuthorClass): author is Extract<AuthorClass, { kind: "person" }> =>
      author.kind === "person" && author.departed === true;
    const byPerson = groupPeople(classified, isPerson, (person) => ({ person, commits: [] }));
    const departed = groupPeople(classified, isDeparted, (person, authorName) => ({
      person,
      authorName,
      commits: [],
    }));
    for (const notice of byPerson) await deps.sink.deliver(notice);
    for (const notice of departed) await deps.sink.deliverToPm(notice);
    return { commits: classified, byPerson, departed, unmapped, ignored };
  }

  return {
    map,
    async handle(batches) {
      await map(batches);
    },
  };
}

export interface AuthorMapping {
  mapper: AuthorMapper;
  queue: UnmappedQueue;
  aliases: AuthorAliases;
  sink: AuthorNotificationSink;
  identity?: IdentityService;
}

export function createAuthorMapping(deps: {
  config: ZqConfig["gitAuthors"];
  directory?: PeopleDirectory;
  map: <T>(table: string) => DurableMap<T>;
  sink?: AuthorNotificationSink;
  audit?: AuditLog;
  mattermostUserOf?: (personId: string) => Promise<string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
}): AuthorMapping | undefined {
  if (!deps.config.mapping) return undefined;
  const aliases = createAuthorAliases({
    map: deps.map<AuthorAlias>("zq_git_author_aliases"),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const queue = createUnmappedQueue({
    map: deps.map<UnmappedAuthor>("zq_git_unmapped_authors"),
    genericNames: deps.config.genericNames,
    retentionDays: deps.config.queueRetentionDays,
    reopenIgnoredAfterDays: deps.config.ignoredReopenDays,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const resolver = createAuthorResolver({
    rules: deps.config,
    aliases,
    ...(deps.config.mattermostEmailFallback && deps.directory ? { directory: deps.directory } : {}),
  });
  const sink = deps.sink ?? createRecordingSink();
  return {
    mapper: createAuthorMapper({ resolver, queue, sink, ...(deps.log ? { log: deps.log } : {}) }),
    queue,
    aliases,
    sink,
    ...(deps.config.bind
      ? {
          identity: createIdentityService({
            aliases,
            queue,
            config: deps.config,
            sink,
            ...(deps.audit ? { audit: deps.audit } : {}),
            ...(deps.mattermostUserOf ? { mattermostUserOf: deps.mattermostUserOf } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          }),
        }
      : {}),
  };
}
