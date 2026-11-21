// The click log's map: the live map's globe with a dot for each place a
// tracked link was clicked or its email opened. Loaded only when the map is
// shown; it draws in the browser from coordinates already in the click log.

import { useMemo, useState } from "react";
import type { TrackedClickDTO } from "../../../shared/tracking";
import { countryName, num } from "../../lib/format";
import { Globe, type GlobePoint } from "../hits/LiveMap";
import { BreakdownList, Switch, type BreakdownItem } from "../ui";

export default function ClickMap({ clicks }: { clicks: TrackedClickDTO[] }) {
  const [spinning, setSpinning] = useState(false);
  const points = useMemo<GlobePoint[]>(
    () => clicks.filter((k) => k.latitude !== null && k.longitude !== null && !(k.latitude === 0 && k.longitude === 0)).map((k) => ({ ts: k.at, lat: k.latitude!, lon: k.longitude! })),
    [clicks],
  );
  const places = useMemo<BreakdownItem[]>(() => {
    const m = new Map<string, number>();
    for (const k of clicks) {
      const name = [k.city, countryName(k.country)].filter(Boolean).join(", ") || "Unknown";
      m.set(name, (m.get(name) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ key: label, label, value, display: num(value) }));
  }, [clicks]);
  // The newest click with a place sits in the middle at first.
  const focus = points[0] ? ([points[0].lat, points[0].lon] as [number, number]) : undefined;
  return (
    <div className="ui-tk-map">
      <div>
        <Globe clicks={points} scale={1.4} spinning={spinning} focus={focus} label={`Globe with a dot for each place this link was opened (${points.length} with a location)`} />
        <Switch className="ui-tk-map-spin" checked={spinning} onCheckedChange={setSpinning} label="Turn the globe" />
      </div>
      <BreakdownList items={places} unit="visits" />
    </div>
  );
}
