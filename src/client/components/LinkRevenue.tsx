import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { Link } from "react-router";
import { api, call, keys } from "../api";
import { num } from "../lib/format";
import { money } from "../lib/sites";
import { Card, CardHeader } from "./ui";

/** What a short link earned on the tracked websites it leads to (the last 12 months). */
export function LinkRevenue({ domain, slug }: { domain: string; slug: string }) {
  const data = useQuery({
    queryKey: keys.linkRevenue(domain, slug),
    queryFn: () => call(api.sites["by-link"][":domain"][":slug"].$get({ param: { domain, slug }, query: {} })),
  });
  const r = data.data;
  if (!r || !r.bySite.length) return null;
  return (
    <Card className="mt-6">
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><CircleDollarSign className="size-4 text-accent" /> Revenue from this link</span>}
        description="Visits this link brought to your tracked websites, and the payments credited to them, in the last 12 months."
      />
      <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
        {r.bySite.map((s) => (
          <Link key={s.siteId} to={`/sites/${s.siteId}?range=365d&f_link=${encodeURIComponent(`${domain}/${slug}`)}`} className="rounded-md border border-line px-4 py-3 hover:border-accent/40">
            <p className="text-xs text-muted">{s.name}</p>
            <p className="tabular mt-1 text-2xl font-semibold tracking-tight">{money(s.revenue, s.currency, true)}</p>
            <p className="mt-0.5 text-xs text-muted">{num(s.payments)} payment{s.payments === 1 ? "" : "s"} · {num(s.sessions)} visit{s.sessions === 1 ? "" : "s"}</p>
          </Link>
        ))}
      </div>
    </Card>
  );
}
