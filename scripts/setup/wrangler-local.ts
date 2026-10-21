// Runs a local Wrangler command against wrangler.jsonc, or against the example
// config before `npm run setup` has written one: npm run db:migrate:local

import { spawnSync } from "node:child_process";
import { WRANGLER_BIN } from "../lib";
import { localConfig } from "./template";

const res = spawnSync(process.execPath, [WRANGLER_BIN, ...process.argv.slice(2), "--config", localConfig().file], { stdio: "inherit" });
process.exit(res.status ?? 1);
