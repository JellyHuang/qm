import { createHash } from "node:crypto";
import { errMessage } from "../../util/errors.ts";

export const JENKINS_JOBS = [
  "CheckServerConfig",
  "LLM-Wiki",
  "PackageSent",
  "Server-Build",
  "Server-Clang-Tidy",
  "Server-CodeReview",
  "Server-Config",
  "Server-Run",
] as const;

const REQUEST_TIMEOUT_MS = 30_000;
const RECENT_BUILDS = 20;
const TAIL_BYTES = 4096;

export type JenkinsCauseKind = "timer" | "scm" | "upstream" | "user" | "remote" | "other";

interface JenkinsCause {
  kind: JenkinsCauseKind;
  userId?: string;
}

export interface JenkinsParam {
  name: string;
  value: string;
}

export interface JenkinsBuild {
  number: number;
  url: string;
  building: boolean;
  result: string | null;
  timestamp: number;
  duration: number;
  causes: JenkinsCause[];
  params: JenkinsParam[];
  maskedParams: string[];
}

interface JenkinsQueued {
  params: JenkinsParam[];
}

interface JenkinsStarted {
  queueId: number;
}

export interface JenkinsClient {
  build(job: string, number: number): Promise<JenkinsBuild | null>;
  parameterNames(job: string): Promise<string[]>;
  recentBuilds(job: string): Promise<JenkinsBuild[] | null>;
  queued(job: string): Promise<JenkinsQueued[]>;
  startedNumber(queueId: number): Promise<number | null>;
  consoleTailHash(job: string, number: number): Promise<string | null>;
  rerun(job: string, params: readonly JenkinsParam[]): Promise<JenkinsStarted>;
}

export class JenkinsRefused extends Error {}

export class JenkinsHttpError extends Error {
  readonly status: number;
  constructor(status: number, what: string) {
    super(`Jenkins answered ${status} for ${what}`);
    this.status = status;
  }
}

interface RawParam {
  _class?: string;
  name?: string;
  value?: unknown;
}

interface RawCause {
  _class?: string;
  userId?: string;
}

interface RawBuild {
  number?: number;
  url?: string;
  building?: boolean;
  result?: string | null;
  timestamp?: number;
  duration?: number;
  actions?: Array<{ parameters?: RawParam[]; causes?: RawCause[] }>;
}

const BUILD_TREE =
  "number,url,building,result,timestamp,duration,actions[causes[_class,userId],parameters[_class,name,value]]";

const CAUSE_KINDS: ReadonlyArray<[RegExp, JenkinsCauseKind]> = [
  [/TimerTrigger/, "timer"],
  [/SCMTrigger/, "scm"],
  [/UpstreamCause/, "upstream"],
  [/UserIdCause|RebuildCause/, "user"],
  [/RemoteCause/, "remote"],
];

function causeKind(cls: string | undefined): JenkinsCauseKind {
  return CAUSE_KINDS.find(([pattern]) => pattern.test(cls ?? ""))?.[1] ?? "other";
}

function readParams(actions: RawBuild["actions"]): Pick<JenkinsBuild, "params" | "maskedParams"> {
  const params: JenkinsParam[] = [];
  const maskedParams: string[] = [];
  for (const action of actions ?? []) {
    for (const p of action.parameters ?? []) {
      if (typeof p.name !== "string") continue;
      const scalar = ["string", "number", "boolean"].includes(typeof p.value);
      if (/Password|File/i.test(p._class ?? "") || !scalar) maskedParams.push(p.name);
      else params.push({ name: p.name, value: String(p.value) });
    }
  }
  return { params, maskedParams };
}

function toBuild(raw: RawBuild): JenkinsBuild {
  return {
    number: Number(raw.number),
    url: raw.url ?? "",
    building: raw.building === true,
    result: raw.result ?? null,
    timestamp: Number(raw.timestamp ?? 0),
    duration: Number(raw.duration ?? 0),
    causes: (raw.actions ?? []).flatMap((a) =>
      (a.causes ?? []).map((c) => ({ kind: causeKind(c._class), ...(c.userId ? { userId: c.userId } : {}) })),
    ),
    ...readParams(raw.actions),
  };
}

export function createJenkinsClient(deps: {
  baseUrl: string;
  user: string;
  password: string;
  jobs: readonly string[];
  fetch?: typeof fetch;
}): JenkinsClient {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const jobs = new Set(deps.jobs);
  const send = deps.fetch ?? fetch;
  const basic = Buffer.from(`${deps.user}:${deps.password}`).toString("base64");
  const authorization = `Basic ${basic}`;
  const secrets = [deps.password, basic, authorization].filter(Boolean);

  const redact = (text: string): string => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);

  function checked(job: string): string {
    if (!jobs.has(job)) throw new JenkinsRefused(`job is not on the Jenkins whitelist: ${job}`);
    return `${base}/job/${encodeURIComponent(job)}`;
  }

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return send(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...(init.headers as Record<string, string> | undefined), authorization },
    }).catch((e: unknown) => {
      throw new Error(redact(errMessage(e)));
    });
  }

  async function getJson<T>(url: string): Promise<T | null> {
    const res = await request(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new JenkinsHttpError(res.status, "a read");
    return (await res.json()) as T;
  }

  return {
    async build(job, number) {
      const raw = await getJson<RawBuild>(`${checked(job)}/${number}/api/json?tree=${encodeURIComponent(BUILD_TREE)}`);
      return raw ? toBuild(raw) : null;
    },
    async parameterNames(job) {
      const tree = "property[parameterDefinitions[name]]";
      const raw = await getJson<{ property?: Array<{ parameterDefinitions?: Array<{ name: string }> }> }>(
        `${checked(job)}/api/json?tree=${encodeURIComponent(tree)}`,
      );
      return (raw?.property ?? []).flatMap((p) => (p.parameterDefinitions ?? []).map((d) => d.name));
    },
    async recentBuilds(job) {
      const tree = `builds[${BUILD_TREE}]{0,${RECENT_BUILDS}}`;
      const raw = await getJson<{ builds?: RawBuild[] }>(`${checked(job)}/api/json?tree=${encodeURIComponent(tree)}`);
      return raw ? (raw.builds ?? []).map(toBuild) : null;
    },
    async queued(job) {
      checked(job);
      const tree = "items[task[name],actions[parameters[_class,name,value]]]";
      const raw = await getJson<{ items?: Array<{ task?: { name?: string }; actions?: RawBuild["actions"] }> }>(
        `${base}/queue/api/json?tree=${encodeURIComponent(tree)}`,
      );
      return (raw?.items ?? [])
        .filter((item) => item.task?.name === job)
        .map((item) => ({ params: readParams(item.actions).params }));
    },
    async startedNumber(queueId) {
      const raw = await getJson<{ executable?: { number?: number } }>(`${base}/queue/item/${queueId}/api/json`);
      return raw?.executable?.number ?? null;
    },
    async consoleTailHash(job, number) {
      const res = await request(`${checked(job)}/${number}/consoleText`);
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new JenkinsHttpError(res.status, "a console read");
      let tail = Buffer.alloc(0);
      for await (const chunk of res.body) tail = Buffer.concat([tail, chunk as Uint8Array]).subarray(-TAIL_BYTES);
      return createHash("sha256").update(tail).digest("hex");
    },
    async rerun(job, params) {
      const root = checked(job);
      const crumbRes = await request(`${base}/crumbIssuer/api/json`);
      if (!crumbRes.ok) throw new JenkinsHttpError(crumbRes.status, "the crumb request");
      const crumb = (await crumbRes.json()) as { crumbRequestField: string; crumb: string };
      const cookie = crumbRes.headers.get("set-cookie")?.split(";")[0];
      const body = new URLSearchParams();
      for (const p of params) body.append(p.name, p.value);
      const res = await request(`${root}/${params.length > 0 ? "buildWithParameters" : "build"}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          [crumb.crumbRequestField]: crumb.crumb,
          ...(cookie ? { cookie } : {}),
        },
        body: body.toString(),
      });
      if (res.status !== 201) throw new JenkinsHttpError(res.status, "the rerun request");
      const queueId = /\/queue\/item\/(\d+)\/?$/.exec(res.headers.get("location") ?? "")?.[1];
      if (!queueId) throw new Error("Jenkins did not return a queue item for the rerun");
      return { queueId: Number(queueId) };
    },
  };
}
