import { createHash } from "node:crypto";
import type { AuditLog } from "../../audit/audit-log.ts";
import { attestableActor, canonicalPerson, samePerson } from "../../directory/person.ts";
import type { ScopeId } from "../../types.ts";
import type { ZqConfig } from "../config.ts";
import { IGNORE_REASONS, type AuthorAlias, type AuthorAliases, type IgnoreReason } from "./author-aliases.ts";
import type { AuthorNotificationSink } from "./author-mapping.ts";
import { displayName, emailCondition, hashName, isBotAuthor, isGenericName, nameKey, NAME_MAX } from "./names.ts";
import type { Person } from "./people.ts";
import type { UnmappedQueue } from "./unmapped-queue.ts";

export const GIT_NAME_HINT =
  "Your git author name is whatever your commits carry. On your computer run `git config user.name` (and `git config user.email`) inside a repository to see it; it can differ per computer, so bind each name you see, including forms like `DOMAIN\\name`.";

const SELF_OPERATIONS = ["bind", "list", "unbind"] as const;
const ADMIN_OPERATIONS = [
  "bind_for",
  "unbind_for",
  "depart",
  "undepart",
  "ignore_add",
  "ignore_list",
  "ignore_remove",
  "ignore_import",
  "list_unmapped",
] as const;
export const IDENTITY_OPERATIONS = [...SELF_OPERATIONS, ...ADMIN_OPERATIONS] as const;
type Operation = (typeof IDENTITY_OPERATIONS)[number];

export const MAX_NAMES_PER_CALL = 5;

interface IdentityEntry {
  name: string;
  email?: string | undefined;
  reason: string;
}

export interface IdentityArgs {
  operation: Operation;
  names?: readonly string[] | undefined;
  name?: string | undefined;
  email?: string | undefined;
  person?: string | undefined;
  reason?: string | undefined;
  status?: "open" | "resolved" | "ignored" | undefined;
  entries?: readonly IdentityEntry[] | undefined;
  apply?: boolean | undefined;
}

export interface IdentityCaller {
  principalId: string;
  human: boolean;
  orgAdmin: boolean;
  privateAudience: boolean;
  scope: ScopeId;
}

export interface IdentityService {
  call(args: IdentityArgs, caller: IdentityCaller): Promise<string>;
}

type Outcome = { ok: true; line: string } | { ok: false; line: string };

export function createIdentityService(deps: {
  aliases: AuthorAliases;
  queue: Pick<UnmappedQueue, "resolve" | "list">;
  config: Pick<
    ZqConfig["gitAuthors"],
    "botNames" | "botTokens" | "genericNames" | "identityAdmins" | "bindMaxPerPerson"
  >;
  sink: Pick<AuthorNotificationSink, "deliverClaimAttempt">;
  audit?: AuditLog;
  mattermostUserOf?: (personId: string) => Promise<string | undefined>;
  now?: () => number;
}): IdentityService {
  const now = deps.now ?? (() => Date.now());
  const { aliases, config } = deps;

  const personOf = async (raw: string): Promise<Person> => {
    const personId = canonicalPerson(raw.trim());
    if (!attestableActor(personId)) throw new Error("the person must be a principal id of 1 to 256 visible characters");
    return { personId, mattermostUser: (await deps.mattermostUserOf?.(personId)) ?? personId };
  };

  const record = (caller: IdentityCaller, action: string, resource: string, status: string, detail?: string) =>
    deps.audit?.record({
      at: now(),
      principalId: caller.principalId,
      action: `zq_git.identity.${action}`,
      resource,
      scopeLabel: caller.scope,
      status,
      ...(detail ? { detail } : {}),
    });

  const holderOf = (row: AuthorAlias) =>
    row.kind === "ignored" ? `on the ignore list (${row.reason})` : `bound to ${row.personId}`;

  async function bindOne(
    caller: IdentityCaller,
    rawName: string,
    condition: string | undefined,
    target: Person,
    admin: boolean,
  ): Promise<Outcome> {
    const name = displayName(rawName);
    const hash = hashName(name);
    const action = admin ? "bind_for" : "bind";
    const resource = `${hash} -> ${target.personId}`;
    const refuse = (reason: string, line: string, detail = `reason=${reason}`): Outcome => {
      record(caller, action, resource, "refused", detail);
      return { ok: false, line: `${rawName}: ${line}` };
    };
    if (!name || nameKey(name).length > NAME_MAX)
      return refuse("invalid_name", `a name needs 1 to ${NAME_MAX} characters`);
    if (!admin && isBotAuthor({ name, email: "" }, config))
      return refuse(
        "bot_name",
        "this name looks like an automation account and cannot be bound by a person; ask the PM",
      );
    if (isGenericName(name, config.genericNames) && !condition)
      return refuse("generic_name", "this is a generic name; it can only be bound together with an email condition");
    const own = await aliases.ofPerson(target.personId);
    if (!admin && own.some((row) => row.departedAt !== undefined))
      return refuse("departed", "you are marked as departed, so names cannot be bound for you");
    const existing = await aliases.get(name);
    const held = async (row: AuthorAlias | null): Promise<Outcome> => {
      if (row?.kind === "person" && samePerson(row.personId, target.personId)) {
        return { ok: true, line: `${rawName}: already bound` };
      }
      const notify = !admin && row?.kind === "person";
      if (notify) await deps.sink.deliverClaimAttempt({ personId: row.personId, mattermostUser: row.mattermostUser });
      const detail = `reason=held holder_notified=${notify ? "yes" : "no"}`;
      record(caller, action, resource, "refused", detail);
      return {
        ok: false,
        line: admin
          ? `${rawName}: ${row ? holderOf(row) : "already held"}; unbind it first`
          : `${rawName}: this git name is already bound (or ignored) in QM. If it is not yours, change your git name, for example to \`${name}01\` (\`git config user.name\`), and bind that; if you think it is yours, ask the PM, who can review it.`,
      };
    };
    if (existing) return held(existing);
    if (!admin && own.length >= config.bindMaxPerPerson)
      return refuse("cap", `you already have ${config.bindMaxPerPerson} names bound; unbind one first`);
    const departedAt = own.find((row) => row.departedAt !== undefined)?.departedAt;
    const inserted = await aliases.insert({
      kind: "person",
      name,
      ...(condition ? { emailCondition: condition } : {}),
      personId: target.personId,
      mattermostUser: target.mattermostUser,
      ...(departedAt === undefined ? {} : { departedAt }),
      addedBy: caller.principalId,
    });
    if (!inserted) return held(await aliases.get(name));
    await deps.queue.resolve({ name, email: condition ?? "" }, target.personId, caller.principalId);
    record(caller, action, resource, "ok", admin && isBotAuthor({ name, email: "" }, config) ? "bot_name" : undefined);
    return { ok: true, line: `${name}: bound` };
  }

  async function conditionOf(raw: string | undefined): Promise<string | undefined> {
    if (raw === undefined || raw.trim() === "") return undefined;
    const condition = emailCondition(raw);
    if (!condition) throw new Error("the email condition must be 1 to 254 characters without spaces");
    return condition;
  }

  async function bind(caller: IdentityCaller, args: IdentityArgs, target: Person, admin: boolean) {
    const names = args.names ?? [];
    if (names.length < 1 || names.length > MAX_NAMES_PER_CALL) throw new Error(`give 1 to ${MAX_NAMES_PER_CALL} names`);
    const condition = await conditionOf(args.email);
    const lines: string[] = [];
    for (const name of names) lines.push((await bindOne(caller, name, condition, target, admin)).line);
    return `${lines.join("\n")}${admin ? "" : `\n${GIT_NAME_HINT}`}`;
  }

  async function ignoreOne(
    caller: IdentityCaller,
    raw: IdentityEntry,
    seen: Set<string>,
    apply: boolean,
  ): Promise<{
    outcome: "would add" | "added" | "unchanged" | "refused";
    line: string;
    reason?: IgnoreReason;
    why?: string;
  }> {
    const name = displayName(raw.name);
    const key = nameKey(name);
    const fail = (why: string) => ({ outcome: "refused" as const, line: `${raw.name}: refused: ${why}`, why });
    if (!key || key.length > NAME_MAX) return fail("invalid name");
    if (!IGNORE_REASONS.includes(raw.reason as IgnoreReason)) return fail("reason must be automation or external");
    const reason = raw.reason as IgnoreReason;
    const condition = raw.email ? emailCondition(raw.email) : undefined;
    if (raw.email && !condition) return fail("invalid email condition");
    if (isGenericName(name, config.genericNames) && !condition) return fail("generic name needs an email condition");
    if (seen.has(key)) return fail("duplicate within the entries");
    seen.add(key);
    const existing = await aliases.get(name);
    if (existing?.kind === "person") return fail(`bound to ${existing.personId}, unbind first`);
    if (existing)
      return existing.reason === reason && existing.emailCondition === condition
        ? { outcome: "unchanged", line: `${name}: unchanged`, reason }
        : fail("exists with another reason or condition");
    if (!apply) return { outcome: "would add", line: `${name}: would add (${reason})`, reason };
    const inserted = await aliases.insert({
      kind: "ignored",
      name,
      reason,
      ...(condition ? { emailCondition: condition } : {}),
      addedBy: caller.principalId,
    });
    if (!inserted) return fail("exists");
    await deps.queue.resolve({ name, email: condition ?? "" }, "", caller.principalId);
    record(caller, "ignore_add", hashName(name), "ok", `reason=${reason}`);
    return { outcome: "added", line: `${name}: added (${reason})`, reason };
  }

  async function ignoreImport(caller: IdentityCaller, args: IdentityArgs) {
    const entries = args.entries ?? [];
    if (entries.length === 0) throw new Error("give at least one entry");
    const apply = args.apply === true;
    const seen = new Set<string>();
    const results: Array<Awaited<ReturnType<typeof ignoreOne>>> = [];
    for (const entry of entries) results.push(await ignoreOne(caller, entry, seen, apply));
    const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
    const perReason = (reason: IgnoreReason) => results.filter((r) => r.reason === reason).length;
    const summary = `add=${count(apply ? "added" : "would add")} unchanged=${count("unchanged")} refused=${count("refused")} automation=${perReason("automation")} external=${perReason("external")}`;
    const payload = createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
    record(caller, "ignore_import", "import", apply ? "ok" : "dry_run", `${summary} sha=${payload}`);
    return `${apply ? "Applied" : "Dry run (nothing changed; pass apply to add)"}: ${summary}\n${results.map((r) => r.line).join("\n")}`;
  }

  async function adminCall(caller: IdentityCaller, args: IdentityArgs): Promise<string> {
    const need = (value: string | undefined, what: string) => {
      if (!value?.trim()) throw new Error(`${what} is required`);
      return value;
    };
    switch (args.operation) {
      case "bind_for":
        return bind(caller, args, await personOf(need(args.person, "person")), true);
      case "unbind_for": {
        const person = await personOf(need(args.person, "person"));
        const row = await aliases.get(need(args.name, "name"));
        const mine = row?.kind === "person" && row.personId === person.personId;
        const resource = `${hashName(args.name!)} -> ${person.personId}`;
        if (mine) await aliases.remove(args.name!);
        record(caller, "unbind_for", resource, mine ? "ok" : "not_found", "by=admin");
        return mine ? "Unbound." : "That person has no such name bound.";
      }
      case "depart":
      case "undepart": {
        const person = await personOf(need(args.person, "person"));
        const rows = await aliases.setDeparted(person.personId, args.operation === "depart");
        record(caller, args.operation, person.personId, rows > 0 ? "ok" : "not_found", `by=admin rows=${rows}`);
        return rows > 0
          ? `${args.operation === "depart" ? "Marked departed" : "Cleared"}: ${rows} name(s).`
          : "That person has no names bound.";
      }
      case "ignore_add": {
        const one = await ignoreOne(
          caller,
          { name: need(args.name, "name"), email: args.email, reason: args.reason ?? "" },
          new Set(),
          true,
        );
        const why = one.outcome === "unchanged" ? "already ignored" : one.why;
        if (why) record(caller, "ignore_add", hashName(args.name!), "refused", `reason=${why}`);
        return why && !one.why ? `${one.line.split(":")[0]}: refused: ${why}` : one.line;
      }
      case "ignore_list": {
        const rows = (await aliases.list()).filter(
          (row) => row.kind === "ignored" && (!args.reason || row.reason === args.reason),
        );
        return rows.length === 0
          ? "The ignore list is empty."
          : rows
              .map((row) =>
                row.kind === "ignored"
                  ? `${row.name} | ${row.reason}${row.emailCondition ? ` | ${row.emailCondition}` : ""} | by ${row.addedBy} | ${new Date(row.addedAt).toISOString()}`
                  : "",
              )
              .join("\n");
      }
      case "ignore_remove": {
        const key = need(args.name, "name");
        const row = await aliases.get(key);
        const condition = args.email ? emailCondition(args.email) : undefined;
        const match = row?.kind === "ignored" && (!args.email || row.emailCondition === condition);
        if (match) await aliases.remove(key);
        record(caller, "ignore_remove", hashName(key), match ? "ok" : "not_found");
        return match
          ? "Removed from the ignore list; the author is queued again at the next sighting."
          : "No such ignore entry.";
      }
      case "ignore_import":
        return ignoreImport(caller, args);
      case "list_unmapped": {
        const rows = await deps.queue.list(args.status ?? "open");
        return rows.length === 0
          ? "No unmapped authors."
          : rows
              .map(
                (row) =>
                  `${row.name || "(no name)"} | ${row.emails.join(", ") || "(no email)"} | ${row.reason} | ${row.count} commits | e.g. ${row.exampleRepo}@${row.exampleSha}`,
              )
              .join("\n");
      }
      default:
        throw new Error(`unknown operation ${args.operation}`);
    }
  }

  async function selfCall(caller: IdentityCaller, args: IdentityArgs): Promise<string> {
    const me = await personOf(caller.principalId);
    if (args.operation === "bind") return bind(caller, args, me, false);
    if (args.operation === "list") {
      const rows = await aliases.ofPerson(me.personId);
      return rows.length === 0
        ? `You have no git names bound.\n${GIT_NAME_HINT}`
        : rows.map((row) => `${row.name}${row.emailCondition ? ` (only with ${row.emailCondition})` : ""}`).join("\n");
    }
    const name = args.name?.trim();
    if (!name) throw new Error("name is required");
    const row = await aliases.get(name);
    const mine = row?.kind === "person" && samePerson(row.personId, me.personId);
    if (mine) await aliases.remove(name);
    record(caller, "unbind", `${hashName(name)} -> ${me.personId}`, mine ? "ok" : "not_found");
    return mine ? "Unbound." : "You have no such name bound.";
  }

  return {
    async call(args, caller) {
      if (!caller.human) throw new Error("git names can only be changed in a conversation with a person");
      if ((SELF_OPERATIONS as readonly string[]).includes(args.operation)) {
        if (args.person) throw new Error("person is only for administrators; your own names are used automatically");
        return selfCall(caller, args);
      }
      const admin = caller.orgAdmin || config.identityAdmins.some((id) => samePerson(id, caller.principalId));
      if (!admin) throw new Error("only identity administrators can do this");
      if (!caller.privateAudience)
        throw new Error("administrator operations work only in your own private conversation with QM");
      return adminCall(caller, args);
    },
  };
}

let current: IdentityService | undefined;
export function setZqGitIdentity(service: IdentityService | undefined): void {
  current = service;
}
export function zqGitIdentity(): IdentityService | undefined {
  return current;
}
