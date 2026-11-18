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
  projectName?: string;
  assignee?: OpUserRef;
  responsiblePlanner?: OpUserRef;
  planners?: OpUserRef[];
  participants?: OpUserRef[];
  pm?: OpUserRef;
  reviewer?: OpUserRef;
  qaOwner?: OpUserRef;
  acceptor?: OpUserRef;
  regressionOwner?: OpUserRef;
  dueAt?: number;
  estimateHours?: number;
  plannedStart?: number;
  plannedEnd?: number;
  delayMarked?: boolean;
  delayedSince?: number;
  blocking?: boolean;
  awaited?: AwaitedChild[];
  awaitingNote?: string;
  completionSubmitted?: boolean;
  completionSubmittedAt?: number;
  closed?: boolean;
}

export interface AwaitedChild {
  id: number;
  typeKey: string;
  stageKey: string;
  owner?: OpUserRef;
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
  bugs?: WorkView[];
  meetings?: MeetingView[];
  exit?: ExitCheck;
}

export type Target = Recipient | { kind: "user"; user: OpUserRef };

export type RuleId =
  | "planner-unassigned"
  | "review-pending"
  | "staffing-trades"
  | "briefing-meeting-missing"
  | "meeting-follow-up"
  | "production-missing-plan"
  | "task-overdue"
  | "task-overdue-escalation"
  | "task-unassigned"
  | "optimization-unassigned"
  | "optimization-children-done"
  | "optimization-completion-submitted"
  | "production-missing-planned-end"
  | "blocking-bug-open"
  | "delay-notice"
  | "exit-ready"
  | "formal-assets-pending"
  | "assignee-unconfirmed"
  | "bug-unassigned"
  | "responsibility-not-set";

export interface RuleAction {
  rule: RuleId;
  subjectId: string;
  subjectTitle: string;
  to: Target[];
  text: string;
  once?: boolean;
}

export interface RuleOptions {
  now: number;
  day: (at: number) => string;
  meetingGraceMs: number;
  escalateAfterMs: number;
  escalationDuties: readonly Duty[];
  unsetDuties: readonly Duty[];
}

const DAY = 86_400_000;
export const DEFAULT_RULE_OPTIONS = {
  day: (at: number) => new Date(at).toISOString().slice(0, 10),
  meetingGraceMs: 10 * 60_000,
  escalateAfterMs: 2 * DAY,
  escalationDuties: [] as readonly Duty[],
  unsetDuties: [] as readonly Duty[],
};

const label = (contract: ZqContract, key: string) => contract.stages.feature[key] ?? contract.stages.task[key] ?? key;
const where = (w: WorkView) => `「${w.subject}」(#${w.id})`;
const active = (w: WorkView) => !paused(w.lifecycle);

export function peopleOn(w: WorkView, field: PersonField): OpUserRef[] {
  if (field === "responsiblePlanner" && w.planners?.length) return w.planners;
  return w[field] ? [w[field]!] : [];
}

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
  reviewer: "制作人",
  qaOwner: "QA 确认人",
  acceptor: "验收人",
  regressionOwner: "回归确认人",
};

const leadsOf = (contract: ZqContract, typeKey: string): Target[] =>
  (contract.typeLeads[typeKey] ?? []).map((user): Target => ({ kind: "user", user }));

const fallbackLead = (contract: ZqContract): Target[] =>
  contract.defaultLead ? [{ kind: "user", user: contract.defaultLead }] : [];

function unassignedDispatch(
  children: readonly WorkView[],
  contract: ZqContract,
): Array<{ to: Target[]; list: WorkView[] }> {
  const dispatch = new Map<string, { to: Target[]; list: WorkView[] }>();
  for (const c of children.filter(
    (c) => active(c) && c.statusKey === contract.stageRoles.taskUnassigned && !c.assignee,
  )) {
    const owner = contract.typeOwners[c.typeKey];
    const person = owner?.kind === "taskField" ? c[owner.field] : undefined;
    const leads = leadsOf(contract, c.typeKey);
    const own: Target[] = person ? [{ kind: "user", user: person }] : [];
    if (owner?.kind === "duty") own.splice(0, own.length, { kind: "duty", duty: owner.duty });
    const to = [leads, own, fallbackLead(contract)].find((list) => list.length) ?? [];
    if (!to.length) continue;
    const key = to
      .map((t) => (t.kind === "duty" ? `duty:${t.duty}` : `user:${t.kind === "user" ? t.user.id : ""}`))
      .join("+");
    dispatch.set(key, { to, list: [...(dispatch.get(key)?.list ?? []), c] });
  }
  return [...dispatch.values()];
}

function optimizationRules(
  feature: WorkView,
  children: readonly WorkView[],
  planner: Target[],
  contract: ZqContract,
  opts: RuleOptions,
): RuleAction[] {
  const done = contract.stageRoles.taskDone;
  if (!active(feature) || feature.statusKey === done) return [];
  const at = (rule: RuleId, to: Target[], text: string, subject: WorkView = feature): RuleAction => ({
    rule,
    subjectId: `wp:${subject.id}`,
    subjectTitle: subject.subject,
    to,
    text,
  });
  const live = children.filter(active);
  const out: RuleAction[] = [];
  if (!live.length && !feature.assignee && feature.statusKey === contract.stageRoles.taskUnassigned)
    out.push(
      at(
        "optimization-unassigned",
        leadsOf(contract, feature.typeKey).length ? leadsOf(contract, feature.typeKey) : planner,
        `优化单${where(feature)}还没有指派。请写明优化内容并指派:一个人处理就直接指派给他,多人处理请按专业增加子单。`,
      ),
    );
  for (const { to, list } of unassignedDispatch(children, contract))
    out.push(
      at(
        "task-unassigned",
        to,
        `优化单${where(feature)}有 ${list.length} 张子单还没有指定执行人:${list.map(where).join("、")}。请指派。`,
      ),
    );
  for (const c of live.length ? live : [feature]) {
    if (!isOpen(contract, c) || c.completionSubmitted || !c.assignee || c.dueAt === undefined || opts.now <= c.dueAt)
      continue;
    const days = Math.floor((opts.now - c.dueAt) / DAY);
    out.push(
      at(
        "task-overdue",
        [{ kind: "user", user: c.assignee }],
        `${where(c)}已超过计划结束时间 ${days} 天。请说明进度、风险和阻塞。`,
        c,
      ),
    );
  }
  if (!live.length && feature.completionSubmitted)
    out.push({
      ...at(
        "optimization-completion-submitted",
        planner,
        `优化单${where(feature)}的执行人${feature.assignee ? ` ${feature.assignee.name} ` : ""}已提交完成确认。请验收,通过后把它转为「${label(contract, done)}」。`,
      ),
      subjectId: `wp:${feature.id}${feature.completionSubmittedAt === undefined ? "" : `:submitted:${feature.completionSubmittedAt}`}`,
      once: true,
    });
  if (live.length && live.every((c) => c.statusKey === done))
    out.push({
      ...at(
        "optimization-children-done",
        planner,
        `优化单${where(feature)}的 ${live.length} 张子单都已完成。请确认效果后关闭这张优化单。`,
      ),
      once: true,
    });
  return out;
}

function evaluateOptimization(facts: FeatureFacts, contract: ZqContract, opts: RuleOptions): RuleAction[] {
  return optimizationRules(
    facts.feature,
    facts.children,
    [{ kind: "field", field: "responsiblePlanner" }],
    contract,
    opts,
  );
}

function evaluateStage(facts: FeatureFacts, contract: ZqContract, opts: RuleOptions): RuleAction[] {
  const { feature } = facts;
  if (feature.typeKey !== contract.featureType || !active(feature)) return [];
  const optimizations = facts.children.filter((c) => c.typeKey === contract.optimizationType);
  const attached = new Set(optimizations.map((o) => o.id));
  const children = facts.children.filter(
    (c) => c.typeKey !== contract.optimizationType && !attached.has(c.parentId ?? -1),
  );
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

  const planners = peopleOn(feature, "responsiblePlanner");
  const finished = feature.closed === true || feature.statusKey === contract.stageRoles.featureDone;
  if (planners.length > 0 && !feature.assignee && !finished)
    out.push({
      ...at(
        "assignee-unconfirmed",
        [{ kind: "field", field: "reviewer" }],
        `功能${where(feature)}还没有受理人。负责策划:${planners.map((u) => u.name).join("、")}。请确认哪一位作为总单受理人。`,
      ),
      subjectId: `wp:${feature.id}:assignee:${planners.map((u) => u.id).join(",")}`,
      once: true,
    });

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
  }

  for (const { to, list } of unassignedDispatch(children, contract))
    out.push(
      at(
        "task-unassigned",
        to,
        `功能${where(feature)}在「${stageName}」,有 ${list.length} 张执行单还没有指定执行人:${list.map(where).join("、")}。请指派。`,
      ),
    );

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
    if (feature.plannedEnd === undefined)
      out.push(
        at(
          "production-missing-planned-end",
          [{ kind: "field", field: "responsiblePlanner" }],
          `功能${where(feature)}在「${stageName}」,总单还没有计划结束时间。请补填。`,
        ),
      );
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

  if (facts.exit?.ready && !contract.autoAdvanceStages.includes(stage))
    out.push(
      at(
        "exit-ready",
        stageOwners(contract, stage),
        `功能${where(feature)}已满足「${stageName}」的出口条件,请确认是否推进。`,
      ),
    );

  const closed = contract.stageRoles.bugClosed;
  for (const bug of (facts.bugs ?? []).filter((b) => active(b) && b.blocking && b.statusKey !== closed)) {
    const to: Target[] = [
      ...(bug.assignee ? [{ kind: "user", user: bug.assignee } as Target] : []),
      ...((bug.qaOwner ?? feature.qaOwner)
        ? [{ kind: "user", user: (bug.qaOwner ?? feature.qaOwner)! } as Target]
        : []),
    ];
    out.push(
      at(
        "blocking-bug-open",
        to,
        `阻断 BUG ${where(bug)}(功能${where(feature)})还没有关闭,功能不能完成。请跟进修复和复测。`,
        bug,
      ),
    );
  }

  for (const bug of (facts.bugs ?? []).filter((b) => active(b) && !b.assignee && b.statusKey !== closed)) {
    const leads = leadsOf(contract, bug.typeKey);
    const to = leads.length ? leads : fallbackLead(contract);
    if (to.length)
      out.push(at("bug-unassigned", to, `BUG ${where(bug)}(功能${where(feature)})还没有指定处理人。请指派。`, bug));
  }

  if (feature.delayMarked) {
    const since = feature.delayedSince;
    out.push({
      ...at(
        "delay-notice",
        [
          { kind: "field", field: "responsiblePlanner" },
          { kind: "field", field: "pm" },
        ],
        `功能${where(feature)}在「${stageName}」已被标记延期${since === undefined ? "" : `(自 ${opts.day(since)} 起)`}。请确认新的计划和影响。`,
      ),
      subjectId: `wp:${feature.id}:delay:${since ?? "unknown"}`,
      once: true,
    });
  }

  if (stage === r.formalAssets) {
    const awaited = feature.awaited ?? [];
    const byOwner = new Map<string, { owner: OpUserRef; ids: number[] }>();
    for (const c of awaited)
      if (c.owner) byOwner.set(c.owner.id, { owner: c.owner, ids: [...(byOwner.get(c.owner.id)?.ids ?? []), c.id] });
    for (const { owner, ids } of byOwner.values())
      out.push(
        at(
          "formal-assets-pending",
          [{ kind: "user", user: owner }],
          `功能${where(feature)}在「${stageName}」,你还有 ${ids.length} 张执行单未完成:${ids.map((id) => `#${id}`).join("、")}。`,
        ),
      );
    if (awaited.length)
      out.push(
        at(
          "formal-assets-pending",
          [{ kind: "field", field: "pm" }],
          feature.awaitingNote ??
            `功能${where(feature)}在「${stageName}」,还有 ${awaited.length} 张执行单未完成:${awaited.map((c) => `#${c.id}`).join("、")}。`,
        ),
      );
  }
  for (const o of optimizations)
    out.push(
      ...optimizationRules(
        o,
        facts.children.filter((c) => c.parentId === o.id),
        o.responsiblePlanner
          ? peopleOn(o, "responsiblePlanner").map((user): Target => ({ kind: "user", user }))
          : [{ kind: "field", field: "responsiblePlanner" }],
        contract,
        opts,
      ),
    );
  return out;
}

export function evaluateRules(facts: FeatureFacts, contract: ZqContract, opts: RuleOptions): RuleAction[] {
  const actions =
    contract.optimizationType !== undefined && facts.feature.typeKey === contract.optimizationType
      ? evaluateOptimization(facts, contract, opts)
      : evaluateStage(facts, contract, opts);
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
      text: `${feature.typeKey === contract.optimizationType ? "优化单" : "功能"}「${feature.subject}」(#${feature.id})在「${label(contract, feature.statusKey)}」需要${FIELD_LABEL[field]},但还没有设置。请设置。`,
    })),
  ].filter((a) => a.rule === "responsibility-not-set" || a.to.length > 0);
}
