import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, AuditLog } from "../src/audit/audit-log.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { zqConfigFromEnv } from "../src/zq/config.ts";
import { createAuthorMapping, createRecordingSink } from "../src/zq/git-mcp/author-mapping.ts";
import type { IdentityArgs, IdentityCaller } from "../src/zq/git-mcp/identity.ts";
import { hashName } from "../src/zq/git-mcp/names.ts";
import { memoryMap } from "./support/memory-map.ts";

const POLL = {
  ZQ_GIT_MCP_URL: "http://127.0.0.1:8765/mcp",
  ZQ_GIT_MCP_SECRET: "a-shared-secret-0123456789",
  ZQ_GIT_POLL: "1",
  ZQ_GIT_AUTHOR_MAPPING: "1",
  ZQ_GIT_AUTHOR_BIND: "1",
  ZQ_GIT_BOT_NAMES: "dependabot",
};

function harness(extraEnv: NodeJS.ProcessEnv = {}) {
  const tables = new Map<string, Map<string, unknown>>();
  const events: AuditEvent[] = [];
  const audit: AuditLog = {
    record: (event) => void events.push(event),
    events: async () => events,
    tail: async () => events,
  };
  const sink = createRecordingSink();
  const clock = { now: 1000 };
  const mapping = createAuthorMapping({
    config: zqConfigFromEnv({ ...POLL, ...extraEnv }).gitAuthors,
    map: <T>(table: string): DurableMap<T> => {
      if (!tables.has(table)) tables.set(table, new Map());
      return memoryMap<T>(tables.get(table) as Map<string, T>);
    },
    sink,
    audit,
    now: () => clock.now,
  })!;
  const service = mapping.identity!;
  const call = (args: IdentityArgs, principalId = "p-alice", caller: Partial<IdentityCaller> = {}) =>
    service.call(args, {
      principalId,
      human: true,
      orgAdmin: false,
      privateAudience: true,
      scope: `personal:${principalId}`,
      ...caller,
    });
  const admin = (args: IdentityArgs) => call(args, "p-pm", { orgAdmin: true });
  const see = (name: string, email = "x@y.example", sha = `${name}-${email}`) =>
    mapping.mapper.map([
      {
        repo: "client",
        branch: "main",
        status: "updated",
        commits: [
          { sha, authorName: name, authorEmail: email, date: "2026-01-01T00:00:00Z", subject: "s", branch: "main" },
        ],
      },
    ]);
  return { mapping, events, sink, call, admin, see, tables, clock };
}

const refused = (events: AuditEvent[]) => events.filter((e) => e.status === "refused");

test("bind adds the caller's rows, several names in one call, and the reply says how to find the git name", async () => {
  const h = harness();
  const reply = await h.call({ operation: "bind", names: ["Alice Example", "艾丽丝", "ACME\\alice.e"] });
  assert.match(reply, /git config user\.name/);
  assert.match(reply, /git config user\.email/);
  assert.match(reply, /DOMAIN\\name/);
  const result = await h.see("alice example");
  assert.deepEqual(
    result.byPerson.map((g) => g.person.personId),
    ["p-alice"],
  );
  assert.deepEqual(
    (await h.mapping.aliases.list()).map((row) => row.nameKey),
    ["acme\\alice.e", "alice example", "艾丽丝"],
  );
  assert.deepEqual(
    h.events.map((e) => [e.action, e.status, e.principalId]),
    [
      ["zq_git.identity.bind", "ok", "p-alice"],
      ["zq_git.identity.bind", "ok", "p-alice"],
      ["zq_git.identity.bind", "ok", "p-alice"],
    ],
  );
});

test("the person argument is rejected on self operations and non-human turns cannot change anything", async () => {
  const h = harness();
  await assert.rejects(h.call({ operation: "bind", names: ["x"], person: "p-bob" }), /only for administrators/);
  await assert.rejects(h.call({ operation: "list", person: "p-bob" }), /only for administrators/);
  await assert.rejects(h.call({ operation: "bind", names: ["Alice Example"] }, "p-alice", { human: false }), /person/);
  await assert.rejects(h.call({ operation: "list" }, "p-alice", { human: false }), /person/);
  assert.deepEqual(await h.mapping.aliases.list(), []);
});

test("list shows only the caller's rows and unbind cannot remove another person's row", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Alice Example"] }, "p-alice");
  await h.call({ operation: "bind", names: ["Bob Example"] }, "p-bob");
  assert.equal(await h.call({ operation: "list" }, "p-alice"), "Alice Example");
  assert.match(await h.call({ operation: "unbind", name: "bob example" }, "p-alice"), /no such name/);
  assert.equal((await h.mapping.aliases.get("Bob Example"))?.kind, "person");
  assert.equal(await h.call({ operation: "unbind", name: "ALICE EXAMPLE" }, "p-alice"), "Unbound.");
  assert.equal(await h.mapping.aliases.get("Alice Example"), null);
  assert.deepEqual(
    h.events.filter((e) => e.action === "zq_git.identity.unbind").map((e) => e.status),
    ["not_found", "ok"],
  );
});

test("a bind of a held name is refused with the rename hint, the holder is notified once and the reply does not name the holder", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Justin"] }, "p-bob");
  const reply = await h.call({ operation: "bind", names: ["JUSTIN"] }, "p-alice");
  assert.match(reply, /already bound/);
  assert.match(reply, /git config user\.name/);
  assert.match(reply, /justin01/i);
  assert.match(reply, /ask the PM/);
  assert.ok(!reply.includes("p-bob"));
  assert.deepEqual(h.sink.claimAttempts, [{ personId: "p-bob", mattermostUser: "p-bob" }]);
  const [event] = refused(h.events);
  assert.equal(event!.action, "zq_git.identity.bind");
  assert.match(event!.detail ?? "", /reason=held holder_notified=yes/);
  assert.equal(
    (await h.mapping.aliases.get("justin"))?.kind === "person" && (await h.mapping.aliases.get("justin"))!.addedBy,
    "p-bob",
  );
});

test("binding a name that is already yours changes nothing and notifies nobody", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Justin"] });
  assert.match(await h.call({ operation: "bind", names: ["justin"] }), /already bound/);
  assert.deepEqual(h.sink.claimAttempts, []);
  assert.deepEqual(refused(h.events), []);
});

test("two concurrent binds of one name: exactly one wins and the loser is refused", async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    h.call({ operation: "bind", names: ["Contested"] }, "p-alice"),
    h.call({ operation: "bind", names: ["Contested"] }, "p-bob"),
  ]);
  assert.equal([a, b].filter((reply) => /: bound/.test(reply)).length, 1);
  assert.equal([a, b].filter((reply) => /already bound/.test(reply)).length, 1);
  assert.equal((await h.mapping.aliases.list()).length, 1);
});

test("the admin refusal of a held name shows the holder and does not notify anyone", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Justin"] }, "p-bob");
  const reply = await h.admin({ operation: "bind_for", person: "p-carol", names: ["Justin"] });
  assert.match(reply, /bound to p-bob/);
  assert.deepEqual(h.sink.claimAttempts, []);
  assert.equal(refused(h.events).length, 1);
  await h.admin({ operation: "unbind_for", person: "p-bob", name: "Justin" });
  assert.match(await h.admin({ operation: "bind_for", person: "p-carol", names: ["Justin"] }), /Justin: bound/);
});

test("the per-person cap is enforced on the self path", async () => {
  const h = harness({ ZQ_GIT_BIND_MAX_PER_PERSON: "2" });
  await h.call({ operation: "bind", names: ["one", "two"] });
  assert.match(await h.call({ operation: "bind", names: ["three"] }), /already have 2 names/);
  assert.equal((await h.mapping.aliases.ofPerson("p-alice")).length, 2);
  assert.match(
    await h.call({ operation: "bind", names: ["x1", "x2", "x3", "x4", "x5", "x6"] }).catch((e) => String(e)),
    /1 to 5/,
  );
});

test("a generic name needs an email condition for people and for admins, and then maps only with that email", async () => {
  const h = harness();
  assert.match(await h.call({ operation: "bind", names: ["HOST123\\admin"] }), /generic name/);
  assert.match(await h.admin({ operation: "bind_for", person: "p-fred", names: ["HOST123\\admin"] }), /generic name/);
  assert.match(await h.admin({ operation: "ignore_add", name: "root", reason: "automation" }), /generic name/);
  assert.deepEqual(await h.mapping.aliases.list(), []);
  assert.match(
    await h.admin({ operation: "bind_for", person: "p-fred", names: ["HOST123\\admin"], email: "X@Y.example" }),
    /bound/,
  );
  assert.deepEqual(
    (await h.see("HOST123\\admin", "x@y.example")).byPerson.map((g) => g.person.personId),
    ["p-fred"],
  );
  assert.equal((await h.see("HOST123\\admin", "z@y.example")).unmapped.length, 1);
  await assert.rejects(h.call({ operation: "bind", names: ["x"], email: "has space" }), /email condition/);
});

test("a self-bind of a bot-looking name is refused for people and allowed for an admin with an audit row", async () => {
  const h = harness();
  assert.match(await h.call({ operation: "bind", names: ["ZQBot.compiler"] }), /automation account/);
  assert.equal((await h.see("ZQBot.compiler")).commits[0]!.author.kind, "bot");
  assert.match(await h.admin({ operation: "bind_for", person: "p-carol", names: ["ZQBot.compiler"] }), /bound/);
  assert.deepEqual(
    (await h.see("ZQBot.compiler", "x@y.example", "z2")).byPerson.map((g) => g.person.personId),
    ["p-carol"],
  );
  const adminEvent = h.events.find((e) => e.action === "zq_git.identity.bind_for")!;
  assert.deepEqual([adminEvent.status, adminEvent.detail], ["ok", "bot_name"]);
  assert.equal(refused(h.events)[0]!.detail, "reason=bot_name");
});

test("a person can claim a name that only looks like it contains the word bot", async () => {
  const h = harness();
  assert.match(await h.call({ operation: "bind", names: ["Abbott", "Botha"] }), /Abbott: bound\nBotha: bound/);
});

test("admin operations need an identity administrator in their own private conversation", async () => {
  const h = harness({ ZQ_GIT_IDENTITY_ADMINS: "p-lead" });
  const ops: IdentityArgs[] = [
    { operation: "bind_for", person: "p-bob", names: ["n"] },
    { operation: "ignore_list" },
    { operation: "list_unmapped" },
    { operation: "depart", person: "p-bob" },
  ];
  for (const args of ops) await assert.rejects(h.call(args, "p-alice"), /identity administrators/);
  for (const args of ops)
    await assert.rejects(h.call(args, "p-pm", { orgAdmin: true, privateAudience: false }), /private conversation/);
  assert.equal(await h.call({ operation: "ignore_list" }, "p-lead"), "The ignore list is empty.");
  assert.equal(await h.call({ operation: "ignore_list" }, "p-pm", { orgAdmin: true }), "The ignore list is empty.");
  assert.deepEqual(await h.mapping.aliases.list(), []);
});

test("bind_for closes the queue row of the author and the author maps from the next sighting", async () => {
  const h = harness();
  await h.see("Alice Home", "alice.home@example.org");
  assert.equal((await h.mapping.queue.list()).length, 1);
  await h.admin({ operation: "bind_for", person: "p-alice", names: ["alice home"] });
  assert.equal((await h.mapping.queue.list()).length, 0);
  assert.equal((await h.mapping.queue.list("resolved")).length, 1);
  assert.deepEqual(
    (await h.see("Alice Home", "alice.home@example.org", "n2")).byPerson.map((g) => g.person.personId),
    ["p-alice"],
  );
});

test("list_unmapped shows real names, emails, counts and an example to an administrator", async () => {
  const h = harness();
  await h.see("Alice Home", "alice.home@example.org", "abc123");
  assert.equal(
    await h.admin({ operation: "list_unmapped" }),
    "Alice Home | alice.home@example.org | no_match | 1 commits | e.g. client@abc123",
  );
});

test("an ignored name and a bound name conflict is refused in both directions and by self-bind", async () => {
  const h = harness();
  await h.admin({ operation: "ignore_add", name: "pipeline-sync", reason: "automation" });
  await h.call({ operation: "bind", names: ["Alice Example"] });
  assert.match(await h.call({ operation: "bind", names: ["Pipeline-Sync"] }, "p-bob"), /already bound \(or ignored\)/);
  assert.match(
    await h.admin({ operation: "bind_for", person: "p-bob", names: ["pipeline-sync"] }),
    /on the ignore list \(automation\)/,
  );
  assert.match(
    await h.admin({ operation: "ignore_add", name: "alice example", reason: "external" }),
    /bound to p-alice, unbind first/,
  );
  assert.match(
    await h.admin({ operation: "ignore_add", name: "PIPELINE-sync", reason: "automation" }),
    /refused: already ignored/,
  );
  assert.deepEqual(h.sink.claimAttempts, []);
});

test("ignore_add needs a reason of automation or external and is audited with hashes only", async () => {
  const h = harness();
  assert.match(
    await h.admin({ operation: "ignore_add", name: "pipeline-sync" }),
    /reason must be automation or external/,
  );
  assert.match(
    await h.admin({ operation: "ignore_add", name: "pipeline-sync", reason: "bot" }),
    /reason must be automation or external/,
  );
  assert.equal(
    await h.admin({ operation: "ignore_add", name: "Visiting Student", reason: "external" }),
    "Visiting Student: added (external)",
  );
  assert.equal(
    await h.admin({ operation: "ignore_list" }),
    "Visiting Student | external | by p-pm | 1970-01-01T00:00:01.000Z",
  );
  assert.equal(await h.admin({ operation: "ignore_list", reason: "automation" }), "The ignore list is empty.");
  const added = h.events.filter((e) => e.action === "zq_git.identity.ignore_add");
  assert.deepEqual(
    added.map((e) => [e.status, e.resource, e.detail]),
    [
      ["refused", hashName("pipeline-sync"), "reason=reason must be automation or external"],
      ["refused", hashName("pipeline-sync"), "reason=reason must be automation or external"],
      ["ok", hashName("Visiting Student"), "reason=external"],
    ],
  );
});

test("ignore_remove returns the author to the queue at the next sighting", async () => {
  const h = harness();
  await h.admin({ operation: "ignore_add", name: "pipeline-sync", reason: "automation", email: "@partnerco" });
  assert.equal((await h.see("pipeline-sync", "@partnerco", "a")).ignored.length, 1);
  assert.equal((await h.mapping.queue.list()).length, 0);
  assert.match(
    await h.admin({ operation: "ignore_remove", name: "pipeline-sync", email: "@other" }),
    /No such ignore entry/,
  );
  assert.match(await h.admin({ operation: "ignore_remove", name: "pipeline-sync", email: "@partnerco" }), /Removed/);
  await h.see("pipeline-sync", "@partnerco", "b");
  assert.deepEqual(
    (await h.mapping.queue.list()).map((e) => [e.nameKey, e.count]),
    [["pipeline-sync", 1]],
  );
  await h.call({ operation: "bind", names: ["Alice Example"] });
  assert.match(await h.admin({ operation: "ignore_remove", name: "Alice Example" }), /No such ignore entry/);
  assert.equal((await h.mapping.aliases.get("Alice Example"))?.kind, "person");
});

test("ignoring a name closes its open queue row so the PM is not asked about it", async () => {
  const h = harness();
  await h.see("Visiting Student", "v@univ.example");
  await h.admin({ operation: "ignore_add", name: "visiting student", reason: "external" });
  assert.equal((await h.mapping.queue.list()).length, 0);
});

const ENTRIES = [
  { name: "pipeline-sync", email: "@partnerco", reason: "automation" },
  { name: "Visiting Student", reason: "external" },
  { name: "Visiting Student", reason: "external" },
  { name: "root", reason: "automation" },
  { name: "Alice Example", reason: "external" },
  { name: "nightly", reason: "other" },
];

test("ignore_import is a dry run by default: it changes nothing and reports each entry and counts per reason", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Alice Example"] });
  const reply = await h.admin({ operation: "ignore_import", entries: ENTRIES });
  assert.match(
    reply,
    /^Dry run \(nothing changed; pass apply to add\): add=2 unchanged=0 refused=4 automation=1 external=1/,
  );
  assert.match(reply, /pipeline-sync: would add \(automation\)/);
  assert.match(reply, /Visiting Student: would add \(external\)/);
  assert.match(reply, /Visiting Student: refused: duplicate within the entries/);
  assert.match(reply, /root: refused: generic name needs an email condition/);
  assert.match(reply, /Alice Example: refused: bound to p-alice, unbind first/);
  assert.match(reply, /nightly: refused: reason must be automation or external/);
  assert.deepEqual(
    (await h.mapping.aliases.list()).map((row) => row.nameKey),
    ["alice example"],
  );
  const dry = h.events.find((e) => e.action === "zq_git.identity.ignore_import")!;
  assert.equal(dry.status, "dry_run");
  assert.match(dry.detail ?? "", /^add=2 unchanged=0 refused=4 automation=1 external=1 sha=[0-9a-f]{16}$/);
});

test("ignore_import apply adds, a second run is all unchanged, and re-import never removes rows or changes a reason", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Alice Example"] });
  const applied = await h.admin({ operation: "ignore_import", entries: ENTRIES, apply: true });
  assert.match(applied, /^Applied: add=2 unchanged=0 refused=4/);
  assert.deepEqual(
    (await h.mapping.aliases.list()).map((row) => [row.nameKey, row.kind]),
    [
      ["alice example", "person"],
      ["pipeline-sync", "ignored"],
      ["visiting student", "ignored"],
    ],
  );
  const again = await h.admin({ operation: "ignore_import", entries: ENTRIES.slice(0, 2), apply: true });
  assert.match(again, /^Applied: add=0 unchanged=2 refused=0/);
  const subset = await h.admin({ operation: "ignore_import", entries: [ENTRIES[1]!], apply: true });
  assert.match(subset, /unchanged=1/);
  assert.equal((await h.mapping.aliases.list()).length, 3);
  const changed = await h.admin({
    operation: "ignore_import",
    entries: [{ name: "pipeline-sync", email: "@partnerco", reason: "external" }],
    apply: true,
  });
  assert.match(changed, /refused: exists with another reason or condition/);
  const row = await h.mapping.aliases.get("pipeline-sync");
  assert.equal(row?.kind === "ignored" && row.reason, "automation");
  const imports = h.events.filter((e) => e.action === "zq_git.identity.ignore_import").map((e) => e.status);
  assert.deepEqual(imports, ["ok", "ok", "ok", "ok"]);
  assert.equal(h.events.filter((e) => e.action === "zq_git.identity.ignore_add" && e.status === "ok").length, 2);
});

test("ignored authors produce no queue row after an import, and an import by a non-admin is refused", async () => {
  const h = harness();
  await assert.rejects(
    h.call({ operation: "ignore_import", entries: ENTRIES, apply: true }),
    /identity administrators/,
  );
  await h.admin({ operation: "ignore_import", entries: ENTRIES.slice(0, 2), apply: true });
  const result = await h.see("Pipeline-Sync", "@partnerco");
  assert.deepEqual([result.unmapped, result.ignored.length], [[], 1]);
  assert.equal((await h.mapping.queue.list()).length, 0);
});

test("depart and undepart move the person's commits to the PM path and back, and a departed person cannot self-bind", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Dana Example"] }, "p-dana");
  assert.match(await h.admin({ operation: "depart", person: "p-dana" }), /Marked departed: 1 name/);
  await h.see("Dana Example", "d@x.example", "d1");
  assert.equal(h.sink.sent.length, 0);
  assert.deepEqual(
    h.sink.sentToPm.map((n) => n.person.personId),
    ["p-dana"],
  );
  assert.match(await h.call({ operation: "bind", names: ["Dana Home"] }, "p-dana"), /marked as departed/);
  assert.match(await h.admin({ operation: "bind_for", person: "p-dana", names: ["Dana Home"] }), /bound/);
  assert.equal(
    (await h.mapping.aliases.ofPerson("p-dana")).every((row) => row.departedAt !== undefined),
    true,
  );
  assert.match(await h.admin({ operation: "undepart", person: "p-dana" }), /Cleared: 2 name/);
  await h.see("Dana Home", "d@x.example", "d2");
  assert.deepEqual(
    h.sink.sent.map((n) => n.person.personId),
    ["p-dana"],
  );
  assert.match(await h.admin({ operation: "depart", person: "p-nobody" }), /no names bound/);
});

test("audit rows carry hashes and ids only, never a name or an email", async () => {
  const h = harness();
  await h.call({ operation: "bind", names: ["Alice Example"] }, "p-alice");
  await h.call({ operation: "bind", names: ["alice example"] }, "p-bob");
  await h.admin({ operation: "bind_for", person: "p-carol", names: ["Carol Condition"], email: "carol@x.example" });
  await h.admin({
    operation: "ignore_import",
    entries: [{ name: "Secret Pipeline", email: "s@partnerco", reason: "automation" }],
    apply: true,
  });
  await h.call({ operation: "unbind", name: "Alice Example" }, "p-alice");
  const text = JSON.stringify(h.events).toLowerCase();
  for (const secret of ["alice example", "carol condition", "carol@x", "secret pipeline", "partnerco"])
    assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes(hashName("Alice Example")));
});
