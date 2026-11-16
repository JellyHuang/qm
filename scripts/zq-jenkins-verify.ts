import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createJenkinsClient } from "../src/zq/jenkins/client.ts";
import { createJenkinsRerunner, type JenkinsRerunRow } from "../src/zq/jenkins/rerun.ts";

const JOB = "LLM-Wiki";

function memoryMap(): DurableMap<JenkinsRerunRow> {
  const rows = new Map<string, JenkinsRerunRow>();
  return {
    all: async () => [...rows.values()],
    get: async (id: string) => rows.get(id) ?? null,
    insertIfAbsent: async (id: string, value: JenkinsRerunRow) => {
      if (rows.has(id)) return false;
      rows.set(id, value);
      return true;
    },
    merge: async (id: string, patch: Partial<JenkinsRerunRow>) => {
      const row = rows.get(id);
      if (!row) return null;
      const next = { ...row, ...patch };
      rows.set(id, next);
      return next;
    },
  } as unknown as DurableMap<JenkinsRerunRow>;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const client = createJenkinsClient({
    baseUrl: required("ZQ_JENKINS_URL"),
    user: required("ZQ_JENKINS_USER"),
    password: required("ZQ_JENKINS_PASSWORD"),
    jobs: [JOB],
  });
  const raw = process.env.ZQ_JENKINS_VERIFY_BUILD?.trim();
  if (!raw) {
    const latest = (await client.recentBuilds(JOB)).find((b) => !b.building && b.result === "FAILURE");
    if (!latest) {
      console.log(`no finished FAILURE build among the most recent ${JOB} builds`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `latest failed build: #${latest.number} parameters=${latest.params.length} masked=${latest.maskedParams.length}`,
    );
    console.log(`parameter names: ${[...latest.params.map((p) => p.name), ...latest.maskedParams].join(", ")}`);
    return;
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("ZQ_JENKINS_VERIFY_BUILD must be a build number");
  if (process.env.ZQ_JENKINS_CONFIRM?.trim() !== `rerun ${JOB} #${number}`)
    throw new Error(`set ZQ_JENKINS_CONFIRM to "rerun ${JOB} #${number}" to send the one rerun`);
  const rerunner = createJenkinsRerunner({
    client,
    map: memoryMap(),
    enabled: true,
    jobs: [JOB],
    hourlyCap: 1,
  });
  const result = await rerunner.rerun(JOB, number);
  console.log(result.status === "skipped" ? `skipped: ${result.reason}` : JSON.stringify(result));
  if (result.status !== "started") {
    process.exitCode = 1;
    return;
  }
  const created = await client.build(JOB, result.row.newBuildNumber ?? 0);
  console.log(
    `rerun #${result.row.newBuildNumber}: parameters=${created?.params.length ?? "unreadable"} differences=${result.row.parameterDifferences?.join(",") || "none"}`,
  );
}

main().catch((e: unknown) => {
  console.error(`verify failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
