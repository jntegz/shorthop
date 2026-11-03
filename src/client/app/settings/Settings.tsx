// Settings (/settings): five tabs, the open one in the address (#links,
// #access…). A section's anchor (#digest, #mcp…) opens its tab and scrolls to
// it, so links from anywhere in the admin land on the right section.
// General, Links and Statistics & email are here (general.tsx, utm.tsx,
// pages.tsx, reports.tsx, mail.tsx); API/MCP/webhooks and Access & security
// come from integrations.tsx and access.tsx.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { api, call, keys } from "../../api";
import { num } from "../../lib/format";
import { useCan, useMe } from "../../lib/me";
import { ErrorState, Skeleton, SkeletonText, Tabs } from "../ui";
import { AccountSection, AppearanceSection, BotCheckSection, PasswordOnlyPeople, PeopleSection, SecuritySection } from "./access";
import { BackupSection, CloudflareSection, DomainsSection, ExportsSection, PublishingSection } from "./general";
import { ApiKeysSection, ApiSection, WebhooksSection } from "./integrations";
import { DeadLinkSection, NotFoundSection } from "./pages";
import { DigestSection, StatisticsSection } from "./reports";
import { UtmSection } from "./utm";

/** Republishes links to KV, page by page: all of them, or only those on the default UTM template. */
async function resyncAll(onProgress: (n: number) => void, scope: "all" | "default-utm" = "all"): Promise<number> {
  let after: string | undefined;
  let total = 0;
  do {
    const res = await call(api.resync.$post({ query: { after, scope } }));
    total += res.published;
    onProgress(total);
    after = res.next ?? undefined;
  } while (after);
  return total;
}

type SettingsTab = "general" | "links" | "reports" | "integrations" | "access";

const TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  links: "Links",
  reports: "Statistics & email",
  integrations: "API, MCP & webhooks",
  access: "Access & security",
};
const TABS = Object.keys(TAB_LABELS) as SettingsTab[];

/** Section anchors used across the admin, and the tab each lives on. */
const TAB_OF: Record<string, SettingsTab> = {
  ...Object.fromEntries(TABS.map((t) => [t, t])),
  domains: "general",
  publishing: "general",
  exports: "general",
  backup: "general",
  cloudflare: "general",
  utm: "links",
  "not-found": "links",
  "dead-link": "links",
  statistics: "reports",
  digest: "reports",
  api: "integrations",
  "api-keys": "integrations",
  mcp: "integrations",
  webhooks: "integrations",
  account: "access",
  appearance: "access",
  people: "access",
  security: "access",
  "bot-check": "access",
};

function SettingsSkeleton() {
  return (
    <div aria-busy className="settings-loading">
      <span className="settings-loading-tabs">
        {[72, 48, 120, 140, 116].map((w, i) => (
          <Skeleton key={i} className="ui-skel-text" style={{ width: w }} />
        ))}
      </span>
      {[0, 1].map((i) => (
        <div key={i} className="settings-loading-section">
          <Skeleton className="ui-skel-text" style={{ width: 180, height: 18 }} />
          <SkeletonText lines={3} />
        </div>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const meQ = useMe();
  const me = meQ.data;
  const can = useCan();
  const manage = can("settings.manage");
  const apiUse = can("api.use");
  const admin = me?.role === "admin";
  // Workspace settings: people without that permission see only their account (and their API keys).
  const settings = useQuery({ queryKey: keys.settings, queryFn: () => call(api.settings.$get()), enabled: manage });
  const tabs = TABS.filter((t) => t === "access" || (t === "integrations" ? manage || apiUse : manage));
  const [resyncing, setResyncing] = useState<number | null>(null);

  // The tab lives in the address (#links, #access…); a section's anchor (#digest) opens its tab and scrolls to it.
  const { hash } = useLocation();
  const navigate = useNavigate();
  const anchor = hash.slice(1);
  const wanted = TAB_OF[anchor];
  const tab: SettingsTab = wanted && tabs.includes(wanted) ? wanted : (tabs[0] ?? "access");
  const openTab = (t: string) => navigate({ hash: t }, { replace: true });
  const ready = Boolean(me) && (!manage || Boolean(settings.data));
  useEffect(() => {
    if (ready && anchor && !(anchor in TAB_LABELS)) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }, [ready, anchor]);

  // On a phone the tab row scrolls sideways: keep the open tab in view.
  const tabsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, ready]);

  const runResync = async (scope: "all" | "default-utm" = "all") => {
    setResyncing(0);
    try {
      const n = await resyncAll(setResyncing, scope);
      toast.success(`Republished ${num(n)} links`, { description: "Changes reach every data center within about a minute." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Republish failed");
    } finally {
      setResyncing(null);
    }
  };

  const saveUtm = useMutation({
    mutationFn: (template: string) => call(api.settings.$put({ json: { defaultUtm: template.trim() } })),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      toast.success("Default UTM template saved");
      await runResync("default-utm");
    },
    onError: (e) => toast.error(e.message),
  });

  const s = settings.data;
  const domains = me?.workspace.domains ?? [];
  const sub = !me ? null : manage ? (
    <>
      Workspace on <span translate="no">{me.workspace.primaryDomain}</span>
      {domains.length > 1 ? ` and ${num(domains.length - 1)} more ${domains.length === 2 ? "domain" : "domains"}` : ""}.
    </>
  ) : (
    "Your account and how you sign in."
  );

  let body;
  if (meQ.isError) body = <ErrorState what="Your account" error={meQ.error} onRetry={() => void meQ.refetch()} retrying={meQ.isFetching} />;
  else if (settings.isError && !s) body = <ErrorState what="Settings" error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />;
  else if (!me || (manage && !s)) body = <SettingsSkeleton />;
  else {
    // This page is served from the admin host, which is also where the API lives.
    const origin = window.location.origin;
    body = (
      <div ref={tabsRef}>
        <Tabs label="Settings sections" className="settings-tabs" items={tabs.map((t) => ({ value: t, label: TAB_LABELS[t] }))} value={tab} onValueChange={openTab}>
          {(t) => (
            <div className="settings-panel">
              {t === "general" && s ? (
                <>
                  <DomainsSection domains={s.domains} primary={s.primaryDomain} adminHost={s.adminHost} linksPerDomain={s.linksPerDomain} demo={s.demo} />
                  {/* Two columns: publishing and exports beside the backup (admins), or beside each other. */}
                  <div className="settings-cols">
                    {admin ? (
                      <>
                        <div className="settings-col">
                          <PublishingSection resyncing={resyncing} onResync={() => void runResync()} />
                          <ExportsSection />
                        </div>
                        <div className="settings-col">
                          <BackupSection />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="settings-col">
                          <PublishingSection resyncing={resyncing} onResync={() => void runResync()} />
                        </div>
                        <div className="settings-col">
                          <ExportsSection />
                        </div>
                      </>
                    )}
                  </div>
                  <CloudflareSection />
                </>
              ) : null}
              {t === "links" && s ? (
                <>
                  <UtmSection key={s.defaultUtm} defaultUtm={s.defaultUtm} onSaveDefault={(v) => saveUtm.mutate(v)} saving={saveUtm.isPending || resyncing !== null} />
                  <NotFoundSection domain={s.primaryDomain} />
                  <DeadLinkSection domain={s.primaryDomain} />
                </>
              ) : null}
              {t === "reports" && s ? (
                <div className="settings-cols">
                  <div className="settings-col">
                    <StatisticsSection s={s} />
                  </div>
                  <div className="settings-col">
                    <DigestSection s={s} />
                  </div>
                </div>
              ) : null}
              {t === "integrations" ? (
                <>
                  {apiUse ? <ApiKeysSection me={me} origin={origin} /> : null}
                  {apiUse ? <ApiSection origin={origin} tokenSet={me.apiTokenSet} tokenScope={me.apiTokenScope} /> : null}
                  {manage ? <WebhooksSection /> : null}
                </>
              ) : null}
              {t === "access" ? (
                <>
                  <AccountSection me={me} />
                  <AppearanceSection />
                  {me.authMode === "password" ? <PasswordOnlyPeople /> : admin || me.role === "manager" ? <PeopleSection me={me} /> : null}
                  {admin && s?.security ? <SecuritySection me={me} security={s.security} /> : null}
                  {admin ? <BotCheckSection /> : null}
                </>
              ) : null}
            </div>
          )}
        </Tabs>
      </div>
    );
  }

  return (
    <div className="ui-page settings-page">
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Settings</h1>
          {sub ? <p className="ui-head-sub">{sub}</p> : null}
        </div>
      </header>
      {body}
    </div>
  );
}
