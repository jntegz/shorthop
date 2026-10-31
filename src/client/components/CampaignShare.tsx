import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { linkPasswordProblem } from "../../shared/protection";
import { MAX_REPORT_LINKS, type ShareDTO, type ShareRange } from "../../shared/types";
import { api, call } from "../api";
import { ago, fromLocalInput, toLocalInput } from "../lib/format";
import { useCan } from "../lib/me";
import { copy } from "../lib/utils";
import { Badge, Button, ConfirmDialog, Dialog, Empty, errorMessage, Field, Input, LoadError, Select, Spinner } from "./ui";

const REPORTS_KEY = ["shares", "reports"] as const;

const RANGE_OPTIONS: { value: ShareRange | ""; label: string }[] = [
  { value: "", label: "Any period, up to all time" },
  { value: "7d", label: "Up to the last 7 days" },
  { value: "30d", label: "Up to the last 30 days" },
  { value: "90d", label: "Up to the last 90 days" },
  { value: "365d", label: "Up to the last 12 months" },
];

export type ReportSubject = { scope: "tag"; tag: string } | { scope: "set"; links: { domain: string; slug: string }[] };

function inAMonth(): string {
  const d = new Date(Date.now() + 30 * 86400_000);
  d.setMinutes(0, 0, 0);
  return toLocalInput(Math.floor(d.getTime() / 1000));
}

/**
 * A shared statistics page for several links: every link with a tag (links
 * tagged later join it), or a picked set. For sponsors, clients and campaign
 * results; revenue is optional.
 */
export function CampaignShare({ subject, open, onOpenChange }: { subject: ReportSubject | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const [title, setTitle] = useState("");
  const [expires, setExpires] = useState(true);
  const [expiresAt, setExpiresAt] = useState(inAMonth);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [rangeLimit, setRangeLimit] = useState<ShareRange | "">("");
  const [showRecent, setShowRecent] = useState(false);
  const [showRevenue, setShowRevenue] = useState(false);
  useEffect(() => {
    if (open && subject) setTitle(subject.scope === "tag" ? `Report: ${subject.tag}` : "");
  }, [open, subject]);

  const tooMany = subject?.scope === "set" && subject.links.length > MAX_REPORT_LINKS;
  const expirySec = expires ? fromLocalInput(expiresAt) : null;
  const expiryProblem = expires && (!expirySec || expirySec * 1000 <= Date.now()) ? "Pick a date and time in the future." : null;
  const passwordProblem = usePassword ? linkPasswordProblem(password) : null;

  const create = useMutation({
    mutationFn: () => {
      if (!subject) throw new Error("Nothing to share");
      const base = { title: title.trim(), expiresAt: expirySec, password: usePassword ? password : null, rangeLimit: rangeLimit || null, showRecent, showRevenue };
      return call(api.shares.$post({ json: subject.scope === "tag" ? { ...base, scope: "tag", tag: subject.tag } : { ...base, scope: "set", links: subject.links } }));
    },
    onSuccess: async ({ share }) => {
      void qc.invalidateQueries({ queryKey: REPORTS_KEY });
      setPassword("");
      if (share.url) await copy(share.url);
      toast.success("Report shared", { description: share.url ? "The address is copied. Send it with the password, if you set one." : undefined });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const what = !subject ? "" : subject.scope === "tag" ? `every link tagged “${subject.tag}”` : `${subject.links.length} selected ${subject.links.length === 1 ? "link" : "links"}`;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Share a report"
      description={`A read-only statistics page for ${what}: clicks, countries, sources and devices, with each link's totals. Viewers don't see destinations and can't change anything.`}
    >
      <div className="space-y-3">
        {tooMany ? <p className="text-sm text-danger">A report covers at most {MAX_REPORT_LINKS} links; select fewer, or tag them and share the tag.</p> : null}
        <Field label="Title" htmlFor="report-title" hint="The page heading, such as the campaign or sponsor's name.">
          <Input id="report-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sponsor: Acme, March" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={expires} onChange={(e) => setExpires(e.target.checked)} />
          Stop sharing automatically
        </label>
        {expires ? (
          <Field label="Shared until" htmlFor="report-expiry" error={expiryProblem} hint="Your local time.">
            <Input id="report-expiry" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
          Require a password
        </label>
        {usePassword ? (
          <Field label="Password" htmlFor="report-password" error={password ? passwordProblem : null} hint="Send it separately from the address.">
            <Input id="report-password" type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Periods viewers can pick" htmlFor="report-range">
          <Select id="report-range" value={rangeLimit} onChange={(e) => setRangeLimit(e.target.value as ShareRange | "")}>
            {RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-start gap-2 text-sm text-fg">
          <input type="checkbox" className="mt-1" checked={showRecent} onChange={(e) => setShowRecent(e.target.checked)} />
          <span>
            Show recent clicks
            <span className="block text-xs text-muted">The last 20 clicks with time, city, device and source. No visitor ids.</span>
          </span>
        </label>
        {can("revenue.view") ? (
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-1" checked={showRevenue} onChange={(e) => setShowRevenue(e.target.checked)} />
            <span>
              Show revenue
              <span className="block text-xs text-muted">Payments credited to these links on your tracked websites, in total and per link. No customer details.</span>
            </span>
          </label>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!title.trim() || Boolean(expiryProblem || passwordProblem) || tooMany}>
            Create and copy link
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const STATUS_TONE = { active: "good", expired: "warn", revoked: "neutral" } as const;

/** Every shared campaign report, with copy and stop. */
export function SharedReports({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const reports = useQuery({ queryKey: REPORTS_KEY, queryFn: () => call(api.shares.$get()), enabled: open });
  const [stopping, setStopping] = useState<ShareDTO | null>(null);
  const stop = useMutation({
    mutationFn: (id: string) => call(api.shares[":id"].$patch({ param: { id }, json: { revoke: true } })),
    onSuccess: () => {
      setStopping(null);
      toast.success("Report no longer shared");
      void qc.invalidateQueries({ queryKey: REPORTS_KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = reports.data?.shares ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title="Shared reports" description="Statistics pages for a tag or a set of links. Create one from a tag filter or a selection on the Links page.">
      {reports.isPending ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : reports.isError && !reports.data ? (
        <LoadError what="Shared reports" error={reports.error} onRetry={() => void reports.refetch()} retrying={reports.isFetching} />
      ) : !list.length ? (
        <Empty title="No reports shared yet" />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.title}</span>
                <span className="block text-xs text-muted">
                  {r.scope === "tag" ? `Tag “${r.tag}”` : `${r.links?.length ?? 0} links`} · {r.views} views{r.lastViewedAt ? `, last ${ago(r.lastViewedAt)}` : ""}
                  {r.showRevenue ? " · with revenue" : ""}
                </span>
              </span>
              <Badge tone={STATUS_TONE[r.status]}>{r.status === "active" ? "Shared" : r.status === "expired" ? "Expired" : "Stopped"}</Badge>
              {r.status === "active" && r.url ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void copy(r.url!, "Address copied")}>
                    <Copy /> Copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setStopping(r)}>
                    Stop sharing
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(o) => !o && setStopping(null)}
        title={`Stop sharing “${stopping?.title ?? ""}”?`}
        description="The address stops working right away for everyone who has it."
        confirmLabel="Stop sharing"
        loading={stop.isPending}
        onConfirm={() => stopping && stop.mutate(stopping.id)}
      />
    </Dialog>
  );
}
