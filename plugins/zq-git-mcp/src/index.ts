import { errMessage } from "../../chassis/src/errors.ts";
import { loadConfig } from "./config.ts";
import { createService } from "./service.ts";

async function main(): Promise<void> {
  const service = createService(loadConfig(process.env));
  const { port } = await service.start();
  console.log(`zq-git-mcp listening on 127.0.0.1:${port}`);
  const shutdown = () => {
    void service.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(`zq-git-mcp failed to start: ${errMessage(e)}`);
  process.exit(1);
});
