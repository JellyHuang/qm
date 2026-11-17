import type { DurableMap } from "../../persistence/durable-map.ts";
import { displayName, encodeNameId, nameKey } from "./names.ts";
import type { Person } from "./people.ts";

export type IgnoreReason = "automation" | "external";
export const IGNORE_REASONS: readonly IgnoreReason[] = ["automation", "external"];

interface AliasBase {
  nameKey: string;
  name: string;
  emailCondition?: string;
  addedBy: string;
  addedAt: number;
}

interface PersonAlias extends AliasBase, Person {
  kind: "person";
  departedAt?: number;
}

interface IgnoredAlias extends AliasBase {
  kind: "ignored";
  reason: IgnoreReason;
}

export type AuthorAlias = PersonAlias | IgnoredAlias;

export interface AuthorAliases {
  get(name: string): Promise<AuthorAlias | null>;
  insert(row: Omit<PersonAlias, "nameKey" | "addedAt"> | Omit<IgnoredAlias, "nameKey" | "addedAt">): Promise<boolean>;
  remove(name: string): Promise<AuthorAlias | null>;
  list(): Promise<AuthorAlias[]>;
  ofPerson(personId: string): Promise<PersonAlias[]>;
  setDeparted(personId: string, departed: boolean): Promise<number>;
}

export function createAuthorAliases(opts: { map: DurableMap<AuthorAlias>; now?: () => number }): AuthorAliases {
  const now = opts.now ?? (() => Date.now());
  const idOf = (name: string) => encodeNameId(nameKey(name));
  const list = async () => (await opts.map.all()).sort((a, b) => a.nameKey.localeCompare(b.nameKey));
  const ofPerson = async (personId: string) =>
    (await list()).filter((row): row is PersonAlias => row.kind === "person" && row.personId === personId);
  return {
    get: (name) => opts.map.get(idOf(name)),
    async insert(row) {
      const key = nameKey(row.name);
      return opts.map.insertIfAbsent(encodeNameId(key), {
        ...row,
        name: displayName(row.name),
        nameKey: key,
        addedAt: now(),
      });
    },
    async remove(name) {
      const row = await opts.map.get(idOf(name));
      if (!row) return null;
      return (await opts.map.deleteIf(idOf(name), (current) => current.addedAt === row.addedAt)) ? row : null;
    },
    list,
    ofPerson,
    async setDeparted(personId, departed) {
      const rows = await ofPerson(personId);
      for (const row of rows)
        await opts.map.update(encodeNameId(row.nameKey), (current) => {
          if (current.kind !== "person") return current;
          const next: PersonAlias = { ...current };
          if (departed) next.departedAt = now();
          else delete next.departedAt;
          return next;
        });
      return rows.length;
    },
  };
}
