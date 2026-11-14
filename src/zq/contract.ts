export const DUTIES = ["producer", "pm", "art_lead", "client_lead", "server_lead", "planning_lead", "qa_lead"] as const;

export type Duty = (typeof DUTIES)[number];

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

export type Recipient = { kind: "duty"; duty: Duty } | { kind: "field"; field: PersonField };

export interface StageRoles {
  plannerUnassigned: string;
  reviewPending: string;
  staffing: string;
  briefing: string;
  inProduction: string;
  formalAssets: string;
  taskUnassigned: string;
  taskDone: string;
}

export interface ZqContract {
  version: string;
  featureType: string;
  typeDuties: Readonly<Record<string, Duty>>;
  stages: {
    feature: Readonly<Record<string, string>>;
    task: Readonly<Record<string, string>>;
  };
  stageRoles: StageRoles;
  stageOwners: Readonly<Record<string, readonly Recipient[]>>;
  fields: {
    estimate: string;
    plannedStart: string;
    plannedEnd: string;
  } & Record<PersonField, string>;
  duties: Readonly<Record<Duty, string>>;
  tools: { exitCheck?: string; meetingsForFeature?: string; dutyHolders?: string };
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

function typeDuties(v: unknown): Record<string, Duty> {
  const map = stringMap(v, "typeDuties");
  for (const [type, duty] of Object.entries(map))
    if (!(DUTIES as readonly string[]).includes(duty))
      throw new Error(`contract key table: typeDuties.${type} is not a duty`);
  return map as Record<string, Duty>;
}

function optionalTools(v: unknown): ZqContract["tools"] {
  if (v === undefined) return {};
  const map = stringMap(v, "tools");
  const known = ["exitCheck", "meetingsForFeature", "dutyHolders"];
  for (const key of Object.keys(map))
    if (!known.includes(key)) throw new Error(`contract key table: unknown tool ${key}`);
  return map;
}

function recipient(raw: string): Recipient {
  const field = raw.startsWith("field:") ? raw.slice("field:".length) : "";
  if ((PERSON_FIELDS as readonly string[]).includes(field)) return { kind: "field", field: field as PersonField };
  const duty = raw.startsWith("duty:") ? raw.slice("duty:".length) : "";
  if (!(DUTIES as readonly string[]).includes(duty)) throw new Error(`contract key table: unknown recipient ${raw}`);
  return { kind: "duty", duty: duty as Duty };
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
  const stageOwners = Object.fromEntries(
    Object.entries(owners).map(([stage, list]) => {
      if (!known.has(stage)) throw new Error(`contract key table: stageOwners names unknown feature stage ${stage}`);
      return [stage, strings(list, `stageOwners.${stage}`).map(recipient)];
    }),
  );
  const fields = stringMap(value["fields"], "fields");
  const duties = stringMap(value["duties"], "duties");
  for (const duty of DUTIES) text(duties[duty], `duties.${duty}`);
  return {
    version: text(value["version"], "version"),
    featureType: text(value["featureType"], "featureType"),
    typeDuties: typeDuties(value["typeDuties"]),
    stages: { feature, task },
    stageRoles: {
      plannerUnassigned: stageRole("plannerUnassigned", feature),
      reviewPending: stageRole("reviewPending", feature),
      staffing: stageRole("staffing", feature),
      briefing: stageRole("briefing", feature),
      inProduction: stageRole("inProduction", feature),
      formalAssets: stageRole("formalAssets", feature),
      taskUnassigned: stageRole("taskUnassigned", task),
      taskDone: stageRole("taskDone", task),
    },
    stageOwners,
    fields: {
      responsiblePlanner: text(fields["responsiblePlanner"], "fields.responsiblePlanner"),
      pm: fields["pm"] ? text(fields["pm"], "fields.pm") : "pm",
      reviewer: fields["reviewer"] ? text(fields["reviewer"], "fields.reviewer") : "reviewer",
      qaOwner: fields["qaOwner"] ? text(fields["qaOwner"], "fields.qaOwner") : "qa_owner",
      acceptor: fields["acceptor"] ? text(fields["acceptor"], "fields.acceptor") : "acceptor",
      regressionOwner: fields["regressionOwner"]
        ? text(fields["regressionOwner"], "fields.regressionOwner")
        : "regression_owner",
      estimate: text(fields["estimate"], "fields.estimate"),
      plannedStart: text(fields["plannedStart"], "fields.plannedStart"),
      plannedEnd: text(fields["plannedEnd"], "fields.plannedEnd"),
    },
    duties: duties as Record<Duty, string>,
    tools: optionalTools(value["tools"]),
  };
}

export function lifecycleOf(raw: unknown): Lifecycle | undefined {
  return typeof raw === "string" ? LIFECYCLES.find((l) => l === raw.trim().toLowerCase()) : undefined;
}

export function paused(lifecycle: Lifecycle | undefined): boolean {
  return lifecycle === "suspended" || lifecycle === "cancelled";
}
