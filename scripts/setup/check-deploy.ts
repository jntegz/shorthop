// Runs before `npm run deploy`: refuses the example config, a config whose
// missing ids would make Wrangler create new, empty resources, and a config
// from an older version that lacks bindings this version uses.
//
// In Workers Builds (a Deploy to Cloudflare install, WORKERS_CI=1), it applies
// the database migrations to the button's wrangler.toml instead: there's no
// setup there to do it, and the deploy that follows needs them.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { WRANGLER_BIN } from "../lib";
import { BUTTON_FILE, CONFIG_FILE, configFromText, deployProblems, outdatedProblems } from "./template";

if (process.env.WORKERS_CI === "1" && !existsSync(CONFIG_FILE)) {
  // By binding name, so it works before and after the button writes the database id.
  const res = spawnSync(process.execPath, [WRANGLER_BIN, "d1", "migrations", "apply", "DB", "--remote", "--config", BUTTON_FILE], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

if (!existsSync(CONFIG_FILE)) {
  console.error(`\n✖ ${CONFIG_FILE} is missing. Run \`npm run setup\` first.\n`);
  process.exit(1);
}
const text = readFileSync(CONFIG_FILE, "utf8");
const problems = deployProblems(configFromText(text));
if (problems.length) {
  console.error(`\n✖ ${CONFIG_FILE} isn't ready to deploy:\n${problems.map((p) => `  - ${p}`).join("\n")}\nRun \`npm run setup\` to fix it.\n`);
  process.exit(1);
}
const outdated = outdatedProblems(text);
if (outdated.length) {
  console.error(
    `\n✖ ${CONFIG_FILE} was written by an older version:\n${outdated.map((p) => `  - ${p}`).join("\n")}\n` +
      "Run `npm run setup -- upgrade`: it adds them (keeping your values), applies the database migrations and deploys.\n",
  );
  process.exit(1);
}
