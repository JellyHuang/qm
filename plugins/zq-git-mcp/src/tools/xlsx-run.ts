import { Worker } from "node:worker_threads";
import type { XlsxWorkerInput } from "../xlsx/worker.ts";
import { ToolFailure, type ToolLimits } from "./types.ts";

export type XlsxWorkerResult =
  | {
      type: "result";
      sheets: unknown[];
      offset: number;
      total: number;
      rows: unknown[];
      table: string;
      truncated: boolean;
      cut: number;
      next: number | null;
    }
  | { type: "unsupported"; reason: string; side: string; note: string }
  | { type: "error"; code: string; message: string };

export function runXlsxWorker(
  input: XlsxWorkerInput,
  limits: ToolLimits,
  signal: AbortSignal,
): Promise<XlsxWorkerResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("../xlsx/worker.ts", import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: limits.xlsxMaxHeapMb },
    });
    let finished = false;
    let watchdog: NodeJS.Timeout | undefined;
    const done = (action: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(total);
      clearTimeout(watchdog);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate().then(action);
    };
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () =>
          done(() =>
            reject(
              new ToolFailure(
                "xlsx_no_progress",
                `the workbook comparison made no progress for ${Math.round(limits.xlsxNoProgressMs / 1000)} s`,
              ),
            ),
          ),
        limits.xlsxNoProgressMs,
      );
    };
    const total = setTimeout(
      () =>
        done(() =>
          reject(
            new ToolFailure(
              "xlsx_timeout",
              `the workbook comparison used its ${Math.round(limits.xlsxTimeoutMs / 1000)} s time limit`,
            ),
          ),
        ),
      limits.xlsxTimeoutMs,
    );
    const onAbort = () => done(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    arm();
    worker.on("message", (message: XlsxWorkerResult | { type: "progress" }) => {
      if (message.type === "progress") return arm();
      done(() => resolve(message));
    });
    worker.on("error", (e: Error & { code?: string }) =>
      done(() =>
        reject(
          e.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new ToolFailure(
                "xlsx_out_of_memory",
                `the workbook comparison exceeded its ${limits.xlsxMaxHeapMb} MB memory bound and was stopped`,
              )
            : e,
        ),
      ),
    );
    worker.on("exit", (code) => {
      if (!finished) done(() => reject(new Error(`the workbook worker exited with ${code}`)));
    });
  });
}
