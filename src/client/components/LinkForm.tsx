import { ChevronDown, Link2, MessageSquareText, ShieldCheck, Sparkles, Split } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { checkoutProvider } from "../../shared/checkout";
import { DEFAULT_BIO, validateBio, type BioPage } from "../../shared/bio";
import { BioEditor } from "./BioEditor";
import { PROVIDER_INFO } from "../../shared/sites";
import { validateSlug } from "../../shared/slug";
import { validatePreview, type LinkPreview } from "../../shared/preview";
import { linkPasswordProblem, MAX_CLICK_LIMIT } from "../../shared/protection";
import { describeRouting, validateRouting, type RouteRule } from "../../shared/routing";
import { normalizeTarget, validateUtmTemplate } from "../../shared/target";
import type { LinkDTO } from "../../shared/types";
import { api, call, keys, linkFromError } from "../api";
import { fromLocalInput, toLocalInput } from "../lib/format";
import { LINK_HELP } from "../lib/help";
import { linkKey, linkPath, linkState, useDomains, useLinkLabel } from "../lib/links";
import { useCan, useMe } from "../lib/me";
import { cn, copy } from "../lib/utils";
import { LinkProtection, type PasswordMode } from "./LinkProtection";
import { LinkUtm } from "./LinkUtm";
import { PreviewEditor } from "./PreviewEditor";
import { RoutingEditor } from "./RoutingEditor";
import { Button, Combobox, Dialog, Field, InfoTip, Input, Segmented, Select, Switch, Textarea } from "./ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this link; omit to create a new one. */
  link?: LinkDTO;
  /** Prefill the slug when creating (e.g. from the misses report). */
  initialSlug?: string;
  /** Prefill the domain when creating; defaults to the primary domain. */
  initialDomain?: string;
  /** Prefill the destination and title when creating (the bookmarklet, sharing to the admin). */
  initialTarget?: string;
  initialTitle?: string;
  /** Creating only: open as a link-in-bio page instead of a redirect. */
  asBio?: boolean;
  onSaved?: (link: LinkDTO) => void;
  /** Editing only: open with "Link no longer working" switched on (from a failed destination check). */
  markBroken?: boolean;
}

interface FormState {
  /** Empty means the primary domain. */
  domain: string;
  target: string;
  slug: string;
  title: string;
  tags: string;
  notes: string;
  expires: string;
  active: boolean;
  utm: boolean;
  utmTemplate: string;
  passQuery: boolean;
  monitor: boolean;
  /** Never checked, even when Link health checks every link. Switching it on switches monitor off, and the other way round. */
  neverCheck: boolean;
  broken: boolean;
  /** While broken: the "no longer working" page alone, or pointing to another of your links. */
  deadEnd: "page" | "link";
  /** "domain/slug" of the replacement, or "" for none. */
  replacement: string;
  /** Smart routing rules; none means one destination for everyone. */
  rules: RouteRule[];
  /** Custom social preview; null lets platforms read the destination's own. */
  preview: LinkPreview | null;
  /** UTM: this link's own template (utmTemplate) rather than the default. */
  utmCustom: boolean;
  /** Why the custom UTM fields can't be saved, from the builder. */
  utmProblem: string | null;
  passwordMode: PasswordMode;
  password: string;
  capOn: boolean;
  maxClicks: string;
  /** A link-in-bio page instead of a redirect; null for an ordinary link. */
  bio: BioPage | null;
}

function initial(link?: LinkDTO, slug = "", domain = "", target = "", title = ""): FormState {
  return {
    domain: link?.domain ?? domain,
    target: link?.target ?? target,
    slug: link?.slug ?? slug,
    title: link?.title ?? title.slice(0, 300),
    tags: link?.tags.join(", ") ?? "",
    notes: link?.notes ?? "",
    expires: toLocalInput(link?.expiresAt ?? null),
    active: link?.active ?? true,
    utm: link?.utm ?? false,
    utmTemplate: link?.utmTemplate ?? "",
    passQuery: link?.passQuery ?? false,
    monitor: link?.monitor ?? false,
    neverCheck: link?.neverCheck ?? false,
    broken: link?.broken ?? false,
    deadEnd: link?.replacement ? "link" : "page",
    replacement: link?.replacement ? linkKey(link.replacement.domain, link.replacement.slug) : "",
    rules: link?.routing?.rules ?? [],
    preview: link?.preview ?? null,
    utmCustom: Boolean(link?.utmTemplate),
    utmProblem: null,
    passwordMode: "keep",
    password: "",
    capOn: Boolean(link?.maxClicks),
    maxClicks: link?.maxClicks ? String(link.maxClicks) : "100",
    bio: link?.bio ?? null,
  };
}

export function LinkForm({ open, onOpenChange, link, initialSlug, initialDomain, initialTarget, initialTitle, asBio, onSaved, markBroken }: Props) {
  const qc = useQueryClient();
  const editing = Boolean(link);
  const { domains, primary, multiple } = useDomains();
  const label = useLinkLabel();
  const manageSettings = useCan()("settings.manage");
  const checkAll = useMe().data?.workspace.checkScope === "all";
  const fallbackUrl = useMe().data?.workspace.fallbackUrl ?? "";
  const [f, setF] = useState<FormState>(() => initial(link, initialSlug, initialDomain, initialTarget, initialTitle));
  const [touched, setTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [protectionOpen, setProtectionOpen] = useState(false);
  /** A flagged destination the owner trusts: visitors aren't warned. */
  const [trust, setTrust] = useState(link?.unsafe === "trusted");
  useEffect(() => {
    if (open) setTrust(link?.unsafe === "trusted");
  }, [open, link]);

  useEffect(() => {
    if (open) {
      const start = initial(link, initialSlug, initialDomain, initialTarget, initialTitle);
      setF({
        ...start,
        ...(link && markBroken ? { broken: true } : {}),
        ...(!link && asBio ? { bio: { ...DEFAULT_BIO, name: start.title }, target: start.target || fallbackUrl } : {}),
      });
      setTouched(false);
      setAdvanced(Boolean(link));
      setRoutingOpen(Boolean(link?.routing));
      setPreviewOpen(false);
      setProtectionOpen(false);
    }
  }, [open, link, initialSlug, initialDomain, initialTarget, initialTitle, asBio, markBroken]);

  const domain = f.domain || primary;

  // Replacement choices: links that work right now (plus the current choice, so it stays visible).
  const candidates = useQuery({
    queryKey: keys.links({ picker: true }),
    queryFn: () => call(api.links.$get({ query: { sort: "slug", period: "7d" } })),
    enabled: open && editing && f.broken && f.deadEnd === "link",
  });
  const replacementOptions = (candidates.data?.links ?? []).filter(
    (l) => !(link && l.domain === link.domain && l.slug === link.slug) && (linkState(l) === "active" || linkKey(l.domain, l.slug) === f.replacement),
  );

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const targetCheck = f.target ? normalizeTarget(f.target, { allowHttp: link?.source === "import", selfHosts: domains }) : null;
  const errors = {
    target: !f.target ? "Enter the destination URL." : targetCheck && !targetCheck.ok ? targetCheck.error : null,
    slug: !editing && f.slug ? validateSlug(f.slug, "native") : null,
    utmTemplate: f.utm && f.utmCustom ? (f.utmProblem ?? (f.utmTemplate ? validateUtmTemplate(f.utmTemplate) : "Fill in at least one parameter.")) : null,
    replacement: editing && f.broken && f.deadEnd === "link" && !f.replacement ? "Pick the link to send visitors to, or choose Error page." : null,
  };
  // Other links already going to this destination: a warning, never a block.
  const normalizedTarget = targetCheck?.ok ? targetCheck.url : "";
  const [lookupTarget, setLookupTarget] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setLookupTarget(normalizedTarget), 400);
    return () => clearTimeout(t);
  }, [normalizedTarget]);
  const sameTarget = useQuery({
    queryKey: [...keys.allLinks, "by-target", lookupTarget],
    queryFn: () => call(api.links["by-target"].$get({ query: { url: lookupTarget } })),
    enabled: open && Boolean(lookupTarget) && lookupTarget !== link?.target,
    staleTime: 60_000,
  });
  const checkout = checkoutHint(normalizedTarget);
  const aiOn = useMe().data?.workspace.aiAvailable ?? false;
  const suggest = useMutation({
    mutationFn: (url: string) => call(api.previews.ai.slug.$post({ json: { url } })),
    onSuccess: (r) => {
      if (!r.slugs.length) toast.info("No slug ideas this time. Try again, or type your own.");
    },
    onError: (e) => toast.error(e.message),
  });
  const duplicates = (sameTarget.data?.links ?? []).filter((l) => !(link && l.domain === link.domain && l.slug === link.slug));
  const routingCheck = f.rules.length ? validateRouting({ rules: f.rules }, { selfHosts: domains }) : null;
  const routingErrors = routingCheck && !routingCheck.ok ? routingCheck.errors : [];
  const previewCheck = f.preview ? validatePreview(f.preview) : null;
  const previewProblems = previewCheck && !previewCheck.ok ? previewCheck.problems : [];
  const passwordError = f.passwordMode === "set" ? linkPasswordProblem(f.password) : null;
  const capNumber = Number(f.maxClicks);
  const capError = f.capOn && (!Number.isInteger(capNumber) || capNumber < 1 || capNumber > MAX_CLICK_LIMIT) ? `Enter a whole number from 1 to ${MAX_CLICK_LIMIT.toLocaleString("en")}.` : null;
  const bioCheck = f.bio ? validateBio(f.bio) : null;
  const bioProblems = bioCheck && !bioCheck.ok ? bioCheck.problems.map((p) => p.message) : [];
  const valid =
    bioProblems.length === 0 &&
    !errors.target && !errors.slug && !errors.utmTemplate && !errors.replacement && routingErrors.length === 0 && previewProblems.length === 0 && !passwordError && !capError;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...(link?.unsafe && f.target.trim() === link.target ? { trustDestination: trust } : {}),
        // On create a redirect sends nothing; on edit, null turns a bio page back into a redirect.
        ...(f.bio || editing ? { bio: f.bio } : {}),
        target: f.target.trim(),
        title: f.title.trim() || null,
        tags: f.tags,
        notes: f.notes,
        expiresAt: fromLocalInput(f.expires),
        active: f.active,
        utm: f.utm,
        utmTemplate: f.utm && f.utmCustom && f.utmTemplate.trim() ? f.utmTemplate.trim() : null,
        passQuery: f.passQuery,
        monitor: f.monitor,
        neverCheck: f.neverCheck,
        routing: f.rules.length ? { rules: f.rules } : null,
        preview: f.preview,
        maxClicks: f.capOn ? capNumber : null,
        ...(f.passwordMode === "set" ? { password: f.password } : f.passwordMode === "remove" ? { password: null } : {}),
      };
      if (link) {
        const cut = f.replacement.indexOf("/");
        const replacement = f.broken && f.deadEnd === "link" && cut > 0 ? { domain: f.replacement.slice(0, cut), slug: f.replacement.slice(cut + 1) } : null;
        const json = { ...body, broken: f.broken, replacement };
        return (await call(api.links[":domain"][":slug"].$patch({ param: { domain: link.domain, slug: link.slug }, json }))).link;
      }
      return (await call(api.links.$post({ json: { ...body, domain: domain || undefined, slug: f.slug.trim() || undefined } }))).link;
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.cap(saved.domain, saved.slug) });
      qc.setQueryData(keys.link(saved.domain, saved.slug), { link: saved });
      toast.success(editing ? "Link updated" : "Link created", {
        description: "Live worldwide within about a minute.",
        action: editing ? undefined : { label: "Copy", onClick: () => void copy(saved.shortUrl) },
      });
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      const saved = linkFromError(err);
      if (saved) {
        void qc.invalidateQueries({ queryKey: keys.allLinks });
        toast.warning("Saved, but not published yet", { description: "Run “Republish all links” in Settings." });
        onSaved?.(saved);
        onOpenChange(false);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Couldn't save the link");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (errors.utmTemplate) setAdvanced(true);
    if (routingErrors.length) setRoutingOpen(true);
    if (previewProblems.length) setPreviewOpen(true);
    if (passwordError || capError) setProtectionOpen(true);
    if (valid && !save.isPending) save.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={link ? `Edit ${label(link)}` : f.bio ? "Create a bio page" : "Create a new link"}
      description={editing ? "Update your destination and link preferences." : f.bio ? "A page of buttons at one short address, for a profile or a bio." : "A shorter link. A lasting connection."}
      wide={(routingOpen && f.rules.length) || (previewOpen && f.preview) || f.bio ? "xl" : true}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Segmented<"redirect" | "bio">
          label="Link type"
          value={f.bio ? "bio" : "redirect"}
          onChange={(t) =>
            setF((s) =>
              t === "bio"
                ? { ...s, bio: s.bio ?? { ...DEFAULT_BIO, name: s.title }, target: s.target || fallbackUrl }
                : { ...s, bio: null },
            )
          }
          options={[
            { value: "redirect", label: "Redirect" },
            { value: "bio", label: "Bio page" },
          ]}
        />
        {f.bio ? <BioEditor value={f.bio} onChange={(b) => set("bio", b)} domain={domain} slug={f.slug} problems={touched ? bioProblems : []} /> : null}
        <Field
          label={f.bio ? "Fallback address" : "Destination URL"}
          htmlFor="target"
          hint={f.bio ? "Where anything that can't show the page goes, such as an older Worker." : "Where should this link take people?"}
          info={LINK_HELP.target}
          error={touched || f.target ? errors.target : null}
        >
          <Input
            id="target"
            type="url"
            aria-required="true"
            aria-invalid={Boolean((touched || f.target) && errors.target)}
            inputMode="url"
            autoFocus={!editing}
            placeholder="https://example.com/…"
            value={f.target}
            onChange={(e) => set("target", e.target.value)}
          />
          {checkout ? <p className="mt-1.5 text-xs text-muted">{checkout}</p> : null}
          {link?.unsafe && f.target.trim() === link.target ? (
            <div className="mt-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
              Cloudflare's security service lists this destination as malware or phishing{trust ? "" : ", so visitors see a warning before going on"}.
              <label className="mt-1.5 flex items-center gap-2 text-fg">
                <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />I trust this destination: don't warn visitors
              </label>
            </div>
          ) : null}
          {duplicates.length && !errors.target ? (
            <p className="mt-1.5 text-xs text-warn" role="status">
              Already shortened as{" "}
              {duplicates.slice(0, 3).map((d, i) => (
                <span key={linkKey(d.domain, d.slug)}>
                  {i ? ", " : ""}
                  <Link to={linkPath(d)} className="font-medium underline underline-offset-2" onClick={() => onOpenChange(false)}>
                    {label(d)}
                  </Link>
                </span>
              ))}
              {duplicates.length > 3 ? ` and ${duplicates.length - 3} more` : ""}. You can still create another (for example, to track a different channel).
            </p>
          ) : null}
        </Field>

        {!editing ? (
          <Field
            label="Domain"
            htmlFor="domain"
            info={LINK_HELP.domain}
            hint={
              multiple ? (
                "Each domain has its own short links."
              ) : (
                <>
                  Your only short domain so far.{" "}
                  <Link to="/settings#domains" className="font-medium text-accent hover:underline" onClick={() => onOpenChange(false)}>
                    Add another domain
                  </Link>
                </>
              )
            }
          >
            <Select id="domain" value={domain} onChange={(e) => set("domain", e.target.value)} disabled={!multiple}>
              {(domains.length ? domains : [domain || "your-domain"]).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {!editing ? (
          <Field
            label="Custom slug (your own link ending)"
            htmlFor="slug"
            hint={
              f.slug.trim() ? (
                <>
                  Your short link: <span className="font-medium text-fg">{domain || "your-domain"}/{f.slug.trim()}</span>
                </>
              ) : (
                `Optional. Type your own word or phrase to go after ${domain || "your-domain"}/, e.g. webinar-2026. Leave blank for a random one.`
              )
            }
            error={errors.slug}
            info={LINK_HELP.slug}
          >
            {/* The fixed domain sits in a tinted add-on so the white part reads as the field to type in. */}
            <div className="flex h-10 items-stretch overflow-hidden rounded-lg border border-line bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
              <span className="flex shrink-0 items-center gap-2 border-r border-line bg-surface-2 px-3 text-sm text-muted">
                <Link2 className="size-4" />
                {domain || "your-domain"}/
              </span>
              <Input
                id="slug"
                className="h-full rounded-none border-0 bg-transparent shadow-none focus:ring-0"
                placeholder="type-your-own-slug"
                value={f.slug}
                onChange={(e) => set("slug", e.target.value)}
                autoComplete="off"
                aria-invalid={Boolean(errors.slug)}
              />
              {aiOn ? (
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-1 border-l border-line px-3 text-xs font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
                  disabled={!normalizedTarget || suggest.isPending}
                  onClick={() => suggest.mutate(normalizedTarget)}
                  title={normalizedTarget ? "Suggest slugs with Workers AI" : "Enter the destination first"}
                >
                  <Sparkles className="size-3.5" aria-hidden /> {suggest.isPending ? "Thinking…" : "Suggest"}
                </button>
              ) : null}
            </div>
            {suggest.data?.slugs.length ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Ideas:</span>
                {suggest.data.slugs.map((s) => (
                  <button key={s} type="button" className="rounded-full border border-line px-2 py-0.5 font-mono text-xs hover:border-accent hover:text-accent" onClick={() => set("slug", s)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor="title" hint="Only shown here in the admin" info={LINK_HELP.title}>
            <Input id="title" value={f.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Tags" htmlFor="tags" hint="Comma-separated" info={LINK_HELP.tags}>
            <Input id="tags" placeholder="linkedin, ebook" value={f.tags} onChange={(e) => set("tags", e.target.value)} />
          </Field>
        </div>

        <details open={routingOpen} onToggle={(e) => setRoutingOpen(e.currentTarget.open)} className="group/routing rounded-md border border-line bg-bg">
          <summary className="flex list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <Split className="size-4 shrink-0 text-accent" aria-hidden />
            <span className="whitespace-nowrap">Smart routing</span>
            <InfoTip help={LINK_HELP.routing} />
            <span className={cn("mr-3 ml-auto hidden min-w-0 truncate text-xs font-normal sm:block", routingErrors.length && touched ? "text-danger" : "text-muted")}>
              {routingErrors.length && touched ? "Needs attention" : f.rules.length ? describeRouting({ rules: f.rules }) : "Off · by device, country or A/B test"}
            </span>
            <ChevronDown className="ml-auto size-4 shrink-0 transition-transform group-open/routing:rotate-180 sm:ml-0" />
          </summary>
          <div className="border-t border-line p-4">
            <RoutingEditor rules={f.rules} onChange={(rules) => set("rules", rules)} fallback={targetCheck?.ok ? targetCheck.url : f.target.trim()} errors={touched ? routingErrors : []} />
          </div>
        </details>

        <details open={previewOpen} onToggle={(e) => setPreviewOpen(e.currentTarget.open)} className="group/preview rounded-md border border-line bg-bg">
          <summary className="flex list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <MessageSquareText className="size-4 shrink-0 text-accent" aria-hidden />
            <span className="whitespace-nowrap">Social preview</span>
            <InfoTip help={LINK_HELP.preview} />
            <span className={cn("mr-3 ml-auto hidden min-w-0 truncate text-xs font-normal sm:block", previewProblems.length && touched ? "text-danger" : "text-muted")}>
              {previewProblems.length && touched ? "Needs attention" : f.preview ? `Custom: ${f.preview.title || "untitled"}` : "Destination's own"}
            </span>
            <ChevronDown className="ml-auto size-4 shrink-0 transition-transform group-open/preview:rotate-180 sm:ml-0" />
          </summary>
          <div className="border-t border-line p-4">
            <PreviewEditor
              value={f.preview}
              onChange={(p) => set("preview", p)}
              destination={targetCheck?.ok ? targetCheck.url : null}
              domain={link?.domain ?? domain}
              problems={touched ? previewProblems : []}
            />
          </div>
        </details>

        <details open={protectionOpen} onToggle={(e) => setProtectionOpen(e.currentTarget.open)} className="group/protection rounded-md border border-line bg-bg">
          <summary className="flex list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ShieldCheck className="size-4 shrink-0 text-accent" aria-hidden />
            <span className="whitespace-nowrap">Protection</span>
            <span className={cn("mr-3 ml-auto hidden min-w-0 truncate text-xs font-normal sm:block", (passwordError || capError) && touched ? "text-danger" : "text-muted")}>
              {(passwordError || capError) && touched
                ? "Needs attention"
                : [
                    (link?.protected && f.passwordMode !== "remove") || f.passwordMode === "set" ? "Password" : null,
                    f.capOn && !capError ? `Limit ${capNumber.toLocaleString("en")} visits` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Off · password or visit limit"}
            </span>
            <ChevronDown className="ml-auto size-4 shrink-0 transition-transform group-open/protection:rotate-180 sm:ml-0" />
          </summary>
          <div className="border-t border-line p-4">
            <LinkProtection
              link={link}
              mode={f.passwordMode}
              onMode={(m) => set("passwordMode", m)}
              password={f.password}
              onPassword={(p) => set("password", p)}
              passwordError={touched || f.password ? passwordError : null}
              capOn={f.capOn}
              onCapOn={(v) => set("capOn", v)}
              maxClicks={f.maxClicks}
              onMaxClicks={(v) => set("maxClicks", v)}
              capError={capError}
            />
          </div>
        </details>

        <details open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)} className="group rounded-md border border-line bg-bg">
          <summary className="flex list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">Link settings <span className="ml-auto mr-3 text-xs font-normal text-muted">Tracking, expiry & notes</span><ChevronDown className="size-4 transition-transform group-open:rotate-180" /></summary>
          <div className="space-y-4 border-t border-line p-4">
        <Field label="Notes" htmlFor="notes" info={LINK_HELP.notes}>
          <Textarea id="notes" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>

        <Field label="Expires" htmlFor="expires" hint="After this moment the link shows the “not found” page. Leave empty to keep it forever." info={LINK_HELP.expires}>
          <div className="flex gap-2">
            <Input id="expires" type="datetime-local" value={f.expires} onChange={(e) => set("expires", e.target.value)} />
            {f.expires ? (
              <Button type="button" variant="outline" onClick={() => set("expires", "")}>
                Clear
              </Button>
            ) : null}
          </div>
        </Field>

        <div className="space-y-4 rounded-lg border border-line p-4">
          <Switch id="active" checked={f.active} onCheckedChange={(v) => set("active", v)} label="Active" description="Disabled links show the “not found” page." info={LINK_HELP.active} />
          {editing ? (
            <Switch
              id="broken"
              checked={f.broken}
              onCheckedChange={(v) => set("broken", v)}
              label="Link no longer working"
              description="Visitors see a notice instead of the destination."
              info={LINK_HELP.broken}
            />
          ) : null}
          {editing && f.broken ? (
            <div className="space-y-3">
              <Segmented
                label="What visitors see"
                value={f.deadEnd}
                onChange={(v) => set("deadEnd", v)}
                options={[
                  { value: "page", label: "Error page" },
                  { value: "link", label: "Another of my links" },
                ]}
              />
              {f.deadEnd === "page" ? (
                <p className="text-xs leading-relaxed text-muted">
                  The “This link no longer works” page, then the site set in{" "}
                  {manageSettings ? (
                    <Link to="/settings#dead-link" className="font-medium text-accent hover:underline" onClick={() => onOpenChange(false)}>
                      Settings
                    </Link>
                  ) : (
                    "Settings"
                  )}{" "}
                  after a few seconds.
                </p>
              ) : (
                <Field
                  label="Replacement link"
                  htmlFor="replacement"
                  hint="The page says this link no longer works, with a button to the one you pick."
                  info={LINK_HELP.replacement}
                  error={touched ? errors.replacement : null}
                >
                  <Combobox
                    id="replacement"
                    value={f.replacement}
                    onChange={(v) => set("replacement", v)}
                    disabled={candidates.isPending}
                    placeholder={candidates.isPending ? "Loading links…" : candidates.isError && !candidates.data ? "Your links couldn’t load; close and reopen to retry" : "Search by slug or title…"}
                    options={[
                      ...(f.replacement && !replacementOptions.some((l) => linkKey(l.domain, l.slug) === f.replacement) && !candidates.isPending
                        ? [{ value: f.replacement, label: f.replacement, note: "deleted" }]
                        : []),
                      ...replacementOptions.map((l) => {
                        const state = linkState(l);
                        return {
                          value: linkKey(l.domain, l.slug),
                          label: label(l),
                          detail: l.title ?? undefined,
                          note: state === "active" ? undefined : state === "broken" ? (l.replacement ? "replaced" : "retired") : state,
                        };
                      }),
                    ]}
                  />
                </Field>
              )}
            </div>
          ) : null}
          <Switch
            id="utm"
            checked={f.utm}
            onCheckedChange={(v) => set("utm", v)}
            label="Add UTM parameters"
            description="Appends the UTM template on redirect. Existing UTM values in the target are kept."
            info={LINK_HELP.utm}
          />
          {f.utm ? (
            <LinkUtm
              custom={f.utmCustom}
              onCustom={(v) => setF((s) => ({ ...s, utmCustom: v, utmProblem: v ? s.utmProblem : null }))}
              template={f.utmTemplate}
              onTemplate={(t, problem) => setF((s) => ({ ...s, utmTemplate: t, utmProblem: problem }))}
              target={targetCheck?.ok ? targetCheck.url : ""}
              slug={link?.slug ?? f.slug.trim()}
              onClose={() => onOpenChange(false)}
            />
          ) : null}
          {touched && errors.utmTemplate ? (
            <p role="alert" className="text-xs text-danger">
              UTM: {errors.utmTemplate}
            </p>
          ) : null}
          <Switch
            id="passQuery"
            checked={f.passQuery}
            onCheckedChange={(v) => set("passQuery", v)}
            label="Pass query parameters through"
            description="Forwards extra ?params from the short link (except s and q=1) to the destination."
            info={LINK_HELP.passQuery}
          />
          <Switch
            id="monitor"
            checked={f.monitor}
            onCheckedChange={(v) => setF((s) => ({ ...s, monitor: v, neverCheck: v ? false : s.neverCheck }))}
            label="Check that the destination works"
            description={
              checkAll
                ? "Link health checks every link right now, so this one is checked unless it's set to never be checked. Switch this on to keep it checked if that changes to only the links switched on."
                : "Off unless you switch it on. Adds this link to the checks under Link health, which run once automatic checking is turned on there, and alerts you if it stops loading."
            }
            info={LINK_HELP.monitor}
          />
          <Switch
            id="neverCheck"
            checked={f.neverCheck}
            onCheckedChange={(v) => setF((s) => ({ ...s, neverCheck: v, monitor: v ? false : s.monitor }))}
            label="Never check this link"
            description="Keeps it out of destination checks, even when Link health checks every link. For pages behind a login, or that block automated visitors."
            info={LINK_HELP.neverCheck}
          />
        </div>

          </div>
        </details>
        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending} disabled={touched && !valid}>
            {editing ? "Save changes" : "Create link"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What happens to sales when a link points straight at a hosted checkout page. */
function checkoutHint(target: string): string | null {
  if (!target) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const provider = checkoutProvider(url);
  if (provider) {
    return `A ${PROVIDER_INFO[provider].label} checkout: sales through it are credited to this link once ${PROVIDER_INFO[provider].label} is connected to one of your websites (Websites → Settings → Payment providers).`;
  }
  if (/(^|\.)paddle\.(io|com)$|(^|\.)paypal\.com$|\.onfastspring\.com$/.test(url.hostname)) {
    return "This checkout can't carry a reference from a link, so its sales can't be credited to the link directly. Send buyers through a page of your tracked website instead.";
  }
  return null;
}
