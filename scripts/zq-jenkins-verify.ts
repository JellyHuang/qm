import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createJenkinsClient } from "../src/zq/jenkins/client.ts";
import { createJenkinsRerunner, type JenkinsRerunRow } from "../src/zq/jenkins/rerun.ts";

const SANDBOX = "qm-rerun-sandbox";

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
  const number = Number(required("ZQ_JENKINS_VERIFY_BUILD"));
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("ZQ_JENKINS_VERIFY_BUILD must be a build number");
  const client = createJenkinsClient({
    baseUrl: required("ZQ_JENKINS_URL"),
    user: required("ZQ_JENKINS_USER"),
    password: required("ZQ_JENKINS_PASSWORD"),
    jobs: [SANDBOX],
  });
  const original = await client.build(SANDBOX, number);
  if (!original) throw new Error(`${SANDBOX} #${number} was not found`);
  console.log(
    `original #${number}: result=${original.result ?? "none"} building=${original.building} parameters=${original.params.length} masked=${original.maskedParams.length}`,
  );
  const rerunner = createJenkinsRerunner({
    client,
    map: memoryMap(),
    enabled: true,
    jobs: [SANDBOX],
    hourlyCap: 1,
  });
  const result = await rerunner.rerun(SANDBOX, number);
  console.log(JSON.stringify(result));
  if (result.status === "started") {
    const created = await client.build(SANDBOX, result.row.newBuildNumber ?? 0);
    console.log(
      `rerun #${result.row.newBuildNumber}: parameters=${created?.params.length ?? "unreadable"} differences=${result.row.parameterDifferences?.length ?? 0}`,
    );
  }
  const again = await rerunner.rerun(SANDBOX, number);
  console.log(`second attempt: ${JSON.stringify(again)}`);
  if (result.status !== "started" || again.status !== "skipped") process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`verify failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
