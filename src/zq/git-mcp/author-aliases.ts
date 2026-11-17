import type { DurableMap } from "../../persistence/durable-map.ts";
import { normaliseEmail, type Person } from "./people.ts";

export interface AuthorAlias extends Person {
  email: string;
  addedBy: string;
  addedAt: number;
}

export interface AuthorAliases {
  find(email: string): Promise<Person[]>;
  add(email: string, person: Person, addedBy: string): Promise<AuthorAlias>;
  remove(email: string, personId: string): Promise<void>;
  list(): Promise<AuthorAlias[]>;
}

const keyOf = (email: string, personId: string) => `${email}|${personId}`;

export function createAuthorAliases(opts: { map: DurableMap<AuthorAlias>; now?: () => number }): AuthorAliases {
  const now = opts.now ?? (() => Date.now());
  const list = async () =>
    (await opts.map.all()).sort((a, b) => keyOf(a.email, a.personId).localeCompare(keyOf(b.email, b.personId)));
  return {
    async find(email) {
      const wanted = normaliseEmail(email);
      return (await list())
        .filter((alias) => alias.email === wanted)
        .map(({ personId, mattermostUser }) => ({ personId, mattermostUser }));
    },
    async add(email, person, addedBy) {
      const normal = normaliseEmail(email);
      if (!normal.includes("@")) throw new Error("an alias must be an email address");
      const alias: AuthorAlias = {
        personId: person.personId,
        mattermostUser: person.mattermostUser,
        email: normal,
        addedBy,
        addedAt: now(),
      };
      return opts.map.putIfAbsent(keyOf(normal, person.personId), alias);
    },
    async remove(email, personId) {
      await opts.map.delete(keyOf(normaliseEmail(email), personId));
    },
    list,
  };
}
