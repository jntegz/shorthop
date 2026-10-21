// Creates the ADMIN_PASSWORD_HASH secret for the admin login.
//
//   npx tsx scripts/hash-password.ts --generate          # new random password + its hash
//   npx tsx scripts/hash-password.ts                     # type a password (hidden)
//   pbpaste | npx tsx scripts/hash-password.ts           # or pipe it in
//   ... [--plan paid]                                    # 100,000 iterations (default: free, 25,000)
//
// `npm run setup -- password` does all of this and uploads the hash for you.
//
// The password is never read from the command line, so it can't end up in
// shell history.

import { hashPassword, PLAN_ITERATIONS } from "../src/shared/password";
import { generateSlug } from "../src/shared/slug";
import { args, fail, promptHidden, readStdin } from "./lib";
import { passwordProblem } from "./setup/validate";

const { flags, opts } = args();
const plan = opts.get("plan") ?? "free";
if (plan !== "free" && plan !== "paid") fail('--plan must be "free" or "paid".');
const iterations = PLAN_ITERATIONS[plan];

let password: string;
if (flags.has("generate")) {
  password = generateSlug(32);
} else if (process.stdin.isTTY) {
  password = await promptHidden("Admin password: ");
  const again = await promptHidden("Repeat it: ");
  if (again !== password) fail("The passwords don't match.");
} else {
  password = await readStdin();
}

const problem = passwordProblem(password);
if (problem) fail(`${problem} A long random password is best: --generate.`);

const hash = await hashPassword(password, iterations).catch((err: unknown) => fail(String(err instanceof Error ? err.message : err)));

if (flags.has("generate")) {
  console.log(`\nPassword (save it in your password manager now):\n\n  ${password}\n`);
}
console.log(`ADMIN_PASSWORD_HASH:\n\n  ${hash}\n`);
console.log("To set it on the Worker, `npm run setup -- password` is simpler (it also ends old sessions).");
console.log("By hand (paste the hash when asked):\n\n  npx wrangler secret put ADMIN_PASSWORD_HASH\n");
console.log("For local development, add it to .dev.vars as ADMIN_PASSWORD_HASH=<hash>.");
