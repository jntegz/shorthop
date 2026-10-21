// Rewrites wrangler.example.jsonc from the template: npm run config:example

import { writeFileSync } from "node:fs";
import { EXAMPLE_CONFIG, EXAMPLE_FILE, renderConfig } from "./template";

writeFileSync(EXAMPLE_FILE, renderConfig(EXAMPLE_CONFIG));
console.log(`Wrote ${EXAMPLE_FILE}`);
