import type { DurableMap } from "../../persistence/durable-map.ts";
import type { LeaderLease } from "../../persistence/leader-lease.ts";
import { claimThenBind } from "../../tenants/claim.ts";
import type { Sweeper } from "../../util/sweeper.ts";
import type { ZqConfig } from "../config.ts";
import { createPatchRetention, type PatchPackageRecord, type PatchRetention } from "./retention.ts";

const PATCH_RETENTION_TABLE = "zq_patch_packages";
const PATCH_RETENTION_LEASE = "zq:patch-retention";
const SWEEP_MS = 60 * 60_000;
const MAX_BATCHES_PER_SWEEP = 20;

export interface PatchRetentionRuntime {
  retention: PatchRetention;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPatchRetentionRuntime(deps: {
  config: Pick<ZqConfig, "patchRetention">;
  map: <T>(table: string) => DurableMap<T>;
  leaderLease: LeaderLease;
  createSweeper: (work: () => unknown, intervalMs: number, opts?: { label?: string }) => Sweeper;
  now?: () => number;
  log?: (line: string) => void;
}): PatchRetentionRuntime | undefined {
  const settings = deps.config.patchRetention;
  if (!settings) return undefined;
  const map = deps.map<PatchPackageRecord>(PATCH_RETENTION_TABLE);
  const retention = createPatchRetention({
    map,
    settings,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  const sweeper = deps.createSweeper(
    () =>
      deps.leaderLease.hold(PATCH_RETENTION_LEASE, () =>
        claimThenBind(map.claimTenants, async () => {
          for (let i = 0; i < MAX_BATCHES_PER_SWEEP; i++) {
            const { deleted, purged } = await retention.cleanup();
            if (deleted < settings.cleanupBatch && purged < settings.cleanupBatch) return;
          }
        }),
      ),
    SWEEP_MS,
    { label: "zq patch retention" },
  );
  return {
    retention,
    async start() {
      await retention.verifyDirectory();
      sweeper.start();
    },
    stop: () => sweeper.stop(),
  };
}
