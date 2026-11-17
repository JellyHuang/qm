import { parentPort, workerData } from "node:worker_threads";
import { grepFile } from "./grep.ts";

const regex = new RegExp(workerData.pattern as string, workerData.flags as string);
const context = workerData.context as number;

parentPort?.on("message", (message: { id: number; file: string }) => {
  grepFile(message.file, { matches: (line) => regex.test(line), context }, (hit) => {
    parentPort?.postMessage({ type: "hit", id: message.id, hit });
    return true;
  }).then(
    (lines) => parentPort?.postMessage({ type: "done", id: message.id, lines }),
    (e: unknown) =>
      parentPort?.postMessage({ type: "error", id: message.id, message: e instanceof Error ? e.message : String(e) }),
  );
});
