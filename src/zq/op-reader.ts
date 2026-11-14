import type { MeetingState } from "./follow-up-rules.ts";
import type { OpReader, ScanPerson, ScannedWorkPackage } from "./scanner.ts";

export type OpCall = (tool: string, args: Record<string, unknown>, principalId: string) => Promise<string>;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function items(text: string, key: string): Json[] {
  const parsed: unknown = JSON.parse(text);
  const list = isObject(parsed) ? (parsed[key] ?? parsed["items"]) : parsed;
  if (!Array.isArray(list)) throw new Error(`OpenProject returned no ${key} list`);
  return list.filter(isObject);
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isObject(value)) return str(value["key"] ?? value["name"] ?? value["id"]);
  return undefined;
}

function time(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

function workPackage(item: Json): ScannedWorkPackage | undefined {
  const id = Number(item["id"]);
  const status = str(item["status"]);
  const updatedAt = time(item["updated_at"]);
  if (!Number.isSafeInteger(id) || !status || updatedAt === undefined) return undefined;
  const assignee = item["assignee"];
  const dueAt = time(item["due_date"]);
  const fields = isObject(item["custom_fields"]) ? item["custom_fields"] : {};
  return {
    id,
    subject: str(item["subject"]) ?? `#${id}`,
    status,
    updatedAt,
    statusChangedAt: time(item["status_changed_at"]) ?? updatedAt,
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(isObject(assignee) && str(assignee["id"]) ? { assigneeOpUserId: str(assignee["id"])! } : {}),
    ...(str(assignee) ? { assigneeName: isObject(assignee) ? str(assignee["name"]) : str(assignee) } : {}),
    fields: Object.fromEntries(
      Object.entries(fields).flatMap(([k, v]) => (str(v) !== undefined ? [[k, str(v)!]] : [])),
    ),
  };
}

function meeting(item: Json): MeetingState | undefined {
  const id = str(item["id"]);
  const endAt = time(item["end_time"]);
  if (!id || endAt === undefined) return undefined;
  const planner = item["organizer"] ?? item["planner"];
  return {
    id,
    title: str(item["title"]) ?? `meeting ${id}`,
    endAt,
    state: str(item["state"]) ?? str(item["status"]) ?? "open",
    ...(isObject(planner) && str(planner["id"]) ? { plannerOpUserId: str(planner["id"])! } : {}),
    ...(str(planner) ? { plannerName: isObject(planner) ? str(planner["name"]) : str(planner) } : {}),
  };
}

export function createMcpOpReader(opts: { call: OpCall; serverId?: string }): OpReader {
  const tool = (name: string) => `${opts.serverId ?? "openproject"}_${name}`;
  return {
    async workPackages(person: ScanPerson) {
      const text = await opts.call(tool("list_work_packages"), { assignee: "me" }, person.principalId);
      return items(text, "work_packages").flatMap((i) => workPackage(i) ?? []);
    },
    async meetings(person: ScanPerson) {
      const text = await opts.call(tool("list_meetings"), {}, person.principalId);
      return items(text, "meetings").flatMap((i) => meeting(i) ?? []);
    },
  };
}
