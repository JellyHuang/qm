import { paused, type Duty, type Lifecycle, type PersonField, type Recipient, type ZqContract } from "./contract.ts";

export interface OpUserRef {
  id: string;
  name: string;
  login?: string;
}

export interface WorkView {
  id: number;
  subject: string;
  typeKey: string;
  statusKey: string;
  lifecycle?: Lifecycle;
  statusChangedAt?: number;
  parentId?: number;
  projectId?: string;
  assignee?: OpUserRef;
  responsiblePlanner?: OpUserRef;
  pm?: OpUserRef;
  reviewer?: OpUserRef;
  qaOwner?: OpUserRef;
  acceptor?: OpUserRef;
  regressionOwner?: OpUserRef;
  dueAt?: number;
  estimateHours?: number;
  plannedStart?: number;
  plannedEnd?: number;
}

export interface MeetingView {
  id: string;
  title: string;
  endAt: number;
  state: string;
}

export interface ExitCheck {
  ready: boolean;
  blockers: string[];
}

export interface FeatureFacts {
  feature: WorkView;
  children: WorkView[];
  meetings?: MeetingView[];
  exit?: ExitCheck;
}

export type Target = Recipient | { kind: "user"; user: OpUserRef };

export type RuleId =
  | "planner-unassigned"
  | "review-pending"
  | "staffing-trades"
  | "staffing-assign"
  | "briefing-meeting-missing"
  | "meeting-follow-up"
  | "production-missing-plan"
  | "task-overdue"
  | "task-overdue-escalation"
  | "exit-ready"
  | "formal-assets-pending"
  | "responsibility-not-set";

export interface RuleAction {
  rule: RuleId;
  subjectId: string;
  subjectTitle: string;
  to: Target[];
  text: string;
}

export interface RuleOptions {
  now: number;
  meetingGraceMs: number;
  escalateAfterMs: number;
  escalationDuties: readonly Duty[];
  unsetDuties: readonly Duty[];
}

const DAY = 86_400_000;
export const DEFAULT_RULE_OPTIONS = {
  meetingGraceMs: 10 * 60_000,
  escalateAfterMs: 2 * DAY,
  escalationDuties: [] as readonly Duty[],
  unsetDuties: [] as readonly Duty[],
};

const label = (contract: ZqContract, key: string) => contract.stages.feature[key] ?? contract.stages.task[key] ?? key;
const where = (w: WorkView) => `「${w.subject}」(#${w.id})`;
const active = (w: WorkView) => !paused(w.lifecycle);

const isOpen = (contract: ZqContract, w: WorkView) => w.statusKey !== contract.stageRoles.taskDone && active(w);

function stageOwners(contract: ZqContract, stage: string): Target[] {
  return [...(contract.stageOwners[stage] ?? [])];
}

function missingPlan(w: WorkView): string[] {
  return [
    ...(w.estimateHours === undefined ? ["预计工时"] : []),
    ...(w.plannedStart === undefined ? ["计划开始时间"] : []),
    ...(w.plannedEnd === undefined ? ["计划结束时间"] : []),
  ];
}

const FIELD_LABEL: Record<PersonField, string> = {
  responsiblePlanner: "负责策划",
  pm: "PM",
  reviewer: "审核人",
  qaOwner: "QA 确认人",
  acceptor: "验收人",
  regressionOwner: "回归确认人",
};

function evaluateStage(facts: FeatureFacts, contract: ZqContract, opts: RuleOptions): RuleAction[] {
  const { feature, children } = facts;
  if (feature.typeKey !== contract.featureType || !active(feature)) return [];
  const at = (rule: RuleId, to: Target[], text: string, subject: WorkView = feature): RuleAction => ({
    rule,
    subjectId: `wp:${subject.id}`,
    subjectTitle: subject.subject,
    to,
    text,
  });
  const stage = feature.statusKey;
  const r = contract.stageRoles;
  const stageName = label(contract, stage);
  const out: RuleAction[] = [];

  if (stage === r.plannerUnassigned)
    out.push(
      at(
        "planner-unassigned",
        stageOwners(contract, stage),
        `功能${where(feature)}还在「${stageName}」,请指定负责策划。`,
      ),
    );

  if (stage === r.reviewPending)
    out.push(
      at("review-pending", stageOwners(contract, stage), `功能${where(feature)}的策划案等待审核,请审核通过或退回。`),
    );

  if (stage === r.staffing) {
    const planner: Target[] = [{ kind: "field", field: "responsiblePlanner" }];
    const live = children.filter(active);
    if (!live.length)
      out.push(
        at(
          "staffing-trades",
          planner,
          `功能${where(feature)}在「${stageName}」,还没有专业执行单。请确认本功能需要哪些专业和交付项。`,
        ),
      );
    const pending = live.filter((c) => c.statusKey === r.taskUnassigned);
    const byDuty = new Map<Duty, WorkView[]>();
    for (const c of pending) {
      const duty = contract.typeDuties[c.typeKey];
      if (duty) byDuty.set(duty, [...(byDuty.get(duty) ?? []), c]);
    }
    for (const [duty, list] of byDuty)
      out.push(
        at(
          "staffing-assign",
          [{ kind: "duty", duty }],
          `功能${where(feature)}有 ${list.length} 张执行单还没有指定执行人:${list.map(where).join("、")}。请指派。`,
        ),
      );
  }

  if (stage === r.briefing && facts.meetings) {
    const valid = facts.meetings.filter((m) => m.state.trim().toLowerCase() !== "cancelled");
    if (!valid.length)
      out.push(
        at(
          "briefing-meeting-missing",
          [{ kind: "field", field: "responsiblePlanner" }],
          `功能${where(feature)}在「${stageName}」,OpenProject 里还没有宣讲会议。请安排会议。`,
        ),
      );
    for (const m of valid) {
      if (m.state.trim().toLowerCase() === "closed" || opts.now < m.endAt + opts.meetingGraceMs) continue;
      out.push({
        rule: "meeting-follow-up",
        subjectId: `meeting:${m.id}`,
        subjectTitle: m.title,
        to: [{ kind: "field", field: "responsiblePlanner" }],
        text: `宣讲会议「${m.title}」(功能${where(feature)})已过计划结束时间,OpenProject 里还没有关闭。会议是否已结束?请补充摘要、决定和待办。`,
      });
    }
  }

  if (stage === r.inProduction) {
    for (const c of children.filter((c) => isOpen(contract, c))) {
      const missing = missingPlan(c);
      if (missing.length && c.assignee)
        out.push(
          at(
            "production-missing-plan",
            [{ kind: "user", user: c.assignee }],
            `${where(c)}(功能${where(feature)})缺少:${missing.join("、")}。请补填,或说明不适用。`,
            c,
          ),
        );
      if (c.dueAt !== undefined && opts.now > c.dueAt) {
        const days = Math.floor((opts.now - c.dueAt) / DAY);
        if (c.assignee)
          out.push(
            at(
              "task-overdue",
              [{ kind: "user", user: c.assignee }],
              `${where(c)}已超过计划结束时间 ${days} 天。请说明进度、风险和阻塞。`,
              c,
            ),
          );
        if (opts.escalationDuties.length && opts.now - c.dueAt >= opts.escalateAfterMs)
          out.push(
            at(
              "task-overdue-escalation",
              opts.escalationDuties.map((duty): Target => ({ kind: "duty", duty })),
              `${where(c)}(功能${where(feature)})已超过计划结束时间 ${days} 天,执行人${c.assignee ? `${c.assignee.name}` : "未指定"}。请关注。`,
              c,
            ),
          );
      }
    }
  }

  if (facts.exit?.ready)
    out.push(
      at(
        "exit-ready",
        stageOwners(contract, stage),
        `功能${where(feature)}已满足「${stageName}」的出口条件,请确认是否推进。`,
      ),
    );

  if (stage === r.formalAssets) {
    const unfinished = children.filter((c) => contract.typeDuties[c.typeKey] === "art_lead" && isOpen(contract, c));
    out.push(
      at(
        "formal-assets-pending",
        stageOwners(contract, stage),
        unfinished.length
          ? `功能${where(feature)}在「${stageName}」,还有 ${unfinished.length} 张美术单未完成:${unfinished.map(where).join("、")}。`
          : `功能${where(feature)}在「${stageName}」,美术单已全部完成,请确认资源替换和必要回归。`,
      ),
    );
  }
  return out;
}

export function evaluateRules(facts: FeatureFacts, contract: ZqContract, opts: RuleOptions): RuleAction[] {
  const actions = evaluateStage(facts, contract, opts);
  const { feature } = facts;
  const unset = new Set<PersonField>();
  for (const action of actions)
    for (const target of action.to) if (target.kind === "field" && !feature[target.field]) unset.add(target.field);
  return [
    ...actions.map((a) => ({
      ...a,
      to: a.to.filter((t) => t.kind !== "field" || feature[t.field]),
    })),
    ...[...unset].map((field): RuleAction => ({
      rule: "responsibility-not-set",
      subjectId: `wp:${feature.id}:${field}`,
      subjectTitle: feature.subject,
      to: opts.unsetDuties.map((duty): Target => ({ kind: "duty", duty })),
      text: `功能「${feature.subject}」(#${feature.id})在「${label(contract, feature.statusKey)}」需要${FIELD_LABEL[field]},但还没有设置。请设置。`,
    })),
  ].filter((a) => a.rule === "responsibility-not-set" || a.to.length > 0);
}
