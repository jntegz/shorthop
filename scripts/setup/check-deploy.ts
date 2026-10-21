// Runs before `npm run deploy`: refuses the example config, and a config whose
// missing ids would make Wrangler create new, empty resources.

import { existsSync, readFileSync } from "node:fs";
import { CONFIG_FILE, configFromText, deployProblems } from "./template";

if (!existsSync(CONFIG_FILE)) {
  console.error(`\n✖ ${CONFIG_FILE} is missing. Run \`npm run setup\` first.\n`);
  process.exit(1);
}
const problems = deployProblems(configFromText(readFileSync(CONFIG_FILE, "utf8")));
if (problems.length) {
  console.error(`\n✖ ${CONFIG_FILE} isn't ready to deploy:\n${problems.map((p) => `  - ${p}`).join("\n")}\nRun \`npm run setup\` to fix it.\n`);
  process.exit(1);
}
