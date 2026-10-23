// Runs before `npm run deploy`: refuses the example config, a config whose
// missing ids would make Wrangler create new, empty resources, and a config
// from an older version that lacks bindings this version uses.

import { existsSync, readFileSync } from "node:fs";
import { CONFIG_FILE, configFromText, deployProblems, outdatedProblems } from "./template";

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
