import { lifecycleOf, type Duty, type ZqContract } from "./contract.ts";
import type { ExitCheck, FeatureFacts, MeetingView, OpUserRef, WorkView } from "./rules.ts";
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

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown): string | undefined {
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

function hours(value: unknown): number | undefined {
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

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const error = isObject(parsed) ? parsed["error"] : undefined;
  if (isObject(error)) throw new OpError(str(error["code"]) ?? "error", str(error["message"]) ?? "request failed");
  return parsed;
}

interface Page {
  results: Json[];
  nextOffset: number | null;
}

function parsePage(text: string): Page {
  const parsed = parseJson(text);
  if (!isObject(parsed) || !Array.isArray(parsed["results"])) throw new Error("OpenProject returned no results list");
  const next = parsed["next_offset"];
  return {
    results: parsed["results"].filter(isObject),
    nextOffset: typeof next === "number" && Number.isSafeInteger(next) ? next : null,
  };
}

export function parseWorkView(item: unknown, contract: ZqContract): WorkView | undefined {
  if (!isObject(item)) return undefined;
  const id = Number(item["id"]);
  const typeKey = str(item["type_key"]);
  const statusKey = str(item["stage_key"]) ?? str(item["status_key"]);
  if (!Number.isSafeInteger(id) || !typeKey || !statusKey) return undefined;
  const lifecycle = lifecycleOf(item["lifecycle"]);
  const statusChangedAt = time(item["status_changed_at"]);
  const parentId = Number(item["parent_id"]);
  const projectId = str(item["project_id"]);
  const assignee = individual(item["assignee"]);
  const planner = person(item[contract.fields.responsiblePlanner]);
  const dueAt = time(item["due_date"], "end");
  const estimateHours = hours(item[contract.fields.estimate]);
  const plannedStart = time(item[contract.fields.plannedStart], "start");
  const plannedEnd = time(item[contract.fields.plannedEnd], "end");
  return {
    id,
    subject: str(item["subject"]) ?? `#${id}`,
    typeKey,
    statusKey,
    ...(lifecycle ? { lifecycle } : {}),
    ...(statusChangedAt !== undefined ? { statusChangedAt } : {}),
    ...(Number.isSafeInteger(parentId) && parentId > 0 ? { parentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(assignee ? { assignee } : {}),
    ...(planner ? { responsiblePlanner: planner } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(estimateHours !== undefined ? { estimateHours } : {}),
    ...(plannedStart !== undefined ? { plannedStart } : {}),
    ...(plannedEnd !== undefined ? { plannedEnd } : {}),
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

const CONCURRENCY = 5;

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

export function createMcpOpReader(opts: { call: OpCall; contract: ZqContract; serverId?: string }): OpReader {
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

  const invisible = (e: unknown) => e instanceof OpError && (e.code === "not_found" || e.code === "404");

  return {
    async features(scanner: ScanPerson): Promise<FeatureFacts[]> {
      const rows = await pages("zq_list_work_packages", { limit: PAGE_LIMIT }, scanner.principalId);
      const found = rows.flatMap((row) => parseWorkView(row, contract) ?? []);
      const features = found.filter((w) => w.typeKey === contract.featureType);
      return mapLimited(features, async (feature) => {
        const children = found.filter((w) => w.parentId === feature.id);
        const [meetings, exit] = await Promise.all([
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
        return { feature, children, ...(meetings ? { meetings } : {}), ...(exit ? { exit } : {}) };
      });
    },
    async dutyHolders(scanner: ScanPerson, projectId: string, duty: Duty): Promise<OpUserRef[] | undefined> {
      if (!contract.tools.dutyHolders) return undefined;
      const rows = await pages(
        contract.tools.dutyHolders,
        { project_id: projectId, duty: contract.duties[duty] },
        scanner.principalId,
      );
      return rows.flatMap((r) => person(r) ?? []);
    },
  };
}
