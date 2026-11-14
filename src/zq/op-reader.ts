import { lifecycleOf, type Duty, type ZqContract } from "./contract.ts";
import type { ExitCheck, FeatureFacts, MeetingView, OpUserRef, WorkView } from "./rules.ts";
import type { OpReader, ScanPerson } from "./scanner.ts";

export type OpCall = (tool: string, args: Record<string, unknown>, principalId: string) => Promise<string>;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function time(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
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

function user(value: unknown): OpUserRef | undefined {
  if (!isObject(value)) return undefined;
  const id = str(value["id"]);
  const name = str(value["name"]) ?? str(value["login"]);
  const login = str(value["login"]);
  return id && name ? { id, name, ...(login ? { login } : {}) } : undefined;
}

interface Page {
  results: Json[];
  nextOffset: number | null;
}

function parsePage(text: string): Page {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed) || !Array.isArray(parsed["results"])) throw new Error("OpenProject returned no results list");
  const next = parsed["next_offset"];
  return {
    results: parsed["results"].filter(isObject),
    nextOffset: typeof next === "number" && Number.isSafeInteger(next) ? next : null,
  };
}

export function parseWorkView(text: string, contract: ZqContract): WorkView | undefined {
  const item: unknown = JSON.parse(text);
  if (!isObject(item)) return undefined;
  const id = Number(item["id"]);
  const typeKey = str(item["type_key"]);
  const statusKey = str(item["status_key"]);
  if (!Number.isSafeInteger(id) || !typeKey || !statusKey) return undefined;
  const lifecycle = lifecycleOf(item["lifecycle"]);
  const statusChangedAt = time(item["status_changed_at"]);
  const parentId = Number(item["parent_id"]);
  const projectId = str(item["project_id"]);
  const assignee = user(item["assignee"]);
  const planner = user(item[contract.fields.responsiblePlanner]);
  const dueAt = time(item["due_date"]);
  const estimateHours = hours(item[contract.fields.estimate]);
  const plannedStart = time(item[contract.fields.plannedStart]);
  const plannedEnd = time(item[contract.fields.plannedEnd]);
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
  const parsed: unknown = JSON.parse(text);
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
  const views = new Map<string, WorkView>();

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

  async function view(row: Json, principalId: string): Promise<WorkView | undefined> {
    const id = str(row["id"]);
    if (!id) return undefined;
    const stamp = `${principalId}|${id}|${str(row["updated_at"]) ?? ""}`;
    const cached = views.get(stamp);
    if (cached) return cached;
    const found = parseWorkView(
      await opts.call(tool("zq_get_work_package"), { id: Number(id) }, principalId),
      contract,
    );
    if (found) views.set(stamp, found);
    return found;
  }

  return {
    async features(person: ScanPerson): Promise<FeatureFacts[]> {
      const rows = await pages("list_work_packages", {}, person.principalId);
      const found = (await mapLimited(rows, (row) => view(row, person.principalId))).flatMap((v) => v ?? []);
      const live = new Set(rows.map((r) => `${person.principalId}|${str(r["id"])}|${str(r["updated_at"]) ?? ""}`));
      for (const key of views.keys()) if (key.startsWith(`${person.principalId}|`) && !live.has(key)) views.delete(key);
      const features = found.filter((w) => w.typeKey === contract.featureType);
      return mapLimited(features, async (feature) => {
        const children = found.filter((w) => w.parentId === feature.id);
        const [meetings, exit] = await Promise.all([
          contract.tools.meetingsForFeature
            ? pages(contract.tools.meetingsForFeature, { id: feature.id }, person.principalId).then((r) =>
                r.flatMap((m) => parseMeeting(m) ?? []),
              )
            : undefined,
          contract.tools.exitCheck
            ? opts
                .call(tool(contract.tools.exitCheck), { id: feature.id }, person.principalId)
                .then((t) => parseExit(t))
            : undefined,
        ]);
        return { feature, children, ...(meetings ? { meetings } : {}), ...(exit ? { exit } : {}) };
      });
    },
    async dutyHolders(person: ScanPerson, projectId: string, duty: Duty): Promise<OpUserRef[] | undefined> {
      if (!contract.tools.dutyHolders) return undefined;
      const rows = await pages(
        contract.tools.dutyHolders,
        { project_id: projectId, duty: contract.duties[duty] },
        person.principalId,
      );
      return rows.flatMap((r) => user(r) ?? []);
    },
  };
}
