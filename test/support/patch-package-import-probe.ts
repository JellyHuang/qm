import childProcess from "node:child_process";
import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join } from "node:path";

const events: string[] = [];

process.env = new Proxy(process.env, {
  get(target, key, receiver) {
    if (typeof key === "string" && /^(ZQ_|GIT_|PATCH)/.test(key)) events.push(`env ${key}`);
    return Reflect.get(target, key, receiver);
  },
});
for (const name of ["spawn", "spawnSync", "exec", "execFile", "execFileSync", "execSync", "fork"] as const)
  (childProcess as Record<string, unknown>)[name] = () => {
    events.push(`child_process ${name}`);
    throw new Error("blocked");
  };
net.Socket.prototype.connect = function () {
  events.push("net connect");
  throw new Error("blocked");
} as typeof net.Socket.prototype.connect;
globalThis.fetch = (() => {
  events.push("fetch");
  throw new Error("blocked");
}) as typeof fetch;
syncBuiltinESMExports();

const dir = process.argv[2] ?? "";
let exported = 0;
for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
  const loaded = await import(join(dir, file));
  exported += Object.keys(loaded).length;
}
process.stdout.write(JSON.stringify({ events, exported }));
