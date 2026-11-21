// Settings → Access & security → Advanced tracking rules (admins): what the
// people in this workspace may switch on for a link's click log. Saving
// tighter rules also changes the links that break them (src/worker/api/tracking.ts).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_TRACKING_POLICY, TRACKING_RETENTION_DAYS, type TrackingPolicy, type TrackingRetention } from "../../../shared/tracking";
import { api, call, keys } from "../../api";
import { num } from "../../lib/format";
import { GuideLink, useTrackingPolicy } from "../link/Tracking";
import { Button, ErrorState, errorText, Notice, Select, Switch } from "../ui";
import { SectionSkeleton, SettingsSection } from "./common";

const RETENTION_LABEL: Record<TrackingRetention, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

export function TrackingRulesSection() {
  const qc = useQueryClient();
  const q = useTrackingPolicy();
  const [draft, setDraft] = useState<TrackingPolicy | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data.policy);
  }, [q.data, draft]);

  const save = useMutation({
    mutationFn: async (p: TrackingPolicy) => {
      const res = await call(api.tracking.policy.$put({ json: p }));
      // Links the request couldn't republish: the click-time check already applies the rules; this makes the published records match.
      if (res.republishPending > 0) {
        let after: string | undefined;
        do {
          const page = await call(api.resync.$post({ query: { after, scope: "all" } }));
          after = page.next ?? undefined;
        } while (after);
      }
      return res;
    },
    onSuccess: (res) => {
      setDraft(res.policy);
      void qc.invalidateQueries({ queryKey: ["tracking", "policy"] });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: ["link"] });
      toast.success("Tracking rules saved", {
        description: res.changed ? `${num(res.changed)} tracked ${res.changed === 1 ? "link was" : "links were"} brought within the new rules.` : "No tracked link needed changing.",
      });
    },
    onError: (e) => toast.error(errorText(e) ?? "That didn’t work. Try again."),
  });

  if (q.isError) return <ErrorState what="Tracking rules" error={q.error} onRetry={() => void q.refetch()} />;
  if (!draft) return <SectionSkeleton id="tracking-rules" title="Advanced tracking rules" />;
  const set = <K extends keyof TrackingPolicy>(k: K, v: TrackingPolicy[K]) => setDraft({ ...draft, [k]: v });
  const saved = q.data?.policy;
  const dirty = saved ? JSON.stringify(saved) !== JSON.stringify(draft) : true;
  const tighter =
    saved &&
    ((saved.enabled && !draft.enabled) ||
      (saved.allowIp && !draft.allowIp) ||
      (saved.allowBrowser && !draft.allowBrowser) ||
      (saved.allowPixel && !draft.allowPixel) ||
      draft.maxRetentionDays < saved.maxRetentionDays);

  return (
    <SettingsSection
      id="tracking-rules"
      title="Advanced tracking rules"
      sub={
        <>
          What people in this workspace may switch on for a link’s click log. The rules apply to every click as it’s recorded. <GuideLink>Guide for the people who use it</GuideLink>
        </>
      }
    >
      <div className="settings-stack">
        <Switch checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} label="Allow Advanced tracking" description="Off: no link records a click log. Logs already recorded stay until their retention ends and can still be read and deleted." />
        <Switch
          checked={draft.allowIp}
          disabled={!draft.enabled}
          onCheckedChange={(v) => set("allowIp", v)}
          label="Allow recording IP addresses"
          description="Off by default. Each link still needs someone with See IP addresses to accept the GDPR warning. Switching this off deletes every IP address already recorded."
        />
        <Switch
          checked={draft.allowBrowser}
          disabled={!draft.enabled}
          onCheckedChange={(v) => set("allowBrowser", v)}
          label="Allow browser details"
          description="The short page that reads screen, time zone and hardware from the visitor’s browser. Switching this off deletes the browser details already recorded."
        />
        <Switch checked={draft.allowPixel} disabled={!draft.enabled} onCheckedChange={(v) => set("allowPixel", v)} label="Allow the email-open pixel" description="In the EU, tracking pixels in emails generally need the recipient’s consent." />
        <Switch
          checked={draft.requirePurpose}
          disabled={!draft.enabled}
          onCheckedChange={(v) => set("requirePurpose", v)}
          label="Require a purpose"
          description="Whoever switches tracking on for a link writes down why. It’s shown on the link’s click log, and is what the GDPR expects you to be able to explain."
        />
        <Select
          label="Longest retention"
          value={String(draft.maxRetentionDays)}
          disabled={!draft.enabled}
          onChange={(e) => set("maxRetentionDays", Number(e.target.value) as TrackingRetention)}
          options={TRACKING_RETENTION_DAYS.map((d) => ({ value: String(d), label: RETENTION_LABEL[d] }))}
          hint="Links that keep clicks longer are shortened, and clicks already stored are cut to it."
        />
        {tighter ? <Notice tone="warn">These rules are tighter than the saved ones. Saving changes the tracked links that break them at once, and deletes the data they no longer allow.</Notice> : null}
        <div className="settings-actions">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
            Save rules
          </Button>
          <Button variant="ghost" disabled={JSON.stringify(draft) === JSON.stringify(DEFAULT_TRACKING_POLICY)} onClick={() => setDraft({ ...DEFAULT_TRACKING_POLICY })}>
            Back to the cautious defaults
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
