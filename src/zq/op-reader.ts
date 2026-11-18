import { lifecycleOf, type Duty, type ZqContract } from "./contract.ts";
import type { FeedEvent } from "./changes.ts";
import type { AwaitedChild, ExitCheck, MeetingView, OpUserRef, WorkView } from "./rules.ts";
import type { OpReader, ScanPerson } from "./scanner.ts";

export type OpCall = (tool: string, args: Record<string, unknown>, principalId: string) => Promise<string>;

type Json = Record<string, unknown>;

const PAGE_LIMIT = 100;
const SHANGHAI = "+08:00";

export class OpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`OpenProject ${code}: ${message}`);
    this.code = code;
  }
}

export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function time(value: unknown, edge: "start" | "end" = "start"): number | undefined {
  if (typeof value !== "string") return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const ms = Date.parse(
    dateOnly ? `${value.trim()}${edge === "end" ? "T23:59:59.999" : "T00:00:00"}${SHANGHAI}` : value,
  );
  return Number.isNaN(ms) ? undefined : ms;
}

export function hours(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+)M)?)?$/.exec(value.trim());
  if (iso) return Number(iso[1] ?? 0) * 24 + Number(iso[2] ?? 0) + Number(iso[3] ?? 0) / 60;
  const plain = Number(value);
  return value.trim() && Number.isFinite(plain) ? plain : undefined;
}

function person(value: unknown): OpUserRef | undefined {
  if (!isObject(value)) return undefined;
  const id = str(value["id"]);
  const name = str(value["name"]) ?? str(value["login"]);
  const login = str(value["login"]);
  return id && name ? { id, name, ...(login ? { login } : {}) } : undefined;
}

function individual(value: unknown): OpUserRef | undefined {
  const type = isObject(value) ? str(value["type"]) : undefined;
  return type && !/^user$/i.test(type) ? undefined : person(value);
}

function people(value: unknown): OpUserRef[] {
  return (Array.isArray(value) ? value : [value]).flatMap((v) => person(v) ?? []);
}

const BRACKET_ERROR = /\[([A-Za-z][A-Za-z0-9_]*)\]\s*(.*)$/s;

function asOpError(e: unknown): OpError | undefined {
  if (e instanceof OpError) return e;
  const match = e instanceof Error ? BRACKET_ERROR.exec(e.message) : null;
  return match ? new OpError(match[1]!.toLowerCase(), match[2]!.trim()) : undefined;
}

function parseJson(text: string): unknown {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw asOpError(new Error(text)) ?? e;
    }
  })();
  const error = isObject(parsed) ? parsed["error"] : undefined;
  if (isObject(error)) throw new OpError(str(error["code"]) ?? "error", str(error["message"]) ?? "request failed");
  return parsed;
}

export interface Page {
  results: Json[];
  nextOffset: number | null;
}

export function parsePage(text: string): Page {
  const parsed = parseJson(text);
  if (!isObject(parsed) || !Array.isArray(parsed["results"])) throw new Error("OpenProject returned no results list");
  const next = parsed["next_offset"];
  return {
    results: parsed["results"].filter(isObject),
    nextOffset: typeof next === "number" && Number.isSafeInteger(next) ? next : null,
  };
}

function awaitedChildren(value: unknown): AwaitedChild[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const id = Number(item["id"]);
    const typeKey = str(item["type_key"]);
    const stageKey = str(item["stage_key"]);
    const owner = person(item["owner"]);
    return Number.isSafeInteger(id) && typeKey && stageKey
      ? [{ id, typeKey, stageKey, ...(owner ? { owner } : {}) }]
      : [];
  });
}

export function parseWorkView(item: unknown, contract: ZqContract): WorkView | undefined {
  if (!isObject(item)) return undefined;
  const id = Number(item["id"]);
  const typeKey = str(item["type_key"]);
  const stage = str(item["stage_key"]);
  const status = str(item["status_key"]);
  if (stage && status && stage !== status)
    throw new OpError("contract_mismatch", `work package ${id} has stage_key ${stage} but status_key ${status}`);
  const statusKey = stage ?? status;
  if (!Number.isSafeInteger(id) || !typeKey || !statusKey) return undefined;
  const lifecycle = lifecycleOf(item["lifecycle"]);
  const statusChangedAt = time(item["status_changed_at"]);
  const parentId = Number(item["parent_id"]);
  const project = isObject(item["project"]) ? item["project"] : undefined;
  const projectId = str(item["project_id"]) ?? str(project?.["id"]);
  const projectName = str(item["project_name"]) ?? str(project?.["name"]) ?? str(project?.["identifier"]);
  const assignee = individual(item["assignee"]);
  const personAt = (field: keyof ZqContract["fields"]) => person(item[contract.fields[field]]);
  const planners = people(item[contract.fields.responsiblePlanner]);
  const planner = planners[0];
  const participants = people(item[contract.fields.participants]);
  const pm = personAt("pm");
  const reviewer = personAt("reviewer");
  const qaOwner = personAt("qaOwner");
  const acceptor = personAt("acceptor");
  const regressionOwner = personAt("regressionOwner");
  const dueAt = time(item["due_date"], "end");
  const estimateHours = hours(item[contract.fields.estimate]);
  const plannedStart = time(item[contract.fields.plannedStart], "start");
  const plannedEnd = time(item[contract.fields.plannedEnd], "end");
  const delayMarked = item[contract.fields.delayMarked];
  const delayedSince = time(item[contract.fields.delayedSince]);
  const blocking = item["blocking"];
  const closed = item["is_closed"] ?? item["isClosed"];
  const awaited = awaitedChildren(item[contract.fields.awaitedChildren]);
  const awaitingNote = str(item[contract.fields.awaitingNote]);
  const completionSubmitted = item[contract.fields.completionSubmitted];
  const completionSubmittedAt = time(item[contract.fields.completionSubmittedAt]);
  return {
    id,
    subject: str(item["subject"]) ?? `#${id}`,
    typeKey,
    statusKey,
    ...(lifecycle ? { lifecycle } : {}),
    ...(statusChangedAt !== undefined ? { statusChangedAt } : {}),
    ...(Number.isSafeInteger(parentId) && parentId > 0 ? { parentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(assignee ? { assignee } : {}),
    ...(planner ? { responsiblePlanner: planner } : {}),
    ...(planners.length > 1 ? { planners } : {}),
    ...(participants.length ? { participants } : {}),
    ...(pm ? { pm } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(qaOwner ? { qaOwner } : {}),
    ...(acceptor ? { acceptor } : {}),
    ...(regressionOwner ? { regressionOwner } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(estimateHours !== undefined ? { estimateHours } : {}),
    ...(plannedStart !== undefined ? { plannedStart } : {}),
    ...(plannedEnd !== undefined ? { plannedEnd } : {}),
    ...(typeof delayMarked === "boolean" ? { delayMarked } : {}),
    ...(delayedSince !== undefined ? { delayedSince } : {}),
    ...(typeof blocking === "boolean" ? { blocking } : {}),
    ...(closed === true ? { closed } : {}),
    ...(awaited ? { awaited } : {}),
    ...(awaitingNote ? { awaitingNote } : {}),
    ...(completionSubmitted === true || completionSubmitted === "pass" ? { completionSubmitted: true } : {}),
    ...(completionSubmittedAt !== undefined ? { completionSubmittedAt } : {}),
  };
}

function parseMeeting(item: Json): MeetingView | undefined {
  const id = str(item["id"]);
  const endAt = time(item["end_time"]);
  if (!id || endAt === undefined) return undefined;
  return { id, title: str(item["title"]) ?? `会议 ${id}`, endAt, state: str(item["state"]) ?? "open" };
}

function parseExit(text: string): ExitCheck | undefined {
  const parsed = parseJson(text);
  if (!isObject(parsed) || typeof parsed["ready"] !== "boolean") return undefined;
  const blockers = Array.isArray(parsed["blockers"])
    ? parsed["blockers"].flatMap((b) => (isObject(b) ? (str(b["message"]) ?? str(b["code"]) ?? []) : (str(b) ?? [])))
    : [];
  return { ready: parsed["ready"], blockers };
}

function parseFeedEvent(item: Json): FeedEvent | undefined {
  const id = str(item["event_id"]);
  const ticketId = Number(item["ticket_id"]);
  const parent = Number(item["parent_feature_id"]);
  const at = time(item["occurred_at"] ?? item["time"]);
  if (!id || !Number.isSafeInteger(ticketId) || at === undefined) return undefined;
  const kinds = Array.isArray(item["kinds"]) ? item["kinds"].flatMap((k) => str(k) ?? []) : [];
  const kind = str(item["kind"]);
  const actor = isObject(item["actor"]) ? item["actor"] : undefined;
  const reason = str(item["reason"]);
  const batchId = str(item["batch_id"]);
  const actorName = actor ? (str(actor["name"]) ?? str(actor["rule_key"]) ?? str(actor["login"])) : undefined;
  const actorId = actor ? str(actor["id"]) : undefined;
  const oldStage = str(item["old_stage"]);
  const newStage = str(item["new_stage"]);
  return {
    id,
    ticketId,
    featureId: Number.isSafeInteger(parent) && parent > 0 ? parent : ticketId,
    kinds: kinds.length || !kind ? kinds : [kind],
    ...(oldStage ? { oldStage } : {}),
    ...(newStage ? { newStage } : {}),
    old: isObject(item["old"]) ? item["old"] : {},
    new: isObject(item["new"]) ? item["new"] : {},
    ...(actorName ? { actorName } : {}),
    ...(actorId ? { actorId } : {}),
    byRule: actor !== undefined && str(actor["kind"]) === "rule",
    at,
    ...(reason ? { reason } : {}),
    ...(batchId ? { batchId } : {}),
  };
}

const CONCURRENCY = 5;
const FEED_PAGE_LIMIT = 100;
const FEED_PAGE_CAP = 1000;

async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}

export function createMcpOpReader(opts: {
  call: OpCall;
  contract: ZqContract;
  serverId?: string;
  projects?: readonly string[];
}): OpReader {
  const { contract } = opts;
  const tool = (name: string) => `${opts.serverId ?? "openproject"}_${name}`;

  async function pages(name: string, args: Json, principalId: string): Promise<Json[]> {
    const rows: Json[] = [];
    let offset = 0;
    for (;;) {
      const page = parsePage(await opts.call(tool(name), { ...args, offset }, principalId));
      rows.push(...page.results);
      if (page.nextOffset === null) return rows;
      if (page.nextOffset <= offset) throw new Error(`OpenProject ${name} did not advance past offset ${offset}`);
      offset = page.nextOffset;
    }
  }

  const invisible = (e: unknown) => {
    const code = asOpError(e)?.code;
    return code === "not_found" || code === "404";
  };

  return {
    async features(scanner: ScanPerson) {
      const rows = await pages("zq_list_work_packages", { limit: PAGE_LIMIT }, scanner.principalId);
      const problems: string[] = [];
      const found = rows.flatMap((row) => {
        try {
          return parseWorkView(row, contract) ?? [];
        } catch (e) {
          if (!(e instanceof OpError)) throw e;
          problems.push(e.message);
          return [];
        }
      });
      const featureIds = new Set(found.filter((w) => w.typeKey === contract.featureType).map((w) => w.id));
      const inScope = (w: WorkView) =>
        !opts.projects || (w.projectId !== undefined && opts.projects.includes(w.projectId));
      const standalone = (w: WorkView) =>
        contract.optimizationType !== undefined &&
        w.typeKey === contract.optimizationType &&
        !featureIds.has(w.parentId ?? -1);
      const features = found.filter((w) => inScope(w) && (w.typeKey === contract.featureType || standalone(w)));
      const isBug = (w: WorkView) => w.typeKey === contract.bugType;
      const facts = await mapLimited(features, async (feature) => {
        const under = found.filter((w) => w.parentId === feature.id);
        const attached = new Set(
          under
            .filter((w) => contract.optimizationType !== undefined && w.typeKey === contract.optimizationType)
            .map((w) => w.id),
        );
        const children = [
          ...under.filter((w) => !isBug(w)),
          ...found.filter((w) => attached.has(w.parentId ?? -1) && !isBug(w)),
        ];
        if (feature.typeKey !== contract.featureType) return { feature, children, bugs: under.filter(isBug) };
        const [bugs, meetings, exit] = await Promise.all([
          contract.tools.bugsForFeature
            ? pages(contract.tools.bugsForFeature, { id: feature.id }, scanner.principalId).then(
                (r) => r.flatMap((b) => parseWorkView(b, contract) ?? []),
                (e: unknown) => {
                  if (invisible(e)) return under.filter(isBug);
                  throw e;
                },
              )
            : under.filter(isBug),
          contract.tools.meetingsForFeature
            ? pages(contract.tools.meetingsForFeature, { id: feature.id }, scanner.principalId).then(
                (r) => r.flatMap((m) => parseMeeting(m) ?? []),
                (e: unknown) => {
                  if (invisible(e)) return undefined;
                  throw e;
                },
              )
            : undefined,
          contract.tools.exitCheck
            ? opts
                .call(tool(contract.tools.exitCheck), { id: feature.id }, scanner.principalId)
                .then((t) => parseExit(t))
                .catch((e: unknown) => {
                  if (invisible(e)) return undefined;
                  throw e;
                })
            : undefined,
        ]);
        return { feature, children, bugs, ...(meetings ? { meetings } : {}), ...(exit ? { exit } : {}) };
      });
      return { facts, problems };
    },
    ...(contract.tools.changesSince
      ? {
          async changes(scanner: ScanPerson, projectId: string, cursor: string | null) {
            const events: FeedEvent[] = [];
            let at = cursor;
            for (let page = 0; page < FEED_PAGE_CAP; page++) {
              const text = await opts
                .call(
                  tool(contract.tools.changesSince!),
                  {
                    project_id: /^\d+$/.test(projectId) ? Number(projectId) : projectId,
                    cursor: at,
                    limit: FEED_PAGE_LIMIT,
                  },
                  scanner.principalId,
                )
                .catch((e: unknown) => {
                  throw asOpError(e) ?? e;
                });
              const parsed = parseJson(text);
              if (!isObject(parsed) || !Array.isArray(parsed["results"]) || !str(parsed["next_cursor"]))
                throw new Error("OpenProject returned no change page");
              events.push(...parsed["results"].filter(isObject).flatMap((r) => parseFeedEvent(r) ?? []));
              at = str(parsed["next_cursor"])!;
              if (parsed["has_more"] !== true) return { events, nextCursor: at };
            }
            throw new Error("OpenProject change feed did not reach its end");
          },
        }
      : {}),
    async dutyHolders(scanner: ScanPerson, projectId: string, duty: Duty): Promise<OpUserRef[] | undefined> {
      if (!contract.tools.dutyHolders) return undefined;
      const rows = await pages(
        contract.tools.dutyHolders,
        { project_id: /^\d+$/.test(projectId) ? Number(projectId) : projectId, duty: contract.duties[duty] },
        scanner.principalId,
      );
      return rows.flatMap((r) => person(r) ?? []);
    },
  };
}
