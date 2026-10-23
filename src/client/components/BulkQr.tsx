import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DEFAULT_QR_STYLE } from "../../shared/qr";
import type { LinkListItem } from "../../shared/types";
import { api, call, keys } from "../api";
import { num } from "../lib/format";
import { logoDataUrl, qrText, renderQrSvg, zipQrCodes } from "../lib/qr";
import { download } from "../lib/utils";
import { Button, Dialog, Notice, Segmented, Select } from "./ui";

/** Most codes in one ZIP: PNGs are drawn one by one in the browser. */
const MAX_BULK = 500;

/** Links → QR codes: every link in the current list as SVG or PNG, zipped with a CSV map. */
export function BulkQr({ open, onOpenChange, links, label, filtered }: { open: boolean; onOpenChange: (o: boolean) => void; links: LinkListItem[]; label: (l: LinkListItem) => string; filtered: boolean }) {
  const defaults = useQuery({ queryKey: keys.qrDefault, queryFn: () => call(api.qr.default.$get()), enabled: open });
  const [format, setFormat] = useState<"svg" | "png">("svg");
  const [px, setPx] = useState(1024);
  const [progress, setProgress] = useState<number | null>(null);
  const list = links.slice(0, MAX_BULK);
  const custom = list.filter((l) => l.qr).length;

  const run = async () => {
    const base = defaults.data?.style ?? DEFAULT_QR_STYLE;
    setProgress(0);
    try {
      const used = new Set<string>();
      const blob = await zipQrCodes(
        list.map((l) => {
          let file = `qr-${label(l).replace(/^\//, "").replace(/[^A-Za-z0-9._~-]+/g, "-")}`;
          while (used.has(file)) file += "-";
          used.add(file);
          const style = l.qr ?? base;
          return {
            file,
            render: async () => renderQrSvg(qrText(l.shortUrl), style, style.logo ? await logoDataUrl(style.logo.key) : null),
            row: [l.shortUrl, qrText(l.shortUrl), l.target, l.title ?? ""],
          };
        }),
        format,
        px,
        setProgress,
      );
      download(`qr-codes-${new Date().toISOString().slice(0, 10)}.zip`, blob);
      toast.success(`${num(list.length)} QR codes downloaded`, { description: "The ZIP includes qr-codes.csv, which maps each file to its link." });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the QR codes");
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => progress === null && onOpenChange(o)}
      title="Download QR codes"
      description={`One code for each of the ${num(list.length)} ${filtered ? "links matching your filters" : "links"}, in a ZIP with a CSV that maps files to links.`}
    >
      <div className="space-y-4">
        {links.length > MAX_BULK ? <Notice>Only the first {num(MAX_BULK)} links are included. Narrow the list with a search or a tag to get the rest.</Notice> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Format" value={format} onChange={setFormat} options={[{ value: "svg", label: "SVG (any size, for print)" }, { value: "png", label: "PNG" }]} />
          {format === "png" ? (
            <Select aria-label="PNG width" className="h-9 w-auto text-xs" value={px} onChange={(e) => setPx(Number(e.target.value))}>
              {[512, 1024, 2048].map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          {custom ? `${num(custom)} ${custom === 1 ? "link uses its" : "links use their"} own saved design; the rest use the default design.` : "All codes use the default design."} Change the default from any link's QR studio.
        </p>
        {progress !== null ? (
          <div className="space-y-1.5" role="status">
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(progress / Math.max(1, list.length)) * 100}%` }} />
            </div>
            <p className="text-xs text-muted tabular">
              {num(progress)} of {num(list.length)}
            </p>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={progress !== null}>
            Cancel
          </Button>
          <Button onClick={() => void run()} loading={progress !== null} disabled={!list.length || !defaults.data}>
            {progress === null ? <Download /> : null} Download ZIP
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
