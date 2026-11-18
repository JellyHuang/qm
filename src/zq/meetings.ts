export type OutcomeKind = "information" | "decision" | "work_package";

export interface OutcomeInput {
  agendaItemId: number;
  kind: OutcomeKind;
  notes?: string;
  workPackageId?: number;
}

export interface AgendaInput {
  meetingId: number;
  title: string;
  notes?: string;
  durationMinutes?: number;
  workPackageId?: number;
}

const TITLE_MAX = 255;
const NOTES_MAX = 50_000;
const DURATION_MAX = 1440;

export type Preview<T> = { ok: true; args: T } | { ok: false; problems: string[] };

const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function outcomePreviewArgs(input: OutcomeInput): Preview<Record<string, unknown>> {
  const problems: string[] = [];
  const notes = input.notes?.trim();
  if (!positive(input.agendaItemId)) problems.push("缺少议程项");
  if (input.kind === "information" && !notes) problems.push("「信息」类结论必须写内容");
  if (input.kind === "work_package" && !positive(input.workPackageId)) problems.push("「工单」类结论必须指定工单");
  if (notes && notes.length > NOTES_MAX) problems.push(`内容超过 ${NOTES_MAX} 字`);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    args: {
      agenda_item_id: input.agendaItemId,
      kind: input.kind,
      ...(notes ? { notes } : {}),
      ...(positive(input.workPackageId) ? { work_package_id: input.workPackageId } : {}),
      confirm: false,
    },
  };
}

export function agendaPreviewArgs(input: AgendaInput): Preview<Record<string, unknown>> {
  const problems: string[] = [];
  const title = input.title.trim();
  const notes = input.notes?.trim();
  if (!positive(input.meetingId)) problems.push("缺少会议");
  if (!title) problems.push("议程标题不能为空");
  if (title.length > TITLE_MAX) problems.push(`议程标题超过 ${TITLE_MAX} 字`);
  if (notes && notes.length > NOTES_MAX) problems.push(`备注超过 ${NOTES_MAX} 字`);
  if (
    input.durationMinutes !== undefined &&
    !(Number.isInteger(input.durationMinutes) && input.durationMinutes >= 0 && input.durationMinutes <= DURATION_MAX)
  )
    problems.push(`时长必须是 0 到 ${DURATION_MAX} 分钟`);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    args: {
      meeting_id: input.meetingId,
      title,
      ...(notes ? { notes } : {}),
      ...(input.durationMinutes === undefined ? {} : { duration_in_minutes: input.durationMinutes }),
      ...(positive(input.workPackageId) ? { item_type: "work_package", work_package_id: input.workPackageId } : {}),
      confirm: false,
    },
  };
}

export interface PreviewResult {
  ready: boolean;
  problems: string[];
}

export async function previewMeetingWrite(
  call: (tool: string, args: Record<string, unknown>) => Promise<string>,
  tool: "openproject_create_meeting_outcome" | "openproject_create_meeting_agenda_item",
  built: Preview<Record<string, unknown>>,
): Promise<PreviewResult> {
  if (!built.ok) return { ready: false, problems: built.problems };
  const body = JSON.parse(await call(tool, { ...built.args, confirm: false })) as {
    state?: unknown;
    ready?: unknown;
    validation_errors?: unknown;
  };
  const errors =
    body.validation_errors && typeof body.validation_errors === "object"
      ? Object.entries(body.validation_errors as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`)
      : [];
  return { ready: body.state === "preview" && body.ready === true && errors.length === 0, problems: errors };
}
