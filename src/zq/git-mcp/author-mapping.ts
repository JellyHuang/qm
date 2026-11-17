import { createHash } from "node:crypto";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { ZqConfig } from "../config.ts";
import { createAuthorAliases, type AuthorAlias, type AuthorAliases } from "./author-aliases.ts";
import { createAuthorResolver, type AuthorClass, type AuthorResolver } from "./authors.ts";
import type { CommitBatch } from "./poller.ts";
import { normaliseEmail, type PeopleDirectory, type Person } from "./people.ts";
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

export interface AuthorNotificationSink {
  deliver(notice: PersonCommits): Promise<void>;
}

interface ClassifiedCommit extends MappedCommit {
  author: AuthorClass;
}

interface UnmappedItem {
  email: string;
  name: string;
  reason: UnmappedReason;
  commits: number;
}

interface MappingResult {
  commits: ClassifiedCommit[];
  byPerson: PersonCommits[];
  unmapped: UnmappedItem[];
}

export interface RecordingSink extends AuthorNotificationSink {
  sent: PersonCommits[];
}

export function createRecordingSink(): RecordingSink {
  const sent: PersonCommits[] = [];
  return {
    sent,
    async deliver(notice) {
      sent.push(notice);
    },
  };
}

export const hashEmail = (email: string) =>
  createHash("sha256").update(normaliseEmail(email)).digest("hex").slice(0, 12);

interface AuthorMapper {
  map(batches: readonly CommitBatch[]): Promise<MappingResult>;
  handle(batches: CommitBatch[]): Promise<void>;
}

export function createAuthorMapper(deps: {
  resolver: AuthorResolver;
  queue: Pick<UnmappedQueue, "record">;
  sink: AuthorNotificationSink;
  log?: (line: string) => void;
}): AuthorMapper {
  async function map(batches: readonly CommitBatch[]): Promise<MappingResult> {
    const resolved = new Map<string, AuthorClass>();
    const classified: ClassifiedCommit[] = [];
    const unmappedCommits = new Map<string, { author: AuthorClass; name: string; commits: ClassifiedCommit[] }>();
    for (const batch of batches)
      for (const commit of batch.commits) {
        const key = normaliseEmail(commit.authorEmail);
        let author = resolved.get(key);
        if (!author) {
          author = await deps.resolver.resolve({ email: commit.authorEmail, name: commit.authorName });
          resolved.set(key, author);
        }
        const entry: ClassifiedCommit = {
          repo: batch.repo,
          branch: commit.branch || batch.branch,
          sha: commit.sha,
          date: commit.date,
          author,
        };
        classified.push(entry);
        if (author.kind === "unmapped" || author.kind === "ambiguous") {
          const group = unmappedCommits.get(key) ?? { author, name: commit.authorName.trim(), commits: [] };
          group.commits.push(entry);
          unmappedCommits.set(key, group);
        }
      }

    const unmapped: UnmappedItem[] = [];
    for (const { author, name, commits } of unmappedCommits.values()) {
      if (author.kind !== "unmapped" && author.kind !== "ambiguous") continue;
      const item: UnmappedItem = {
        email: author.email,
        name,
        reason: author.kind === "ambiguous" ? "ambiguous" : author.reason,
        commits: commits.length,
      };
      await deps.queue.record({
        ...item,
        ...(author.kind === "ambiguous" ? { candidates: author.candidates.map((p) => p.personId) } : {}),
        commits: commits.map(({ repo, sha }) => ({ repo, sha })),
      });
      deps.log?.(`zq git author needs review: ${hashEmail(item.email)} ${item.reason} commits=${item.commits}`);
      unmapped.push(item);
    }

    const people = new Map<string, PersonCommits>();
    for (const { author, repo, branch, sha, date } of classified) {
      if (author.kind !== "person") continue;
      const group = people.get(author.personId) ?? {
        person: { personId: author.personId, mattermostUser: author.mattermostUser },
        commits: [],
      };
      group.commits.push({ repo, branch, sha, date });
      people.set(author.personId, group);
    }
    const byPerson = [...people.values()];
    for (const notice of byPerson) await deps.sink.deliver(notice);
    return { commits: classified, byPerson, unmapped };
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
}

export function createAuthorMapping(deps: {
  config: ZqConfig["gitAuthors"];
  directory: PeopleDirectory;
  map: <T>(table: string) => DurableMap<T>;
  sink?: AuthorNotificationSink;
  now?: () => number;
  log?: (line: string) => void;
}): AuthorMapping {
  const aliases = createAuthorAliases({
    map: deps.map<AuthorAlias>("zq_git_author_aliases"),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const queue = createUnmappedQueue({
    map: deps.map<UnmappedAuthor>("zq_git_unmapped_authors"),
    aliases,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const resolver = createAuthorResolver({
    rules: deps.config,
    directory: deps.directory,
    aliases,
    domainAliases: deps.config.domainAliases,
  });
  const sink = deps.sink ?? createRecordingSink();
  return {
    mapper: createAuthorMapper({ resolver, queue, sink, ...(deps.log ? { log: deps.log } : {}) }),
    queue,
    aliases,
    sink,
  };
}
