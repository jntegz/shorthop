import { ArrowUpRight, ShieldCheck, UserRound } from "lucide-react";
import { Badge, Card, CardHeader } from "./ui";

/**
 * Settings → Access: who can open the admin. Everyone listed has full access;
 * there are no roles. Changes they make show their email in each link's history.
 */
export function AccessCard({ admins, me }: { admins: string[]; me: string }) {
  return (
    <Card id="access" className="scroll-mt-6 lg:col-span-2">
      <CardHeader title="People with access" description="Everyone here can sign in and manage every link and setting. Each link's history shows who changed what." />
      <div className="grid gap-6 px-5 pb-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <ul className="self-start divide-y divide-line rounded-xl border border-line">
          {admins.length ? (
            admins.map((email) => (
              <li key={email} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <UserRound className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{email}</span>
                {email === me.toLowerCase() ? <Badge tone="accent">You</Badge> : null}
                <Badge>Admin</Badge>
              </li>
            ))
          ) : (
            <li className="px-3 py-2.5 text-sm text-muted">No one is listed in ADMIN_EMAIL, so the admin stays closed.</li>
          )}
        </ul>
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-2 text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <span>
              Two locks: <strong className="text-fg">Cloudflare Access</strong> checks the person's email, then the <strong className="text-fg">admin password</strong> confirms it. Both are needed.
            </span>
          </p>
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Add someone</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>
                In{" "}
                <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
                  Cloudflare Zero Trust <ArrowUpRight className="size-3" />
                </a>{" "}
                → Access → Applications, add their email to this admin's policy.
              </li>
              <li>
                Add it to <code className="font-mono text-xs text-fg">ADMIN_EMAIL</code> in wrangler.jsonc (comma-separated), then deploy.
              </li>
              <li>Share the admin password with them privately.</li>
            </ol>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Remove someone</p>
            <p className="text-muted">
              Take them out of both lists and deploy, then use <strong className="text-fg">Log out everywhere</strong> below and change the admin password, so an open session or a remembered password stops working.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
