// Rewrites wrangler.example.jsonc and the Deploy to Cloudflare button's
// wrangler.toml from the template: npm run config:example

import { writeFileSync } from "node:fs";
import { BUTTON_FILE, EXAMPLE_CONFIG, EXAMPLE_FILE, renderButtonConfig, renderConfig } from "./template";

writeFileSync(EXAMPLE_FILE, renderConfig(EXAMPLE_CONFIG));
writeFileSync(BUTTON_FILE, renderButtonConfig());
console.log(`Wrote ${EXAMPLE_FILE} and ${BUTTON_FILE}`);
