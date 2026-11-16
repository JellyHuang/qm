export type Duty = string;

const DUTY_KEY = /^[a-z][a-z0-9_]*$/;

export type Lifecycle = "normal" | "delayed" | "suspended" | "cancelled";

const LIFECYCLES: readonly Lifecycle[] = ["normal", "delayed", "suspended", "cancelled"];

export const PERSON_FIELDS = [
  "responsiblePlanner",
  "pm",
  "reviewer",
  "qaOwner",
  "acceptor",
  "regressionOwner",
] as const;

export type PersonField = (typeof PERSON_FIELDS)[number];

const PERSON_DEFAULTS: Record<PersonField, string> = {
  responsiblePlanner: "planner",
  pm: "pm",
  reviewer: "reviewer",
  qaOwner: "qa_owner",
  acceptor: "acceptor",
  regressionOwner: "regression_owner",
};

export type Recipient = { kind: "duty"; duty: Duty } | { kind: "field"; field: PersonField };

export type TypeOwner = { kind: "duty"; duty: Duty } | { kind: "taskField"; field: PersonField };

export interface StageRoles {
  plannerUnassigned: string;
  reviewPending: string;
  staffing: string;
  briefing: string;
  inProduction: string;
  formalAssets: string;
  taskUnassigned: string;
  taskDone: string;
  bugClosed?: string;
}

export interface ZqContract {
  version: string;
  featureType: string;
  typeOwners: Readonly<Record<string, TypeOwner>>;
  bugType?: string;
  artResource: (typeKey: string) => boolean;
  autoAdvanceStages: readonly string[];
  stages: {
    feature: Readonly<Record<string, string>>;
    task: Readonly<Record<string, string>>;
    bug: Readonly<Record<string, string>>;
  };
  stageRoles: StageRoles;
  stageOwners: Readonly<Record<string, readonly Recipient[]>>;
  fields: {
    estimate: string;
    plannedStart: string;
    plannedEnd: string;
    delayMarked: string;
    delayedSince: string;
    qaPassed: string;
    awaitedChildren: string;
    awaitingNote: string;
  } & Record<PersonField, string>;
  duties: Readonly<Record<string, string>>;
  tools: {
    exitCheck?: string;
    meetingsForFeature?: string;
    dutyHolders?: string;
    bugsForFeature?: string;
    addSystemRemark?: string;
    changesSince?: string;
    createChildOrders?: string;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`contract key table: ${what} must be a non-empty string`);
  return v.trim();
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`contract key table: ${what} must be a list`);
  return v.map((item, i) => text(item, `${what}[${i}]`));
}

function stringMap(v: unknown, what: string): Record<string, string> {
  if (!isRecord(v)) throw new Error(`contract key table: ${what} must be an object`);
  return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, text(value, `${what}.${k}`)]));
}

function typeOwner(
  type: string,
  raw: unknown,
  knownDuties: ReadonlySet<string>,
  fields: Readonly<Record<string, string>>,
): TypeOwner {
  if (typeof raw === "string") {
    if (!knownDuties.has(raw)) throw new Error(`contract key table: typeDuties.${type} is not a duty`);
    return { kind: "duty", duty: raw };
  }
  if (isRecord(raw) && raw["kind"] === "field" && raw["on"] === "task") {
    const wire = text(raw["field"], `typeDuties.${type}.field`);
    const field = PERSON_FIELDS.find((f) => fields[f] === wire);
    if (!field) throw new Error(`contract key table: typeDuties.${type} names unknown person field ${wire}`);
    return { kind: "taskField", field };
  }
  throw new Error(`contract key table: typeDuties.${type} must be a duty key or a task person field`);
}

function artResourceOf(raw: Record<string, unknown>): (typeKey: string) => boolean {
  const flags = isRecord(raw["typeFlags"]) ? raw["typeFlags"] : {};
  const fallback = isRecord(raw["defaultTypeFlags"]) && raw["defaultTypeFlags"]["artResource"] === true;
  return (typeKey) => {
    const flag = flags[typeKey];
    return isRecord(flag) && typeof flag["artResource"] === "boolean" ? flag["artResource"] : fallback;
  };
}

function optionalTools(v: unknown): ZqContract["tools"] {
  if (v === undefined) return {};
  const map = stringMap(v, "tools");
  const known = [
    "exitCheck",
    "meetingsForFeature",
    "dutyHolders",
    "bugsForFeature",
    "addSystemRemark",
    "changesSince",
    "createChildOrders",
  ];
  for (const key of Object.keys(map))
    if (!known.includes(key)) throw new Error(`contract key table: unknown tool ${key}`);
  return map;
}

function recipient(raw: string, known: ReadonlySet<string>): Recipient {
  const field = raw.startsWith("field:") ? raw.slice("field:".length) : "";
  if ((PERSON_FIELDS as readonly string[]).includes(field)) return { kind: "field", field: field as PersonField };
  const duty = raw.startsWith("duty:") ? raw.slice("duty:".length) : "";
  if (!known.has(duty)) throw new Error(`contract key table: unknown recipient ${raw}`);
  return { kind: "duty", duty };
}

export function parseContract(value: unknown): ZqContract {
  if (!isRecord(value)) throw new Error("contract key table must be an object");
  const stages = isRecord(value["stages"]) ? value["stages"] : {};
  const feature = stringMap(stages["feature"], "stages.feature");
  const task = stringMap(stages["task"], "stages.task");
  const owners = isRecord(value["stageOwners"]) ? value["stageOwners"] : {};
  const roles = stringMap(value["stageRoles"], "stageRoles");
  const stageRole = (name: keyof StageRoles, table: Readonly<Record<string, string>>): string => {
    const key = text(roles[name], `stageRoles.${name}`);
    if (!(key in table)) throw new Error(`contract key table: stageRoles.${name} names unknown stage ${key}`);
    return key;
  };
  const known = new Set(Object.keys(feature));
  const duties = stringMap(value["duties"], "duties");
  if (!Object.keys(duties).length) throw new Error("contract key table: duties must name at least one duty");
  for (const key of Object.keys(duties))
    if (!DUTY_KEY.test(key)) throw new Error(`contract key table: duties.${key} is not a duty key`);
  const knownDuties = new Set(Object.keys(duties));
  const fields = stringMap(value["fields"], "fields");
  const personFieldNames = Object.fromEntries(
    PERSON_FIELDS.map((f) => [
      f,
      f === "responsiblePlanner" ? text(fields[f], "fields.responsiblePlanner") : (fields[f] ?? PERSON_DEFAULTS[f]),
    ]),
  ) as Record<PersonField, string>;
  const rawOwners = isRecord(value["typeDuties"]) ? value["typeDuties"] : {};
  const typeOwners = Object.fromEntries(
    Object.entries(rawOwners).map(([type, raw]) => [type, typeOwner(type, raw, knownDuties, personFieldNames)]),
  );
  const bug = stringMap(stages["bug"] ?? {}, "stages.bug");
  const autoAdvance =
    value["autoAdvanceStages"] === undefined ? [] : strings(value["autoAdvanceStages"], "autoAdvanceStages");
  for (const stage of autoAdvance)
    if (!known.has(stage))
      throw new Error(`contract key table: autoAdvanceStages names unknown feature stage ${stage}`);
  const bugClosed = roles["bugClosed"] ?? Object.keys(bug).at(-1);
  const stageOwners = Object.fromEntries(
    Object.entries(owners).map(([stage, list]) => {
      if (!known.has(stage)) throw new Error(`contract key table: stageOwners names unknown feature stage ${stage}`);
      return [stage, strings(list, `stageOwners.${stage}`).map((raw) => recipient(raw, knownDuties))];
    }),
  );
  return {
    version: text(value["version"], "version"),
    featureType: text(value["featureType"], "featureType"),
    typeOwners,
    ...(value["bugType"] === undefined ? {} : { bugType: text(value["bugType"], "bugType") }),
    artResource: artResourceOf(value),
    autoAdvanceStages: autoAdvance,
    stages: { feature, task, bug },
    stageRoles: {
      plannerUnassigned: stageRole("plannerUnassigned", feature),
      reviewPending: stageRole("reviewPending", feature),
      staffing: stageRole("staffing", feature),
      briefing: stageRole("briefing", feature),
      inProduction: stageRole("inProduction", feature),
      formalAssets: stageRole("formalAssets", feature),
      taskUnassigned: stageRole("taskUnassigned", task),
      taskDone: stageRole("taskDone", task),
      ...(bugClosed ? { bugClosed } : {}),
    },
    stageOwners,
    fields: {
      ...personFieldNames,
      delayMarked: fields["delayMarked"] ?? "delay_marked",
      delayedSince: fields["delayedSince"] ?? "delayed_since",
      qaPassed: fields["qaPassed"] ?? "qa_passed",
      awaitedChildren: fields["awaitedChildren"] ?? "awaited_children",
      awaitingNote: fields["awaitingNote"] ?? "awaiting_note",
      estimate: text(fields["estimate"], "fields.estimate"),
      plannedStart: text(fields["plannedStart"], "fields.plannedStart"),
      plannedEnd: text(fields["plannedEnd"], "fields.plannedEnd"),
    },
    duties,
    tools: optionalTools(value["tools"]),
  };
}

export function lifecycleOf(raw: unknown): Lifecycle | undefined {
  return typeof raw === "string" ? LIFECYCLES.find((l) => l === raw.trim().toLowerCase()) : undefined;
}

export function paused(lifecycle: Lifecycle | undefined): boolean {
  return lifecycle === "suspended" || lifecycle === "cancelled";
}

export function checkConfiguredDuties(contract: ZqContract, configured: Record<string, readonly string[]>): void {
  for (const [setting, list] of Object.entries(configured))
    for (const duty of list)
      if (!(duty in contract.duties))
        throw new Error(`${setting} names a duty the contract key table does not have: ${duty}`);
}
