// Settings → Statistics & email: the daily rollup (Analytics Engine → D1) and
// the weekly digest (preview, send a test, set up the email service).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Settings2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { SettingsDTO } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { SETTINGS_HELP } from "../../lib/help";
import { useCan } from "../../lib/me";
import { Badge, Button, Dialog, Notice } from "../ui";
import { Fact, Facts } from "./parts";
import { SettingsSection, span } from "./common";
import { MailSetupDialog } from "./mail";

export function StatisticsSection({ s }: { s: SettingsDTO }) {
  const qc = useQueryClient();
  const rollup = useMutation({
    mutationFn: () => call(api.settings.rollup.$post()),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      if (r.skipped) toast.warning(r.skipped);
      else if (!r.rolled.length) toast.success("Already up to date", { description: "Every finished day is already saved." });
      else
        toast.success(`Saved ${r.rolled.length} ${r.rolled.length === 1 ? "day" : "days"} of stats`, {
          description: `${span(r.rolled[0]!, r.rolled.at(-1)!)} (UTC) copied from Analytics Engine into the database, where it is kept for good.`,
        });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <SettingsSection id="statistics" title="Statistics" sub="Daily summaries preserve your history after individual click records expire." help={SETTINGS_HELP.statistics}>
      <div className="settings-stack">
        <Facts>
          <Fact label="Analytics Engine queries">{s.aeAvailable ? "Configured" : <Badge tone="warn">Not configured</Badge>}</Fact>
          <Fact label="Rolled up through">{s.lastRolled ?? "never"}</Fact>
        </Facts>
        <p className="settings-note">
          {!s.aeAvailable
            ? "Running the rollup needs an analytics token: run npm run setup -- analytics (see docs/SETUP.md, The analytics token)."
            : s.rollupPending
              ? `Running it now saves ${s.rollupPending.days} finished ${s.rollupPending.days === 1 ? "day" : "days"} (${span(s.rollupPending.from, s.rollupPending.to)}, UTC) from Analytics Engine into the database. Today is saved tomorrow, once it is complete. Safe to repeat.`
              : "Every finished day is saved. Today is saved tomorrow, once it is complete. Nothing to do."}
        </p>
        <div className="settings-actions">
          <Button onClick={() => rollup.mutate()} loading={rollup.isPending} disabled={!s.aeAvailable}>
            Run rollup now
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

export function DigestSection({ s }: { s: SettingsDTO }) {
  const can = useCan();
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [mailSetup, setMailSetup] = useState(false);

  const loadPreview = useMutation({
    mutationFn: () => call(api.settings.digest.preview.$get()),
    onSuccess: (p) => setPreview(p),
    onError: (e) => toast.error(e.message),
  });

  const sendTest = useMutation({
    mutationFn: () => call(api.settings.digest.test.$post()),
    onSuccess: (r) => {
      if (r.status === "sent") toast.success("Test digest sent", { description: s.digestTo });
      else toast.error(`Digest not sent: ${r.reason ?? r.status}`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <SettingsSection id="digest" title="Weekly digest" sub="Sent Mondays at 07:00 UTC with last week’s top links." help={SETTINGS_HELP.digest}>
      <div className="settings-stack">
        <Facts>
          <Fact label="Recipient">
            <span className="settings-trunc" title={s.digestTo ?? undefined}>
              {s.digestTo ?? "Not set"}
            </span>
          </Fact>
          <Fact label="Sent with">
            <span className="settings-inline">
              {s.digestProvider}
              {s.digestProblem ? <Badge tone="warn">Not ready</Badge> : null}
            </span>
          </Fact>
          <Fact label="Last sent">{s.lastDigestWeek ?? "never"}</Fact>
        </Facts>
        {s.digestProblem ? <Notice tone="warn">{s.digestProblem}</Notice> : null}
        <div className="settings-actions">
          <Button variant={s.digestProblem ? "primary" : "secondary"} icon={Settings2} onClick={() => setMailSetup(true)}>
            Set up email
          </Button>
          {can("stats.view") ? (
            <Button onClick={() => loadPreview.mutate()} loading={loadPreview.isPending}>
              Preview
            </Button>
          ) : null}
          <Button icon={Mail} onClick={() => sendTest.mutate()} loading={sendTest.isPending} disabled={s.digestProblem !== null}>
            Send test
          </Button>
        </div>
      </div>

      <MailSetupDialog open={mailSetup} onOpenChange={setMailSetup} />

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)} size="lg" title={preview?.subject ?? "Digest preview"}>
        {preview ? <iframe title="Digest preview" sandbox="" srcDoc={preview.html} className="settings-frame settings-frame-mail" /> : null}
      </Dialog>
    </SettingsSection>
  );
}
