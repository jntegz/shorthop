import { ArrowUpRight, Cloud, Database, Globe2, LockKeyhole, Mail, ChartNoAxesCombined } from "lucide-react";
import { SETTINGS_HELP } from "../lib/help";
import { Badge, Card, CardHeader } from "./ui";

const features = [
  { icon: Globe2, name: "Global delivery", detail: "Workers + Static Assets", benefit: "Edge redirects and free static asset requests.", href: "https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/" },
  { icon: Database, name: "Links & history", detail: "D1 + Workers KV", benefit: "Free storage allowances, plus automatic D1 recovery history.", href: "https://developers.cloudflare.com/d1/platform/pricing/" },
  { icon: ChartNoAxesCombined, name: "Audience insights", detail: "Analytics Engine", benefit: "Country, device, and source insights without tracking cookies.", href: "https://developers.cloudflare.com/analytics/analytics-engine/pricing/" },
  { icon: LockKeyhole, name: "Private workspace", detail: "Cloudflare Access", benefit: "Optional, recommended: identity-based admin access in front of the password. Free for up to 50 users.", href: "https://www.cloudflare.com/plans/" },
  { icon: Mail, name: "Weekly digest and alerts", detail: "Email Service (or another provider) + Cron", benefit: "With Email Service, free delivery to a verified address in your account.", href: "https://developers.cloudflare.com/email-service/platform/pricing/" },
  { icon: Cloud, name: "Operational visibility", detail: "Workers Logs + Traces", benefit: "Inspect errors and requests within Cloudflare’s included allowances.", href: "https://developers.cloudflare.com/workers/platform/pricing/" },
];

export function CloudflareFeatures() {
  return <Card id="cloudflare" className="scroll-mt-6 lg:col-span-2">
    <CardHeader title={<span className="flex items-center gap-2"><Cloud className="size-5 text-accent" /> Your Cloudflare foundation</span>}
      description="The services this app runs on, with their free plans or included allowances. Usage counts toward your account's limits."
      action={<Badge tone="accent">Free-tier guide</Badge>} info={SETTINGS_HELP.cloudflare} />
    <div className="grid gap-px overflow-hidden border-y border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
      {features.map(({ icon: Icon, name, detail, benefit, href }) => <a key={name} href={href} target="_blank" rel="noreferrer" className="group bg-surface p-5 transition-colors hover:bg-bg">
        <div className="mb-3 flex items-center justify-between"><Icon className="size-5 text-accent" /><ArrowUpRight className="size-3.5 text-subtle group-hover:text-accent" /></div>
        <h3 className="text-sm font-semibold">{name}</h3><p className="mt-1 text-[11px] font-medium text-accent">{detail}</p><p className="mt-2 text-xs leading-relaxed text-muted">{benefit}</p>
      </a>)}
    </div>
    <p className="px-5 py-4 text-xs leading-relaxed text-muted">Free allowances have usage limits and are shared across your account. This is a capability guide, not a live usage or billing report. Review usage in your Cloudflare dashboard before changing plans.</p>
  </Card>;
}
