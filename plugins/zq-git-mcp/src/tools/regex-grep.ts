import { Worker } from "node:worker_threads";
import type { GrepHit } from "./grep.ts";

export class RegexTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the regular expression search used its ${Math.round(timeoutMs / 1000)} s time limit`);
    this.name = "RegexTimeoutError";
  }
}

export interface RegexGrep {
  grep(file: string, onHit: (hit: GrepHit) => boolean): Promise<void>;
  close(): Promise<void>;
}

export function createRegexGrep(options: {
  pattern: string;
  flags: string;
  context: number;
  timeoutMs: number;
  signal: AbortSignal;
}): RegexGrep {
  let worker: Worker | undefined;
  let remaining = options.timeoutMs;
  let nextId = 0;

  const stop = async () => {
    const current = worker;
    worker = undefined;
    await current?.terminate();
  };

  return {
    async grep(file, onHit) {
      options.signal.throwIfAborted();
      if (remaining <= 0) throw new RegexTimeoutError(options.timeoutMs);
      worker ??= new Worker(new URL("./regex-worker.ts", import.meta.url), {
        workerData: { pattern: options.pattern, flags: options.flags, context: options.context },
      });
      const current = worker;
      const id = nextId++;
      const started = Date.now();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new RegexTimeoutError(options.timeoutMs)), remaining);
          const cleanup = () => {
            clearTimeout(timer);
            current.off("message", onMessage);
            current.off("error", onError);
            options.signal.removeEventListener("abort", onAbort);
          };
          const onError = (e: Error) => {
            cleanup();
            reject(e);
          };
          const onAbort = () => {
            cleanup();
            reject(options.signal.reason);
          };
          const onMessage = (message: { type: string; id: number; hit?: GrepHit; message?: string }) => {
            if (message.id !== id) return;
            if (message.type === "hit" && message.hit) {
              if (onHit(message.hit)) return;
              cleanup();
              void stop().then(resolve);
            } else if (message.type === "done") {
              cleanup();
              resolve();
            } else if (message.type === "error") {
              cleanup();
              reject(new Error(message.message));
            }
          };
          current.on("message", onMessage);
          current.once("error", onError);
          options.signal.addEventListener("abort", onAbort, { once: true });
          current.postMessage({ id, file });
        });
      } catch (e) {
        await stop();
        throw e;
      } finally {
        remaining -= Date.now() - started;
      }
    },
    close: stop,
  };
}
