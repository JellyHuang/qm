import { normaliseEmail } from "./names.ts";

export interface Person {
  personId: string;
  mattermostUser: string;
}

export interface PeopleDirectory {
  findByEmail(email: string): Promise<Person[]>;
}

export function createMattermostPeopleDirectory(
  mmUserIdsOfEmail: (email: string) => Promise<string[]>,
): PeopleDirectory {
  return {
    async findByEmail(email) {
      const ids = await mmUserIdsOfEmail(normaliseEmail(email));
      return [...new Set(ids)].map((id) => ({ personId: id, mattermostUser: id }));
    },
  };
}

export function createMemoryPeopleDirectory(
  people: ReadonlyArray<{ emails: readonly string[]; person: Person }>,
): PeopleDirectory {
  return {
    async findByEmail(email) {
      const wanted = normaliseEmail(email);
      return people.filter((p) => p.emails.some((e) => normaliseEmail(e) === wanted)).map((p) => p.person);
    },
  };
}
