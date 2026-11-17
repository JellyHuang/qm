import type { AuthorAliases, IgnoreReason } from "./author-aliases.ts";
import { emailDomain, isBotAuthor, nameKey, normaliseEmail, usableEmail, type BotRules } from "./names.ts";
import type { PeopleDirectory, Person } from "./people.ts";

export type MatchedBy = "name" | "mattermost_email";

export type AuthorClass =
  | ({ kind: "person"; matchedBy: MatchedBy; departed?: true } & Person)
  | { kind: "ignored"; reason: IgnoreReason; nameKey: string }
  | { kind: "unmapped"; email: string; name: string; reason: "no_match" | "invalid_email" }
  | { kind: "ambiguous"; email: string; name: string; candidates: Person[] }
  | { kind: "bot"; name: string }
  | { kind: "external"; domain: string };

export interface CommitAuthor {
  email: string;
  name?: string | undefined;
}

export interface AuthorRules extends BotRules {
  externalDomains: readonly string[];
}

export interface AuthorResolver {
  resolve(author: CommitAuthor): Promise<AuthorClass>;
}

const bare = (value: string) => value.trim().toLowerCase().replace(/^@/, "");

export function createAuthorResolver(options: {
  rules: AuthorRules;
  aliases: Pick<AuthorAliases, "get">;
  directory?: PeopleDirectory;
}): AuthorResolver {
  const external = options.rules.externalDomains.map(bare);
  return {
    async resolve(author) {
      const name = author.name ?? "";
      const email = normaliseEmail(author.email);
      if (nameKey(name)) {
        const row = await options.aliases.get(name);
        if (row && (row.emailCondition === undefined || row.emailCondition === email)) {
          if (row.kind === "ignored") return { kind: "ignored", reason: row.reason, nameKey: row.nameKey };
          return {
            kind: "person",
            matchedBy: "name",
            personId: row.personId,
            mattermostUser: row.mattermostUser,
            ...(row.departedAt === undefined ? {} : { departed: true as const }),
          };
        }
      }
      if (isBotAuthor({ name, email }, options.rules)) return { kind: "bot", name: name.trim() };
      const domain = emailDomain(email);
      if (domain !== undefined && external.some((d) => domain === d || domain.endsWith(`.${d}`)))
        return { kind: "external", domain };
      if (!usableEmail(email)) return { kind: "unmapped", email, name, reason: "invalid_email" };
      if (options.directory) {
        const people = [...new Map((await options.directory.findByEmail(email)).map((p) => [p.personId, p])).values()];
        if (people.length > 1) return { kind: "ambiguous", email, name, candidates: people };
        const [only] = people;
        if (only) return { kind: "person", matchedBy: "mattermost_email", ...only };
      }
      return { kind: "unmapped", email, name, reason: "no_match" };
    },
  };
}
