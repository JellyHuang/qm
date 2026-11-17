import type { AddressInfo } from "node:net";
import { swallow } from "../../chassis/src/errors.ts";
import { createMemoryAuditSink, type AuditSink } from "./audit.ts";
import { createBlobStore } from "./blobs.ts";
import { assertGitVersion } from "./git-version.ts";
import { createMemoryBlobMetaLedger } from "./ledger.ts";
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
}

export function createService(config: Config, deps: ServiceDeps = {}): Service {
  const ssh = config.ssh ? createSsh(config.ssh) : undefined;
  const audit = deps.audit ?? createMemoryAuditSink();
  const tips = deps.tips ?? createMemoryTipStore();
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
      const ledger = createMemoryBlobMetaLedger();
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
        services: { repos, runner, blobs, cache, ledger, tips },
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
      const closing = server;
      server = undefined;
      if (closing) {
        closing.closeAllConnections();
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
      killLiveGitGroups();
      await ssh?.stop();
    },
  };
}
