export type CommitAuthor = { kind: "person"; mmUserId: string } | { kind: "unmatched" };

export interface AuthorResolver {
  resolve(email: string): Promise<CommitAuthor>;
}

const UNMATCHED: CommitAuthor = { kind: "unmatched" };

export function createAuthorResolver(deps: {
  mmUserIdsOfEmail: (email: string) => Promise<readonly string[]>;
}): AuthorResolver {
  return {
    async resolve(email) {
      const wanted = email.trim().toLowerCase();
      if (!wanted.includes("@")) return UNMATCHED;
      const ids = [...new Set(await deps.mmUserIdsOfEmail(wanted).catch(() => []))];
      const [mmUserId] = ids;
      return ids.length === 1 && mmUserId ? { kind: "person", mmUserId } : UNMATCHED;
    },
  };
}
