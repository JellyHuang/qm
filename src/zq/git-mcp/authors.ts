export type AuthorClass =
  | { kind: "person"; mmUserId: string }
  | { kind: "unmapped" }
  | { kind: "bot"; name: string }
  | { kind: "external"; domain: string };

interface CommitAuthor {
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

const UNMAPPED: AuthorClass = { kind: "unmapped" };

const normal = (value: string) => value.trim().toLowerCase().replace(/^@/, "");

export function classifyAuthor(author: CommitAuthor, rules: AuthorRules): AuthorClass | undefined {
  const email = author.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  const bots = new Set(rules.botNames.map(normal));
  const local = at < 0 ? email : email.slice(0, at);
  if (bots.has(normal(author.name ?? "")) || bots.has(local))
    return { kind: "bot", name: author.name?.trim() || local };
  if (at < 0) return UNMAPPED;
  const domain = email.slice(at + 1);
  const external = rules.externalDomains.map(normal).find((d) => domain === d || domain.endsWith(`.${d}`));
  return external ? { kind: "external", domain } : undefined;
}

export function createAuthorResolver(options: {
  rules: AuthorRules;
  map?: (email: string) => Promise<AuthorClass>;
}): AuthorResolver {
  return {
    async resolve(author) {
      const classified = classifyAuthor(author, options.rules);
      if (classified) return classified;
      return (await options.map?.(author.email.trim().toLowerCase())) ?? UNMAPPED;
    },
  };
}

export const unmappedAuthors: AuthorResolver = { resolve: async () => UNMAPPED };
