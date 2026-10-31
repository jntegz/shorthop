import { ArrowDown, ArrowUp, Heading, ImagePlus, Link2, Plus, RotateCcw, Trash2, Type } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  BIO_HEADING_MAX,
  BIO_TEXT_BLOCK_MAX,
  BIO_THEMES,
  bioTextOn,
  contrastRatio,
  isBioButton,
  MAX_BIO_BLOCKS,
  MAX_BIO_SOCIALS,
  renderBio,
  SOCIAL_NETWORK_IDS,
  SOCIAL_NETWORKS,
  type BioBlock,
  type BioPage,
  type BioSocial,
  type BioSocialPlace,
  type BioTheme,
  type SocialNetwork,
} from "../../shared/bio";
import { HEX_COLOR_RE } from "../../shared/not-found";
import { PREVIEW_IMAGE_PATH } from "../../shared/preview";
import { uploadPreviewImage } from "../api";
import { linkKey, useLinkLabel } from "../lib/links";
import { LinkPicker } from "./LinkPicker";
import { Button, errorMessage, Field, Input, Segmented, Select, Switch, Textarea } from "./ui";

/** The theme backgrounds renderBio uses, for contrast warnings when no background is set. */
const THEME_BG = { light: "#f6f7f9", dark: "#0f1116" } as const;

/** Moves item `i` of `list` by `by` places. */
function moved<T>(list: T[], i: number, by: number): T[] {
  const next = [...list];
  const [item] = next.splice(i, 1);
  next.splice(i + by, 0, item!);
  return next;
}

/**
 * The link-in-bio editor inside the link form: who you are, social links,
 * the page's content (buttons that are your own short links or plain
 * addresses, short texts and section titles), a share panel and colours.
 * A live preview beside it.
 */
export function BioEditor({ value, onChange, domain, slug, problems }: { value: BioPage; onChange: (b: BioPage) => void; domain: string; slug?: string; problems: string[] }) {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const set = <K extends keyof BioPage>(k: K, v: BioPage[K]) => onChange({ ...value, [k]: v });
  const socials = value.socials ?? [];
  const html = useMemo(
    () =>
      renderBio(
        {
          ...value,
          accent: HEX_COLOR_RE.test(value.accent) ? value.accent : "#6554c0",
          name: value.name || "Your name",
          blocks: value.blocks.length || socials.length ? value.blocks : [{ label: "Your first button", url: "https://example.com/" }],
        },
        {
          domain,
          scheme,
          linkHref: (l) => `https://${l.domain}/${l.slug}`,
          avatarSrc: value.avatarKey ? `${PREVIEW_IMAGE_PATH}${value.avatarKey}` : null,
          pageUrl: `https://${domain}/${slug || "your-page"}`,
        },
      ),
    [value, socials.length, domain, slug, scheme],
  );

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
      <div className="space-y-5">
        <Profile value={value} set={set} />
        <Socials socials={socials} place={value.socialsAt ?? "top"} onChange={(s) => set("socials", s)} onPlace={(p) => set("socialsAt", p)} />
        <Blocks blocks={value.blocks} domain={domain} onChange={(b) => set("blocks", b)} />
        <Section title="Sharing">
          <Switch
            id="bio-share"
            checked={value.share ?? false}
            onCheckedChange={(v) => set("share", v)}
            label="Show “Share this page”"
            description="A button at the end that shows this page's address, ready to copy, and shares it to LinkedIn, X, Facebook, WhatsApp, Telegram or email."
          />
        </Section>
        <Colours value={value} set={set} />
        {problems.length ? (
          <ul role="alert" className="list-disc space-y-0.5 pl-5 text-xs text-danger">
            {problems.slice(0, 4).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="space-y-2 md:sticky md:top-0 md:self-start">
        <Segmented<"light" | "dark"> label="Preview" value={scheme} onChange={setScheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <iframe title="Bio page preview" sandbox="" srcDoc={html} className="h-[560px] w-full rounded-md border border-line" />
        {value.background ? <p className="text-xs text-muted">A background colour replaces light and dark, so both previews look the same.</p> : null}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Up, down and remove, for a row in a list. */
function RowTools({ i, count, what, onMove, onRemove }: { i: number; count: number; what: string; onMove: (by: number) => void; onRemove: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${what} up`} disabled={i === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${what} down`} disabled={i === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${what}`} onClick={onRemove}><Trash2 /></Button>
    </div>
  );
}

function Profile({ value, set }: { value: BioPage; set: <K extends keyof BioPage>(k: K, v: BioPage[K]) => void }) {
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  return (
    <Section title="About you">
      <div className="flex items-center gap-3">
        {value.avatarKey ? <img src={`${PREVIEW_IMAGE_PATH}${value.avatarKey}`} alt="" className="size-12 rounded-full border border-line object-cover" /> : null}
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setUploading(true);
            uploadPreviewImage(f)
              .then((img) => set("avatarKey", img.key))
              .catch((err: unknown) => toast.error(errorMessage(err)))
              .finally(() => setUploading(false));
          }}
        />
        <Button type="button" variant="outline" size="sm" loading={uploading} onClick={() => file.current?.click()}>
          <ImagePlus /> {value.avatarKey ? "Change photo" : "Add a photo"}
        </Button>
        {value.avatarKey ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => set("avatarKey", null)}>
            Remove
          </Button>
        ) : null}
      </div>
      <Field label="Name or title" htmlFor="bio-name">
        <Input id="bio-name" maxLength={80} value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Alex Rivera" />
      </Field>
      <Field label="A line about you" htmlFor="bio-text" hint="Optional, up to 300 characters.">
        <Textarea id="bio-text" rows={2} maxLength={300} value={value.text} onChange={(e) => set("text", e.target.value)} placeholder="Writer and speaker." />
      </Field>
    </Section>
  );
}

function Socials({ socials, place, onChange, onPlace }: { socials: BioSocial[]; place: BioSocialPlace; onChange: (s: BioSocial[]) => void; onPlace: (p: BioSocialPlace) => void }) {
  const setRow = (i: number, s: BioSocial) => onChange(socials.map((x, j) => (j === i ? s : x)));
  const unused = SOCIAL_NETWORK_IDS.find((n) => !socials.some((s) => s.network === n)) ?? "website";
  return (
    <Section title="Social links" hint="Shown as icons. Each opens in a new tab (email opens the visitor's mail app).">
      {socials.map((s, i) => {
        const net = SOCIAL_NETWORKS[s.network];
        const isEmail = s.network === "email";
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <Select aria-label={`Social link ${i + 1} network`} className="h-9 w-36 shrink-0" value={s.network} onChange={(e) => setRow(i, { network: e.target.value as SocialNetwork, url: s.url })}>
              {SOCIAL_NETWORK_IDS.map((n) => (
                <option key={n} value={n}>
                  {SOCIAL_NETWORKS[n].label}
                </option>
              ))}
            </Select>
            <Input
              aria-label={`${net.label} ${isEmail ? "address" : "link"}`}
              className="h-9 min-w-0 flex-1"
              type={isEmail ? "email" : "url"}
              inputMode={isEmail ? "email" : "url"}
              value={isEmail ? s.url.replace(/^mailto:/i, "") : s.url}
              onChange={(e) => setRow(i, { network: s.network, url: e.target.value.trim() })}
              placeholder={net.hint}
            />
            <RowTools i={i} count={socials.length} what={`${net.label} link`} onMove={(by) => onChange(moved(socials, i, by))} onRemove={() => onChange(socials.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        {socials.length < MAX_BIO_SOCIALS ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...socials, { network: unused, url: "" }])}>
            <Plus /> Add a social link
          </Button>
        ) : null}
        {socials.length ? (
          <Segmented<BioSocialPlace>
            label="Where the icons go"
            value={place}
            onChange={onPlace}
            options={[
              { value: "top", label: "Under the name" },
              { value: "bottom", label: "At the end" },
            ]}
          />
        ) : null}
      </div>
    </Section>
  );
}

const KIND = {
  button: { icon: Link2, name: "Button" },
  text: { icon: Type, name: "Text" },
  heading: { icon: Heading, name: "Section title" },
} as const;

function kindOf(b: BioBlock): keyof typeof KIND {
  return isBioButton(b) ? "button" : b.type;
}

function Blocks({ blocks, domain, onChange }: { blocks: BioBlock[]; domain: string; onChange: (b: BioBlock[]) => void }) {
  const label = useLinkLabel();
  const setBlock = (i: number, b: BioBlock) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  let buttonNo = 0;
  return (
    <Section
      title="Page content"
      hint="Buttons to your own short links count their clicks, routing and sales on that link (tagged as coming from this page). The first button is highlighted. Section titles group the buttons under them."
    >
      {blocks.map((b, i) => {
        const kind = kindOf(b);
        const { icon: Icon, name } = KIND[kind];
        const n = kind === "button" ? ++buttonNo : 0;
        const what = kind === "button" ? `button ${n}` : `${name.toLowerCase()} ${i + 1}`;
        const tools = <RowTools i={i} count={blocks.length} what={what} onMove={(by) => onChange(moved(blocks, i, by))} onRemove={() => onChange(blocks.filter((_, j) => j !== i))} />;
        return (
          <div key={i} className="space-y-2 rounded-md border border-line p-2.5">
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center text-muted" title={name}>
                <Icon className="size-4" aria-hidden />
                <span className="sr-only">{name}</span>
              </span>
              {isBioButton(b) ? (
                <Input aria-label={`Button ${n} text`} className="h-9" maxLength={80} value={b.label} onChange={(e) => setBlock(i, { ...b, label: e.target.value })} placeholder="Button text" />
              ) : b.type === "heading" ? (
                <Input aria-label={`Section title ${i + 1}`} className="h-9 font-semibold" maxLength={BIO_HEADING_MAX} value={b.label} onChange={(e) => setBlock(i, { type: "heading", label: e.target.value })} placeholder="Section title, such as “My courses”" />
              ) : (
                <span className="flex-1 text-sm font-medium text-fg">Text</span>
              )}
              {tools}
            </div>
            {isBioButton(b) ? (
              <div className="flex flex-wrap items-center gap-2">
                <Segmented<"link" | "url">
                  label="Goes to"
                  value={"link" in b ? "link" : "url"}
                  onChange={(k) => setBlock(i, k === "link" ? { label: b.label, link: { domain, slug: "" } } : { label: b.label, url: "" })}
                  options={[
                    { value: "link", label: "One of my links" },
                    { value: "url", label: "An address" },
                  ]}
                />
                <div className="min-w-0 flex-1">
                  {"link" in b ? (
                    <LinkPicker
                      id={`bio-link-${i}`}
                      value={b.link.slug ? linkKey(b.link.domain, b.link.slug) : ""}
                      onChange={(_key, l) => setBlock(i, l ? { label: b.label || l.title || label(l), link: { domain: l.domain, slug: l.slug } } : { label: b.label, link: { domain, slug: "" } })}
                    />
                  ) : (
                    <Input aria-label={`Button ${n} address`} className="h-9" type="url" value={b.url} onChange={(e) => setBlock(i, { label: b.label, url: e.target.value.trim() })} placeholder="https://…" />
                  )}
                </div>
              </div>
            ) : b.type === "text" ? (
              <div>
                <Textarea aria-label={`Text ${i + 1}`} rows={3} maxLength={BIO_TEXT_BLOCK_MAX} value={b.text} onChange={(e) => setBlock(i, { type: "text", text: e.target.value })} placeholder="A short note, a quote, what you're working on…" />
                <p className={`mt-1 text-right text-xs tabular ${b.text.length > BIO_TEXT_BLOCK_MAX - 20 ? "text-warn" : "text-muted"}`} aria-live="polite">
                  {b.text.length} / {BIO_TEXT_BLOCK_MAX}
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
      {blocks.length < MAX_BIO_BLOCKS ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...blocks, { label: "", link: { domain, slug: "" } }])}>
            <Plus /> Button
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...blocks, { type: "text", text: "" }])}>
            <Plus /> Text
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...blocks, { type: "heading", label: "" }])}>
            <Plus /> Section title
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">That's the most a page can hold ({MAX_BIO_BLOCKS}).</p>
      )}
    </Section>
  );
}

/** A colour that can be left to the theme: swatch, hex field and a reset. */
function ColourField({ id, label, value, fallback, onChange, warning }: { id: string; label: string; value: string | null; fallback: string; onChange: (v: string | null) => void; warning?: string | null }) {
  return (
    <Field label={label} htmlFor={id} hint={warning ? <span className="text-warn">{warning}</span> : value ? undefined : "The theme's colour."}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={value && HEX_COLOR_RE.test(value) ? value : fallback}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-line bg-bg p-1"
        />
        <Input id={id} className="h-9 min-w-0 font-mono text-xs" maxLength={7} value={value ?? ""} placeholder="Theme" onChange={(e) => onChange(e.target.value.trim() || null)} />
        {value ? (
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Use the theme's ${label.toLowerCase()}`} title="Use the theme's colour" onClick={() => onChange(null)}>
            <RotateCcw />
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

function Colours({ value, set }: { value: BioPage; set: <K extends keyof BioPage>(k: K, v: BioPage[K]) => void }) {
  const ok = (c: string | null | undefined): string | null => (c && HEX_COLOR_RE.test(c) ? c : null);
  const bg = ok(value.background);
  const btn = ok(value.buttonColor);
  const icon = ok(value.iconColor);
  const accent = ok(value.accent);
  // What the colours sit on: the chosen background, or both theme backgrounds.
  const grounds = bg ? [bg] : value.theme === "auto" ? [THEME_BG.light, THEME_BG.dark] : [THEME_BG[value.theme]];
  const low = (c: string | null, min: number) => (c ? grounds.some((g) => contrastRatio(c, g) < min) : false);
  const bgWarning = bg && contrastRatio(bioTextOn(bg), bg) < 4.5 ? "Mid-tones make text hard to read; try lighter or darker." : null;
  const btnWarning = btn && contrastRatio(bioTextOn(btn), btn) < 4.5 ? "Button text may be hard to read on this colour." : low(btn, 1.3) ? "Buttons may blend into the background." : null;
  const iconWarning = low(icon, 3) ? "Icons may be hard to see on the background." : null;
  const accentWarning = accent && contrastRatio(bioTextOn(accent), accent) < 4.5 ? "The first button's text may be hard to read." : null;
  return (
    <Section title="Colours">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Theme" htmlFor="bio-theme" hint={bg ? "Not used: the background colour sets the page's look." : undefined}>
          <Select id="bio-theme" value={value.theme} disabled={Boolean(bg)} onChange={(e) => set("theme", e.target.value as BioTheme)}>
            {BIO_THEMES.map((t) => (
              <option key={t} value={t}>
                {t === "auto" ? "Follow the visitor" : t === "light" ? "Always light" : "Always dark"}
              </option>
            ))}
          </Select>
        </Field>
        <ColourField id="bio-background" label="Background" value={value.background ?? null} fallback={THEME_BG.light} onChange={(v) => set("background", v)} warning={bgWarning} />
        <ColourField id="bio-buttons" label="Buttons" value={value.buttonColor ?? null} fallback="#ffffff" onChange={(v) => set("buttonColor", v)} warning={btnWarning} />
        <ColourField id="bio-icons" label="Icons" value={value.iconColor ?? null} fallback="#1a1b25" onChange={(v) => set("iconColor", v)} warning={iconWarning} />
        <Field label="First button" htmlFor="bio-accent" hint={accentWarning ? <span className="text-warn">{accentWarning}</span> : "Highlights the first button."}>
          <div className="flex items-center gap-2">
            <input type="color" aria-label="First button picker" value={accent ?? "#6554c0"} onChange={(e) => set("accent", e.target.value)} className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-line bg-bg p-1" />
            <Input id="bio-accent" className="h-9 min-w-0 font-mono text-xs" maxLength={7} value={value.accent} onChange={(e) => set("accent", e.target.value.trim())} />
          </div>
        </Field>
      </div>
    </Section>
  );
}
