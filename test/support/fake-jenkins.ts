import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeParam {
  name: string;
  value?: unknown;
  cls?: string;
}

export interface FakeCause {
  cls: string;
  userId?: string;
  userName?: string;
  upstream?: FakeCause[];
}

export const CAUSES = {
  timer: { cls: "hudson.triggers.TimerTrigger$TimerTriggerCause" },
  scm: { cls: "hudson.triggers.SCMTrigger$SCMTriggerCause" },
  upstream: { cls: "hudson.model.Cause$UpstreamCause" },
  upstreamOf: (...roots: FakeCause[]): FakeCause => ({ cls: "hudson.model.Cause$UpstreamCause", upstream: roots }),
  user: (userId: string): FakeCause => ({ cls: "hudson.model.Cause$UserIdCause", userId }),
  rebuild: (userId: string): FakeCause => ({ cls: "com.sonyericsson.rebuild.RebuildCause", userId }),
  remote: { cls: "hudson.model.Cause$RemoteCause" },
  unknown: { cls: "org.example.MysteryCause" },
} as const;

function rawCause(c: FakeCause): object {
  return {
    _class: c.cls,
    ...(c.userId ? { userId: c.userId } : {}),
    ...(c.userName ? { userName: c.userName } : {}),
    ...(c.upstream ? { upstreamCauses: c.upstream.map(rawCause) } : {}),
  };
}

export interface FakeBuildSpec {
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  duration?: number;
  causes?: FakeCause[];
  params?: FakeParam[];
  log?: string;
}

interface StoredBuild extends Required<Pick<FakeBuildSpec, "building" | "timestamp" | "duration">> {
  number: number;
  result: string | null;
  causes: FakeCause[];
  params: FakeParam[];
  log: string;
}

interface FakeJob {
  defined: string[];
  builds: Map<number, StoredBuild>;
  next: number;
}

export interface FakePost {
  path: string;
  body: string;
  crumb: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
}

export interface FakeJenkins {
  url: string;
  posts: FakePost[];
  requests: string[];
  authorizations: string[];
  addJob(name: string, defined?: string[]): void;
  addBuild(job: string, spec?: FakeBuildSpec & { number?: number }): number;
  finish(job: string, number: number, result: string): void;
  build(job: string, number: number): StoredBuild | undefined;
  options: { requireCrumb: boolean; holdQueue: boolean; rejectPosts: number | undefined; dropPostResponse: boolean };
  releaseQueue(): void;
  close(): Promise<void>;
}

export const FAKE_USER = "qm-bot";
export const FAKE_SECRET = "s3cr3t-token-value";
const CRUMB = "crumb-1";

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

export async function startFakeJenkins(opts: { now: () => number; secret?: string }): Promise<FakeJenkins> {
  const secret = opts.secret ?? FAKE_SECRET;
  const jobs = new Map<string, FakeJob>();
  const queue = new Map<number, { job: string; number: number; held: boolean; params: FakeParam[] }>();
  let nextQueue = 500;
  const fake = {
    posts: [] as FakePost[],
    requests: [] as string[],
    authorizations: [] as string[],
    options: {
      requireCrumb: true,
      holdQueue: false,
      rejectPosts: undefined as number | undefined,
      dropPostResponse: false,
    },
  };
  let origin = "";

  const store = (job: string, spec: FakeBuildSpec & { number?: number }): number => {
    const j = jobs.get(job)!;
    const number = spec.number ?? j.next;
    j.next = Math.max(j.next, number + 1);
    const result = spec.result === undefined ? "SUCCESS" : spec.result;
    j.builds.set(number, {
      number,
      result,
      building: spec.building ?? result === null,
      timestamp: spec.timestamp ?? opts.now() - 120_000,
      duration: spec.duration ?? 60_000,
      causes: spec.causes ?? [CAUSES.timer],
      params: spec.params ?? [],
      log: spec.log ?? "build log\n",
    });
    return number;
  };

  const raw = (job: string, b: StoredBuild) => ({
    number: b.number,
    url: `${origin}/job/${encodeURIComponent(job)}/${b.number}/`,
    building: b.building,
    result: b.result,
    timestamp: b.timestamp,
    duration: b.duration,
    actions: [
      { causes: b.causes.map(rawCause) },
      {
        parameters: b.params.map((p) => ({
          _class: p.cls ?? "hudson.model.StringParameterValue",
          name: p.name,
          ...("value" in p ? { value: p.value } : {}),
        })),
      },
    ],
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    fake.requests.push(`${req.method} ${path}`);
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    const authorization = req.headers.authorization;
    fake.authorizations.push(authorization ?? "");
    if (authorization !== `Basic ${Buffer.from(`${FAKE_USER}:${secret}`).toString("base64")}`)
      return json({ message: "unauthorized" }, 401);
    if (req.method === "POST") {
      const post: FakePost = {
        path,
        body: await bodyOf(req),
        crumb: req.headers["jenkins-crumb"] as string | undefined,
        authorization,
        cookie: req.headers.cookie,
      };
      fake.posts.push(post);
      if (fake.options.requireCrumb && post.crumb !== CRUMB) return json({ message: "No valid crumb" }, 403);
      if (fake.options.rejectPosts) return json({ message: "rejected" }, fake.options.rejectPosts);
      const match = /^\/job\/([^/]+)\/(build|buildWithParameters)$/.exec(path);
      const job = match ? jobs.get(match[1]!) : undefined;
      if (!match || !job) return json({}, 404);
      const params = [...new URLSearchParams(post.body)].map(([name, value]) => ({ name, value }));
      const number = store(match[1]!, {
        result: null,
        building: true,
        timestamp: opts.now(),
        duration: 0,
        causes: [CAUSES.user(FAKE_USER)],
        params,
      });
      const id = nextQueue++;
      queue.set(id, { job: match[1]!, number, held: fake.options.holdQueue, params });
      if (fake.options.dropPostResponse) return void res.destroy();
      res.writeHead(201, { location: `${origin}/queue/item/${id}/` });
      return void res.end();
    }
    if (path === "/crumbIssuer/api/json")
      return json({ crumbRequestField: "Jenkins-Crumb", crumb: CRUMB }, 200, {
        "set-cookie": "JSESSIONID=abc; Path=/",
      });
    if (path === "/api/json") return json({ jobs: [...jobs.keys()].map((name) => ({ name })) });
    if (path === "/queue/api/json")
      return json({
        items: [...queue.values()]
          .filter((q) => q.held)
          .map((q) => ({
            task: { name: q.job },
            actions: [{ parameters: q.params.map((p) => ({ _class: "hudson.model.StringParameterValue", ...p })) }],
          })),
      });
    const item = /^\/queue\/item\/(\d+)\/api\/json$/.exec(path);
    if (item) {
      const q = queue.get(Number(item[1]));
      if (!q) return json({}, 404);
      return json(q.held ? {} : { executable: { number: q.number } });
    }
    const jobMatch = /^\/job\/([^/]+)\/(.*)$/.exec(path);
    const job = jobMatch ? jobs.get(jobMatch[1]!) : undefined;
    if (!jobMatch || !job) return json({}, 404);
    const rest = jobMatch[2]!;
    if (rest === "api/json") {
      if (url.searchParams.get("tree")?.startsWith("builds"))
        return json({
          builds: [...job.builds.values()]
            .sort((a, b) => b.number - a.number)
            .slice(0, 20)
            .map((b) => raw(jobMatch[1]!, b)),
        });
      return json({ property: [{ parameterDefinitions: job.defined.map((name) => ({ name })) }] });
    }
    const one = /^(\d+)\/(api\/json|consoleText)$/.exec(rest);
    const build = one ? job.builds.get(Number(one[1])) : undefined;
    if (!one || !build) return json({}, 404);
    if (one[2] === "consoleText") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(build.log);
    }
    return json(raw(jobMatch[1]!, build));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return Object.assign(fake, {
    url: origin,
    addJob(name: string, defined: string[] = []) {
      jobs.set(name, { defined, builds: new Map(), next: 1 });
    },
    addBuild: (job: string, spec: FakeBuildSpec & { number?: number } = {}) => store(job, spec),
    finish(job: string, number: number, result: string) {
      const b = jobs.get(job)?.builds.get(number);
      if (b) Object.assign(b, { result, building: false, duration: 30_000 });
    },
    build: (job: string, number: number) => jobs.get(job)?.builds.get(number),
    releaseQueue() {
      for (const q of queue.values()) q.held = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
}
