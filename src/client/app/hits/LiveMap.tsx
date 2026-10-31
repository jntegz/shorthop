// The live map: totals as a stat strip, a globe drawn with the page's own
// tokens, and the busiest countries and links as breakdown lists.

import { useQuery } from "@tanstack/react-query";
import createGlobe, { type Marker } from "cobe";
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link } from "react-router";
import { api, call } from "../../api";
import { ago, countryName, num } from "../../lib/format";
import { linkPath, useDomains, useLinkLabel } from "../../lib/links";
import { cn } from "../../lib/utils";
import { NoneValue, RowsSkeleton } from "../parts";
import { BreakdownList, Button, ErrorState, Notice, Section, Segmented, Select, StatStrip, StatStripSkeleton, TextButton, type BreakdownItem } from "../ui";
import { StatsFreshness, whileActive } from "./freshness";
import { NeedsLiveData } from "./NeedsLiveData";

/** Dot sizes at 100%, as a share of the globe's radius: one click, and the busiest place. */
const MARKER_MIN = 0.012;
const MARKER_MAX = 0.035;
/** The dot-size slider: a multiplier of the sizes above, remembered in this browser. */
const SCALE_KEY = "globe-dot-scale";
const SCALE_MIN = 0.5;
const SCALE_MAX = 3;
/** Clicks this recent are drawn in the accent on the globe and marked in the list. */
const FRESH_SEC = 120;

type Click = { ts: number; domain: string; slug: string; country: string; city: string; device: string; lat: number; lon: number };
type Rgb = [number, number, number];

const WINDOWS = [
  { value: "15", label: "15 min", long: "15 minutes" },
  { value: "60", label: "1 hour", long: "hour" },
  { value: "1440", label: "24 hours", long: "24 hours" },
] as const;
type Minutes = (typeof WINDOWS)[number]["value"];

function savedScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    return v >= SCALE_MIN && v <= SCALE_MAX ? v : 1;
  } catch {
    return 1;
  }
}

/** Counts by key, busiest first. */
function tally<T>(list: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) {
    const k = key(x);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]);
}

// ---- Colours: the page's tokens, read as cobe's 0–1 RGB ----

let paint: CanvasRenderingContext2D | null = null;
/**
 * A token as 0–1 RGB. Tokens use light-dark(), color-mix() and relative
 * colours, so the computed value may be rgb(), oklab() or color(srgb …):
 * painting it into a 1 px canvas turns any of them into plain sRGB.
 */
function tokenRgb(name: string, fallback: Rgb): Rgb {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  try {
    paint ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!paint || !css) return fallback;
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = css;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
    return [r! / 255, g! / 255, b! / 255];
  } catch {
    return fallback;
  }
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

interface Palette {
  dark: boolean;
  base: Rgb;
  glow: Rgb;
  dot: Rgb;
  fresh: Rgb;
}

/**
 * The globe in the design's colours. Light: a panel-white sphere with ink land dots,
 * a sunken glow. Dark: a line-strong sphere (lighter than the canvas, so the
 * land shows) with a pressed glow. Clicks are ink (the neutral mark, like the
 * breakdown bars); the last two minutes are the accent (the one "now" colour).
 */
function readPalette(): Palette {
  const canvas = tokenRgb("--ui-canvas", [0.97, 0.98, 0.97]);
  const dark = luminance(canvas) < 0.5;
  return {
    dark,
    base: dark ? tokenRgb("--ui-line-strong", [0.22, 0.26, 0.23]) : tokenRgb("--ui-panel", [1, 1, 1]),
    glow: dark ? tokenRgb("--ui-pressed", [0.14, 0.17, 0.15]) : tokenRgb("--ui-sunken", [0.93, 0.95, 0.93]),
    dot: tokenRgb("--ui-ink", dark ? [0.89, 0.92, 0.9] : [0.07, 0.1, 0.08]),
    fresh: tokenRgb("--ui-accent", [0.23, 0.36, 0.86]),
  };
}

/** The palette, re-read when the theme, the system scheme or the accent changes. */
function usePalette(): Palette {
  const [p, setP] = useState(readPalette);
  useEffect(() => {
    const again = () => setP(readPalette());
    const mo = new MutationObserver(again);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", again);
    return () => {
      mo.disconnect();
      mq?.removeEventListener("change", again);
    };
  }, []);
  return p;
}

const rgbKey = (c: Rgb) => c.map((v) => v.toFixed(3)).join(",");

/**
 * Where people open links right now: the totals, a globe with a dot per place
 * (drag or use the arrow keys to turn it, pause the spin, set the dot size),
 * the busiest countries and links, and the latest clicks. One Analytics Engine
 * query every 30 seconds while the page is open and in use; it stops when idle.
 * The Worker reuses an answer for 20 seconds.
 */
export function LiveMap() {
  const [minutes, setMinutes] = useState<Minutes>("15");
  const { domains, multiple } = useDomains();
  const label = useLinkLabel();
  /** "" for every short domain. */
  const [domain, setDomain] = useState("");
  const [scale, setScale] = useState(savedScale);
  const [spinning, setSpinning] = useState(() => !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false));
  const live = useQuery({
    queryKey: ["stats", "live", minutes, domain],
    queryFn: () => call(api.stats.live.$get({ query: { minutes, ...(domain ? { domain } : {}) } })),
    // Switching window or domain keeps the dots until the new ones arrive.
    placeholderData: (prev) => prev,
    refetchInterval: whileActive(30_000),
  });
  const clicks: Click[] = useMemo(() => (live.data?.clicks ?? []) as Click[], [live.data]);
  const failed = live.data && "error" in live.data && typeof live.data.error === "string" ? live.data.error : null;
  const unavailable = live.data ? !live.data.aeAvailable : false;

  useEffect(() => {
    try {
      localStorage.setItem(SCALE_KEY, String(scale));
    } catch {
      // Private mode: the size lasts until the page is reloaded.
    }
  }, [scale]);

  if (unavailable) return <NeedsLiveData />;

  const win = WINDOWS.find((w) => w.value === minutes)!;
  const now = Math.floor(Date.now() / 1000);
  const countries = tally(clicks, (c) => c.country);
  const places = new Set(clicks.map((c) => `${c.country}|${c.city}`)).size;
  const byLink = tally(clicks, (c) => `${c.domain}/${c.slug}`);
  const none = !clicks.length;
  const count = (n: number) => (none ? <NoneValue /> : num(n));

  const countryItems: BreakdownItem[] = countries.map(([code, n]) => ({ key: code, label: countryName(code), title: code, value: n }));
  const linkItems: BreakdownItem[] = byLink.map(([key, n]) => {
    const i = key.indexOf("/");
    const l = { domain: key.slice(0, i), slug: key.slice(i + 1) };
    return { key, label: label(l), title: key, value: n, to: linkPath(l) };
  });

  return (
    <div className="hits-live">
      <div className="hits-bar">
        <div className="hits-bar-tools">
          {multiple ? (
            <Select
              label="Domain"
              hideLabel
              className="hits-pill"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              options={[{ value: "", label: "All domains" }, ...domains.map((d) => ({ value: d, label: d }))]}
            />
          ) : null}
          <Segmented<Minutes> label="Window" value={minutes} onChange={setMinutes} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
        </div>
        <p className="hits-bar-note">
          <StatsFreshness
            updatedAt={live.dataUpdatedAt}
            fetching={live.isFetching}
            onRefresh={() => void live.refetch()}
            note={
              <span className="hits-live-note">
                <span className="hits-live-dot" aria-hidden />
                Live, every 30 seconds
              </span>
            }
          />
        </p>
      </div>

      {/* One place for the window's state: after the tools, before the numbers. */}
      {live.isError && !live.data ? (
        <ErrorState what="Live clicks" error={live.error} onRetry={() => void live.refetch()} retrying={live.isFetching} />
      ) : failed ? (
        <Notice tone="warn" title="Analytics Engine didn’t answer." action={<Button size="sm" onClick={() => void live.refetch()} loading={live.isFetching}>Try again</Button>}>
          {failed === "Analytics Engine didn't answer. Try again in a moment." ? "Live clicks couldn’t be read just now. Try again in a moment." : failed}
        </Notice>
      ) : !live.isPending && none ? (
        <p className="hits-state-line" role="status">
          No clicks in the last {win.long}{domain ? ` on ${domain}` : ""} yet. They appear here within a minute or two.
        </p>
      ) : null}

      {live.isPending ? (
        <StatStripSkeleton count={4} className="hits-kpis" aria-busy />
      ) : (
        <StatStrip
          className="hits-kpis"
          items={[
            { id: "clicks", label: "Clicks", value: count(clicks.length), note: `Last ${win.long}` },
            { id: "countries", label: "Countries", value: count(countries.length) },
            { id: "places", label: "Places", value: count(places), note: "To the nearest city" },
            { id: "links", label: "Links", value: count(byLink.length) },
          ]}
        />
      )}

      <div className="hits-live-grid">
        <div className="hits-globe-col">
          <Globe clicks={clicks} scale={scale} spinning={spinning} />
          <div className="hits-globe-tools">
            <div className="hits-scale">
              <label htmlFor="hits-scale" className="hits-scale-label">
                Dot size
              </label>
              <input id="hits-scale" type="range" min={SCALE_MIN} max={SCALE_MAX} step={0.25} value={scale} onChange={(e) => setScale(Number(e.target.value))} aria-valuetext={`${Math.round(scale * 100)}%`} />
              <span className="hits-scale-value" aria-hidden>
                {Math.round(scale * 100)}%
              </span>
              {scale !== 1 ? (
                <TextButton onClick={() => setScale(1)} title="Back to 100%">
                  Reset
                </TextButton>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" icon={spinning ? Pause : Play} onClick={() => setSpinning((v) => !v)} aria-pressed={!spinning}>
              {spinning ? "Pause spin" : "Spin"}
            </Button>
            <span className="hits-legend">
              <span className="hits-legend-key">
                <span className="hits-legend-dot" aria-hidden /> Clicks
              </span>
              <span className="hits-legend-key">
                <span className="hits-legend-dot is-fresh" aria-hidden /> Last 2 minutes
              </span>
            </span>
          </div>
          <p className="hits-note">People only, to the nearest city (about 11 km). Drag the globe, or focus it and use the arrow keys, to turn it. Clicks from before the map was added have no location.</p>
        </div>

        <div className="hits-side">
          <Section title="Top countries" className="hits-side-section">
            {live.isPending ? <RowsSkeleton rows={4} /> : <BreakdownList items={countryItems} limit={8} emptyText="None in this window." />}
          </Section>
          <Section title="Links clicked" className="hits-side-section">
            {live.isPending ? <RowsSkeleton rows={3} /> : <BreakdownList items={linkItems} limit={8} emptyText="None in this window." />}
          </Section>
          <Section title="Latest clicks" className="hits-side-section">
            {live.isPending ? (
              <RowsSkeleton rows={5} />
            ) : none ? (
              <p className="ui-rows-empty">No clicks in this window. They appear here within a minute or two.</p>
            ) : (
              <ol className="hits-feed" aria-label="Latest clicks, newest first">
                {clicks.slice(0, 40).map((c, i) => {
                  const fresh = now - c.ts < FRESH_SEC;
                  return (
                    <li key={`${c.ts}-${i}`} className={cn("hits-feed-row", fresh && "is-fresh")}>
                      <span className="hits-feed-main">
                        <span className="hits-feed-place">{c.city ? `${c.city}, ${countryName(c.country)}` : countryName(c.country)}</span>
                        <span className="hits-feed-sub">
                          <Link to={linkPath(c)}>{label(c)}</Link>
                          {c.device ? ` · ${c.device[0]!.toUpperCase()}${c.device.slice(1)}` : ""}
                        </span>
                      </span>
                      <span className="hits-feed-time">
                        {fresh ? <span className="hits-legend-dot is-fresh" aria-hidden /> : null}
                        {ago(c.ts)}
                        {fresh ? <span className="ui-sr"> (in the last 2 minutes)</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

// ---- The globe ----

/**
 * cobe on a square canvas. Places within about half a degree (a city and its
 * suburbs) share one dot at their average; dots grow with the square root of
 * the count, so a busy city stands out without covering its neighbours; places
 * clicked in the last two minutes take the accent.
 */
function Globe({ clicks, scale, spinning }: { clicks: Click[]; scale: number; spinning: boolean }) {
  const palette = usePalette();
  const canvas = useRef<HTMLCanvasElement>(null);
  const markersRef = useRef<Marker[]>([]);
  const spinRef = useRef(spinning);
  spinRef.current = spinning;
  // Dragging turns the globe: the offsets add to the spin.
  const drag = useRef<{ x: number; y: number; phi: number; theta: number } | null>(null);
  const view = useRef({ phi: 0, theta: 0.25 });

  const markers = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const at = new Map<string, { lat: number; lon: number; n: number; fresh: boolean }>();
    for (const c of clicks) {
      const key = `${Math.round(c.lat * 2)},${Math.round(c.lon * 2)}`;
      const m = at.get(key) ?? { lat: 0, lon: 0, n: 0, fresh: false };
      m.lat += c.lat;
      m.lon += c.lon;
      m.n++;
      if (now - c.ts < FRESH_SEC) m.fresh = true;
      at.set(key, m);
    }
    const max = Math.max(1, ...[...at.values()].map((m) => m.n));
    return [...at.values()].map(
      (m): Marker => ({
        location: [m.lat / m.n, m.lon / m.n],
        size: scale * (MARKER_MIN + (MARKER_MAX - MARKER_MIN) * Math.sqrt((m.n - 1) / Math.max(1, max - 1))),
        ...(m.fresh ? { color: palette.fresh } : {}),
      }),
    );
  }, [clicks, scale, palette]);
  markersRef.current = markers;

  // Rebuilt only when the colours change (theme or accent); markers and the view are read each frame.
  const paletteKey = `${palette.dark}|${rgbKey(palette.base)}|${rgbKey(palette.glow)}|${rgbKey(palette.dot)}`;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const size = el.offsetWidth || 480;
    let frame = 0;
    const globe = createGlobe(el, {
      devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
      width: size * 2,
      height: size * 2,
      phi: view.current.phi,
      theta: view.current.theta,
      dark: palette.dark ? 1 : 0,
      diffuse: 1.2,
      mapSamples: 16000,
      // Land as a quiet grey on either sphere, so ink and accent dots stand out:
      // light, land = base × (1 − brightness); dark, land = base × brightness.
      mapBrightness: palette.dark ? 2.8 : 0.72,
      baseColor: palette.base,
      markerColor: palette.dot,
      glowColor: palette.glow,
      markerElevation: 0,
      markers: markersRef.current,
    });
    const draw = () => {
      if (spinRef.current && !drag.current) view.current.phi += 0.003;
      globe.update({ phi: view.current.phi, theta: view.current.theta, markers: markersRef.current });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      globe.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteKey]);

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, phi: view.current.phi, theta: view.current.theta };
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    view.current.phi = d.phi + (e.clientX - d.x) / 150;
    view.current.theta = Math.max(-1, Math.min(1, d.theta + (e.clientY - d.y) / 300));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 0.6 : 0.2;
    if (e.key === "ArrowLeft") view.current.phi -= step;
    else if (e.key === "ArrowRight") view.current.phi += step;
    else if (e.key === "ArrowUp") view.current.theta = Math.max(-1, view.current.theta - step / 2);
    else if (e.key === "ArrowDown") view.current.theta = Math.min(1, view.current.theta + step / 2);
    else return;
    e.preventDefault();
  };

  return (
    <div className="hits-globe">
      <canvas
        ref={canvas}
        className="hits-globe-canvas"
        role="img"
        tabIndex={0}
        aria-label={`Globe with a dot for each place links were opened${markers.length ? ` (${markers.length} ${markers.length === 1 ? "place" : "places"})` : ""}. Drag it, or use the arrow keys, to turn it.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKey}
      />
    </div>
  );
}
