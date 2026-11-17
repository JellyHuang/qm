import type { AuthorAliases } from "./author-aliases.ts";
import { normaliseEmail, type PeopleDirectory, type Person } from "./people.ts";

export type MatchedBy = "email" | "alias" | "domain_alias";

export type AuthorClass =
  | ({ kind: "person"; matchedBy: MatchedBy } & Person)
  | { kind: "unmapped"; email: string; name: string; reason: "no_match" | "invalid_email" }
  | { kind: "ambiguous"; email: string; candidates: Person[] }
  | { kind: "bot"; name: string }
  | { kind: "external"; domain: string };

export interface CommitAuthor {
  email: string;
  name?: string | undefined;
}

export interface AuthorRules {
  externalDomains: readonly string[];
  botNames: readonly string[];
}

export interface AuthorResolver {
  resolve(author: CommitAuthor): Promise<AuthorClass>;
}

const normal = (value: string) => value.trim().toLowerCase().replace(/^@/, "");

export function classifyAuthor(author: CommitAuthor, rules: AuthorRules): AuthorClass | undefined {
  const email = normaliseEmail(author.email);
  const name = author.name?.trim() ?? "";
  const at = email.lastIndexOf("@");
  const bots = new Set(rules.botNames.map(normal));
  const local = at < 0 ? email : email.slice(0, at);
  if (bots.has(normal(name)) || bots.has(local)) return { kind: "bot", name: name || local };
  if (at < 0) return { kind: "unmapped", email, name, reason: "invalid_email" };
  const domain = email.slice(at + 1);
  const external = rules.externalDomains.map(normal).find((d) => domain === d || domain.endsWith(`.${d}`));
  return external ? { kind: "external", domain } : undefined;
}

function pick(
  email: string,
  hits: readonly Person[],
  matchedBy: MatchedBy,
): Extract<AuthorClass, { kind: "person" | "ambiguous" }> | undefined {
  const unique = [...new Map(hits.map((p) => [p.personId, p])).values()];
  if (unique.length === 0) return undefined;
  if (unique.length > 1) return { kind: "ambiguous", email, candidates: unique };
  const [only] = unique;
  return { kind: "person", personId: only!.personId, mattermostUser: only!.mattermostUser, matchedBy };
}

export function createAuthorResolver(options: {
  rules: AuthorRules;
  directory: PeopleDirectory;
  aliases: Pick<AuthorAliases, "find">;
  domainAliases?: Readonly<Record<string, string>>;
}): AuthorResolver {
  const domainAliases = new Map(
    Object.entries(options.domainAliases ?? {}).map(([from, to]) => [normal(from), normal(to)]),
  );
  return {
    async resolve(author) {
      const classified = classifyAuthor(author, options.rules);
      if (classified) return classified;
      const email = normaliseEmail(author.email);
      const direct = pick(email, await options.directory.findByEmail(email), "email");
      if (direct) return direct;
      const aliased = pick(email, await options.aliases.find(email), "alias");
      if (aliased) return aliased;
      const at = email.lastIndexOf("@");
      const canonical = domainAliases.get(email.slice(at + 1));
      if (canonical) {
        const moved = `${email.slice(0, at)}@${canonical}`;
        const viaDomain = pick(email, await options.directory.findByEmail(moved), "domain_alias");
        if (viaDomain) return viaDomain;
      }
      return { kind: "unmapped", email, name: author.name?.trim() ?? "", reason: "no_match" };
    },
  };
}
