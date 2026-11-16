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

export interface JenkinsParam {
  name: string;
  value: string;
}

export interface JenkinsBuild {
  number: number;
  building: boolean;
  result: string | null;
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
  recentBuilds(job: string): Promise<JenkinsBuild[]>;
  queued(job: string): Promise<JenkinsQueued[]>;
  startedNumber(queueId: number): Promise<number | null>;
  rerun(job: string, params: readonly JenkinsParam[]): Promise<JenkinsStarted>;
}

export class JenkinsRefused extends Error {}

interface RawParam {
  _class?: string;
  name?: string;
  value?: unknown;
}

interface RawBuild {
  number?: number;
  building?: boolean;
  result?: string | null;
  actions?: Array<{ parameters?: RawParam[] }>;
}

const BUILD_TREE = "number,building,result,actions[parameters[_class,name,value]]";

function readParams(raw: RawBuild): Pick<JenkinsBuild, "params" | "maskedParams"> {
  const params: JenkinsParam[] = [];
  const maskedParams: string[] = [];
  for (const action of raw.actions ?? []) {
    for (const p of action.parameters ?? []) {
      if (typeof p.name !== "string") continue;
      const masked = /Password/i.test(p._class ?? "") || p.value === undefined || p.value === null;
      if (masked) maskedParams.push(p.name);
      else params.push({ name: p.name, value: typeof p.value === "string" ? p.value : String(p.value) });
    }
  }
  return { params, maskedParams };
}

function toBuild(raw: RawBuild): JenkinsBuild {
  return {
    number: Number(raw.number),
    building: raw.building === true,
    result: raw.result ?? null,
    ...readParams(raw),
  };
}

export function createJenkinsClient(deps: {
  baseUrl: string;
  user: string;
  password: string;
  jobs?: readonly string[];
  fetch?: typeof fetch;
}): JenkinsClient {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const jobs = new Set(deps.jobs ?? JENKINS_JOBS);
  const send = deps.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${deps.user}:${deps.password}`).toString("base64")}`;

  function checked(job: string): string {
    if (!jobs.has(job)) throw new JenkinsRefused(`job is not on the Jenkins whitelist: ${job}`);
    return `${base}/job/${encodeURIComponent(job)}`;
  }

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await send(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...(init.headers as Record<string, string> | undefined), authorization },
    });
    return res;
  }

  async function getJson<T>(url: string): Promise<T | null> {
    const res = await request(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Jenkins answered ${res.status} for a read`);
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
      return (raw?.builds ?? []).map(toBuild);
    },
    async queued(job) {
      checked(job);
      const tree = "items[task[name],actions[parameters[_class,name,value]]]";
      const raw = await getJson<{ items?: Array<{ task?: { name?: string }; actions?: RawBuild["actions"] }> }>(
        `${base}/queue/api/json?tree=${encodeURIComponent(tree)}`,
      );
      return (raw?.items ?? [])
        .filter((item) => item.task?.name === job)
        .map((item) => ({ params: readParams({ actions: item.actions }).params }));
    },
    async startedNumber(queueId) {
      const raw = await getJson<{ executable?: { number?: number } }>(`${base}/queue/item/${queueId}/api/json`);
      return raw?.executable?.number ?? null;
    },
    async rerun(job, params) {
      const root = checked(job);
      const crumbRes = await request(`${base}/crumbIssuer/api/json`);
      if (!crumbRes.ok) throw new Error(`Jenkins refused a crumb: ${crumbRes.status}`);
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
      if (res.status !== 201) throw new Error(`Jenkins answered ${res.status} to the rerun request`);
      const queueId = /\/queue\/item\/(\d+)\/?$/.exec(res.headers.get("location") ?? "")?.[1];
      if (!queueId) throw new Error("Jenkins did not return a queue item for the rerun");
      return { queueId: Number(queueId) };
    },
  };
}
