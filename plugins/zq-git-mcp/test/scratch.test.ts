import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { join } from "node:path";
import { sleep } from "../src/async.ts";
import { DiskSpaceLowError, createScratch } from "../src/scratch.ts";
import { makeRoot } from "./support/fixtures.ts";

const { root, cleanup } = makeRoot("zqgit-scratch-");
after(cleanup);
let counter = 0;

function scratchAt(overrides: Partial<Parameters<typeof createScratch>[0]> = {}) {
  const dir = join(root, `scratch-${counter++}`);
  return {
    dir,
    scratch: createScratch({ dir, capBytes: 1_000_000, floorBytes: 0, maxJobs: 2, pollMs: 10, ...overrides }),
  };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

test("each job gets its own directory named for the owner pid and it is removed when the job ends", async () => {
  const { dir, scratch } = scratchAt();
  let jobDir = "";
  await scratch.job(async (job) => {
    jobDir = job.dir;
    assert.ok(job.dir.startsWith(dir));
    assert.match(job.dir.slice(dir.length + 1), new RegExp(`^${process.pid}-`));
    writeFileSync(join(job.dir, "x"), "data");
  });
  assert.equal(existsSync(jobDir), false);
  await assert.rejects(
    scratch.job(async (job) => {
      jobDir = job.dir;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(existsSync(jobDir), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("at most the configured number of heavy jobs run at once", async () => {
  const { scratch } = scratchAt({ maxJobs: 2 });
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      scratch.job(async () => {
        peak = Math.max(peak, ++running);
        await sleep(30);
        running--;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test("a new job queues while scratch use is at the cap and starts once space is freed", async () => {
  const { scratch } = scratchAt({ capBytes: 1000 });
  const release = gate();
  const first = scratch.job(async (job) => {
    writeFileSync(join(job.dir, "big"), Buffer.alloc(2000));
    await release.promise;
  });
  await sleep(50);
  let second = "waiting";
  const queued = scratch.job(async () => {
    second = "ran";
  });
  await sleep(150);
  assert.equal(second, "waiting");
  release.open();
  await first;
  await queued;
  assert.equal(second, "ran");
});

test("below the free-space floor a new job is refused with a clear disk space low error", async () => {
  const { scratch } = scratchAt({ floorBytes: 1000, freeBytes: async () => 10 });
  await assert.rejects(
    scratch.job(async () => "never"),
    (e) => e instanceof DiskSpaceLowError && e.message === "disk space low",
  );
});

test("when space drops below the floor only the newest running job is terminated", async () => {
  let free = 10_000;
  const { scratch } = scratchAt({ floorBytes: 1000, freeBytes: async () => free });
  const release = gate();
  const older = scratch.job(async (job) => {
    await release.promise;
    return job.signal.aborted;
  });
  await sleep(30);
  const newer = scratch.job(
    (job) =>
      new Promise<string>((_resolve, reject) => {
        job.signal.addEventListener("abort", () => reject(job.signal.reason), { once: true });
      }),
  );
  await sleep(30);
  free = 100;
  await scratch.enforceFloor();
  await assert.rejects(newer, (e) => e instanceof DiskSpaceLowError);
  free = 10_000;
  release.open();
  assert.equal(await older, false);
});

test("the startup sweep removes directories of dead owners and keeps live and own ones", async () => {
  const { dir, scratch } = scratchAt();
  const dead = spawnSync("true").pid ?? 0;
  assert.ok(dead > 0);
  const names = [`${dead}-aaa`, "junk", `${process.pid}-own`, `${process.ppid}-parent`];
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "f"), "x");
  }
  assert.equal(await scratch.sweep(), 2);
  assert.deepEqual(readdirSync(dir).sort(), [`${process.pid}-own`, `${process.ppid}-parent`].sort());
});
