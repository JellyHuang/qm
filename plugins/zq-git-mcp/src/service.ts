import type { AddressInfo } from "node:net";
import { swallow } from "../../chassis/src/errors.ts";
import { createMemoryAuditSink, type AuditSink, type AuditTarget } from "./audit.ts";
import { createAuditPipeline, describeFailure, type AuditAlarm, type AuditPipeline } from "./audit-pipeline.ts";
import { createBlobStore } from "./blobs.ts";
import { assertGitVersion } from "./git-version.ts";
import { createMemoryBlobMetaLedger, type BlobMetaLedger } from "./ledger.ts";
import { createMemoryTipStore, type TipStore } from "./tip-store.ts";
import { createBlobCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { createDispatcher } from "./dispatch.ts";
import { createLimiter } from "./limiter.ts";
import { createRepos } from "./repos.ts";
import { createGitRunner, killLiveGitGroups } from "./runner.ts";
import { createScratch } from "./scratch.ts";
import { createMcpHttpServer } from "./server.ts";
import { createSsh } from "./ssh.ts";
import { TOOLS } from "./tools/index.ts";

export interface Service {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export interface ServiceDeps {
  audit?: AuditSink;
  gitBinary?: string;
  tips?: TipStore;
  auditTarget?: AuditTarget;
  alarm?: AuditAlarm;
  log?: (line: string) => void;
  auditRetry?: { initialMs: number; maxMs: number };
}

export function createService(config: Config, deps: ServiceDeps = {}): Service {
  const ssh = config.ssh ? createSsh(config.ssh) : undefined;
  let audit: AuditSink = deps.audit ?? createMemoryAuditSink();
  let tips: TipStore = deps.tips ?? createMemoryTipStore();
  let ledger: BlobMetaLedger = createMemoryBlobMetaLedger();
  let pipeline: AuditPipeline | undefined;
  let database: { close(): Promise<void> } | undefined;
  const fetches = createLimiter(config.maxFetches);
  const bigFetches = createLimiter(config.maxBigFetches);
  const scratch = createScratch({
    dir: config.scratchDir,
    capBytes: config.scratchCapBytes,
    floorBytes: config.freeFloorBytes,
    maxJobs: config.maxHeavyJobs,
  });
  const cache = createBlobCache({ dir: config.cacheDir, capBytes: config.cacheCapBytes });
  let server: ReturnType<typeof createMcpHttpServer> | undefined;

  return {
    async start() {
      await assertGitVersion(createGitRunner(deps.gitBinary ? { gitBinary: deps.gitBinary } : {}));
      if (
        config.database &&
        (config.audit === "postgres" || config.tips === "postgres" || config.blobMeta === "postgres")
      ) {
        const { createDatabase } = await import("./postgres/database.ts");
        const { createPostgresAuditTarget, createPostgresBlobMetaLedger, createPostgresTipStore } =
          await import("./postgres/stores.ts");
        const db = createDatabase(config.database);
        database = db;
        await db.assertTables();
        if (config.tips === "postgres" && !deps.tips) tips = createPostgresTipStore(db);
        if (config.blobMeta === "postgres")
          ledger = createPostgresBlobMetaLedger(db, (e) =>
            (deps.log ?? console.error)(
              JSON.stringify({
                level: "error",
                component: "zq-git-mcp",
                kind: "blob_meta_write_failed",
                error: describeFailure(e),
              }),
            ),
          );
        if (config.audit === "postgres" && !deps.audit && !deps.auditTarget)
          deps = { ...deps, auditTarget: createPostgresAuditTarget(db) };
      }
      if (!deps.audit && deps.auditTarget) {
        pipeline = createAuditPipeline({
          target: deps.auditTarget,
          onFailure: config.auditOnFailure,
          spoolDir: config.auditSpoolDir,
          spoolMaxBytes: config.auditSpoolMaxBytes,
          spoolMaxAgeMs: config.auditSpoolMaxAgeMs,
          ...(deps.auditRetry ? { retryInitialMs: deps.auditRetry.initialMs, retryMaxMs: deps.auditRetry.maxMs } : {}),
          ...(deps.alarm ? { alarm: deps.alarm } : {}),
          ...(deps.log ? { log: deps.log } : {}),
        });
        audit = pipeline;
        await pipeline.start();
      }
      await ssh?.start();
      const runner = createGitRunner({
        timeoutMs: config.gitTimeoutMs,
        ...(ssh ? { sshCommand: ssh.command() } : {}),
        ...(deps.gitBinary ? { gitBinary: deps.gitBinary } : {}),
      });
      const repos = createRepos({
        runner,
        fetches,
        clonesDir: config.clonesDir,
        remoteBase: config.remoteBase,
        refreshMs: config.refreshMs,
        fetchTimeoutMs: config.fetchTimeoutMs,
      });
      const blobs = createBlobStore({
        repos,
        runner,
        scratch,
        cache,
        fetches,
        bigFetches,
        ledger,
        fetchTimeoutMs: config.fetchTimeoutMs,
        noProgressMs: config.fetchNoProgressMs,
        failureTtlMs: config.fetchFailureTtlMs,
      });
      const dispatcher = createDispatcher({
        tools: TOOLS,
        services: {
          repos,
          runner,
          blobs,
          cache,
          ledger,
          tips,
          limits: {
            xlsxTimeoutMs: config.xlsxTimeoutMs,
            xlsxNoProgressMs: config.xlsxNoProgressMs,
            xlsxMaxHeapMb: config.xlsxMaxHeapMb,
            regexTimeoutMs: config.regexTimeoutMs,
            regexMaxChars: config.regexMaxChars,
          },
        },
        truncateChars: config.truncateChars,
        audit,
      });
      await scratch.sweep();
      await cache.scan();
      await ssh?.warm().catch((e) => swallow("ssh warm", e));
      scratch.start();
      server = createMcpHttpServer({ secret: config.secret, dispatcher });
      const listening = server;
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(config.port, "127.0.0.1", resolve);
      });
      return { port: (listening.address() as AddressInfo).port };
    },
    async stop() {
      scratch.stop();
      await pipeline?.stop();
      const closing = server;
      server = undefined;
      if (closing) {
        closing.closeAllConnections();
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
      killLiveGitGroups();
      await ssh?.stop();
      await database?.close();
    },
  };
}
