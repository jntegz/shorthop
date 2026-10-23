import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DEAD_LINK_MAX_DELAY, DEAD_LINK_MIN_DELAY, DEFAULT_DEAD_LINK, normalizeDeadLink, renderDeadLink, type DeadLinkPage } from "../../shared/dead-link";
import { normalizeNotFound } from "../../shared/not-found";
import { deadLinkSchema } from "../../shared/schemas";
import { api, call, keys } from "../api";
import { linkKey, linkState, useLinkLabel } from "../lib/links";
import { Button, Card, CardHeader, Field, Input, Notice, Segmented, Select, Spinner, Textarea } from "./ui";

const QUERY_KEY = ["settings", "dead-link"] as const;
/** Shared with NotFoundEditor: the colors come from there. */
const NOT_FOUND_KEY = ["settings", "not-found"] as const;

type Variant = "replaced" | "gone";

/** Settings → "Link no longer working" page: the wording of both variants, where to send visitors, and how soon. */
export function DeadLinkEditor({ domain }: { domain: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: () => call(api.settings["dead-link"].$get()) });
  const style = useQuery({ queryKey: NOT_FOUND_KEY, queryFn: () => call(api.settings["not-found"].$get()) });
  const [draft, setDraft] = useState<DeadLinkPage | null>(null);
  const [variant, setVariant] = useState<Variant>("replaced");
  // Which of your links the "with replacement" preview points to ("domain/slug", "" for a placeholder).
  const [sample, setSample] = useState("");
  const label = useLinkLabel();
  const saved = q.data?.page;

  // Same list as the link form's replacement picker: links that work right now.
  const candidates = useQuery({
    queryKey: keys.links({ picker: true }),
    queryFn: () => call(api.links.$get({ query: { sort: "slug", period: "7d" } })),
  });
  const sampleOptions = (candidates.data?.links ?? []).filter((l) => linkState(l) === "active");

  useEffect(() => {
    if (saved && draft === null) setDraft(saved);
  }, [saved, draft]);

  const save = useMutation({
    mutationFn: (d: DeadLinkPage) => call(api.settings["dead-link"].$put({ json: d })),
    onSuccess: ({ page }) => {
      qc.setQueryData(QUERY_KEY, (old: typeof q.data) => (old ? { ...old, page } : old));
      setDraft(page);
      toast.success("“Link no longer working” page saved", { description: "Visitors see it within about a minute." });
    },
    onError: (e) => toast.error(e.message),
  });

  // Same rule as the Worker's deadLinkRedirectUrl, from the not-found settings as they're saved.
  const defaultRedirect = style.data ? style.data.page.buttonUrl || style.data.fallbackUrl : (q.data?.defaultRedirectUrl ?? "");
  const html = useMemo(() => {
    if (!draft || !style.data) return "";
    const page = normalizeDeadLink(draft);
    return renderDeadLink(
      page,
      { ...normalizeNotFound(style.data.page), image: null },
      { domain, address: `${domain}/old-link`, imageSrc: null },
      variant === "replaced"
        ? { kind: "replaced", href: "#", label: sample || `${domain}/new-link` }
        : { kind: "gone", redirectUrl: page.redirectUrl || defaultRedirect },
    )
      // The preview never navigates away on its own.
      .replace(/<meta http-equiv="refresh"[^>]*>\n?/, "");
  }, [draft, style.data, domain, variant, defaultRedirect, sample]);

  if (q.isError) return <Notice tone="danger">{q.error.message}</Notice>;
  if (q.isPending || !draft) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader title="“Link no longer working” page" />
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      </Card>
    );
  }
  const set = <K extends keyof DeadLinkPage>(k: K, v: DeadLinkPage[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const check = deadLinkSchema.safeParse(draft);
  const badUrl = !deadLinkSchema.shape.redirectUrl.safeParse(draft.redirectUrl).success;
  const badDelay = !deadLinkSchema.shape.delaySeconds.safeParse(draft.delaySeconds).success;

  return (
    <Card className="lg:col-span-2" id="dead-link">
      <CardHeader
        title="“Link no longer working” page"
        description="What visitors see for a link you've marked as no longer working (in the link's settings). Uses the colors of the not-found page."
      />
      <div className="grid gap-6 px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <section
            className={`space-y-4 rounded-xl border p-4 transition-colors ${variant === "replaced" ? "border-accent" : "border-line"}`}
            onFocus={() => setVariant("replaced")}
            onClick={() => setVariant("replaced")}
          >
            <div>
              <p className="text-sm font-medium text-fg">With a replacement link</p>
              <p className="mt-1 text-xs text-muted">
                Shown when the link has a replacement. You pick the replacement for each link in its settings (Edit → Replacement link), not here.
              </p>
            </div>
            <Field label="Heading" htmlFor="dl-r-heading" error={draft.replacedHeading.trim() ? null : "Add a heading"}>
              <Input id="dl-r-heading" maxLength={120} value={draft.replacedHeading} onChange={(e) => set("replacedHeading", e.target.value)} />
            </Field>
            <Field label="Message" htmlFor="dl-r-message" hint="Shown above the button to the replacement link.">
              <Textarea id="dl-r-message" rows={3} maxLength={600} value={draft.replacedMessage} onChange={(e) => set("replacedMessage", e.target.value)} />
            </Field>
            <Field label="Button text" htmlFor="dl-r-button" error={draft.replacedButton.trim() ? null : "Add a button label"}>
              <Input id="dl-r-button" maxLength={60} value={draft.replacedButton} onChange={(e) => set("replacedButton", e.target.value)} />
            </Field>

            <Field label="Preview with" htmlFor="dl-sample" hint="Only changes the preview, so you can see the page with one of your links.">
              <Select id="dl-sample" value={sample} onChange={(e) => setSample(e.target.value)} disabled={candidates.isPending}>
                <option value="">{candidates.isPending ? "Loading links…" : `Example: ${domain}/new-link`}</option>
                {sampleOptions.map((l) => {
                  const key = linkKey(l.domain, l.slug);
                  return (
                    <option key={key} value={key}>
                      {label(l)}
                      {l.title ? ` · ${l.title}` : ""}
                    </option>
                  );
                })}
              </Select>
            </Field>
          </section>

          <section
            className={`space-y-4 rounded-xl border p-4 transition-colors ${variant === "gone" ? "border-accent" : "border-line"}`}
            onFocus={() => setVariant("gone")}
            onClick={() => setVariant("gone")}
          >
            <div>
              <p className="text-sm font-medium text-fg">Without a replacement</p>
              <p className="mt-1 text-xs text-muted">
                Shown when the link has no replacement, or the replacement no longer works. Visitors are sent on automatically.
              </p>
            </div>
            <Field label="Heading" htmlFor="dl-g-heading" error={draft.goneHeading.trim() ? null : "Add a heading"}>
              <Input id="dl-g-heading" maxLength={120} value={draft.goneHeading} onChange={(e) => set("goneHeading", e.target.value)} />
            </Field>
            <Field label="Message" htmlFor="dl-g-message" hint="{seconds} becomes the delay below.">
              <Textarea id="dl-g-message" rows={3} maxLength={600} value={draft.goneMessage} onChange={(e) => set("goneMessage", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Button text" htmlFor="dl-g-button" hint="Leave empty to hide the button.">
                <Input id="dl-g-button" maxLength={60} value={draft.goneButton} onChange={(e) => set("goneButton", e.target.value)} />
              </Field>
              <Field
                label="Redirect after (seconds)"
                htmlFor="dl-delay"
                error={badDelay ? `Between ${DEAD_LINK_MIN_DELAY} and ${DEAD_LINK_MAX_DELAY} seconds` : null}
              >
                <Input
                  id="dl-delay"
                  type="number"
                  min={DEAD_LINK_MIN_DELAY}
                  max={DEAD_LINK_MAX_DELAY}
                  value={Number.isFinite(draft.delaySeconds) ? draft.delaySeconds : ""}
                  onChange={(e) => set("delaySeconds", e.target.valueAsNumber)}
                />
              </Field>
            </div>
            <Field
              label="Redirect to"
              htmlFor="dl-url"
              hint={`Empty uses the not-found page's button link: ${defaultRedirect}`}
              error={badUrl ? "Use a full https:// address" : null}
            >
              <Input
                id="dl-url"
                type="url"
                placeholder={defaultRedirect}
                value={draft.redirectUrl}
                onChange={(e) => set("redirectUrl", e.target.value.trim())}
              />
            </Field>
          </section>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setDraft({ ...DEFAULT_DEAD_LINK })}>
              <RotateCcw /> Restore defaults
            </Button>
            <Button variant="outline" onClick={() => setDraft(saved!)} disabled={!dirty}>
              Discard
            </Button>
            <Button onClick={() => check.success && save.mutate(check.data)} disabled={!dirty || !check.success} loading={save.isPending}>
              Save
            </Button>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
            <span>Preview (doesn't change any link)</span>
            <Segmented<Variant>
              value={variant}
              onChange={setVariant}
              label="Preview variant"
              options={[
                { value: "replaced", label: "With replacement" },
                { value: "gone", label: "No replacement" },
              ]}
            />
          </div>
          <iframe title="“Link no longer working” page preview" sandbox="" srcDoc={html} className="h-[520px] w-full rounded-xl border border-line bg-white" />
        </div>
      </div>
    </Card>
  );
}
