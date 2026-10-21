import { Download } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { download } from "../lib/utils";
import { Button, Dialog } from "./ui";

/**
 * QR codes encode ?s=qr so scans are attributed to print. Generated in the browser.
 * `label` names the link: "/guide", or "alt.example/guide" on another domain.
 */
export function QrDialog({ open, onOpenChange, shortUrl, label }: { open: boolean; onOpenChange: (o: boolean) => void; shortUrl: string; label: string }) {
  const url = `${shortUrl}?s=qr`;
  const fileName = `shorthop-${label.replace(/^\//, "").replace(/[^A-Za-z0-9._~-]+/g, "-")}`;
  const [svg, setSvg] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((s) => !cancelled && setSvg(s))
      .catch(() => toast.error("Couldn't generate the QR code"));
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  const png = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(url, { width: 1200, margin: 2, errorCorrectionLevel: "M" });
      const blob = await (await fetch(dataUrl)).blob();
      download(`${fileName}.png`, blob);
    } catch {
      toast.error("Couldn't create the PNG");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`QR code for ${label}`} description="Scans are tagged as source “QR code” in the stats.">
      <div className="space-y-4">
        <div className="mx-auto w-64 rounded-lg border border-line bg-white p-2">
          {svg ? (
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`QR code for ${url}`} className="block h-auto w-full" />
          ) : (
            <div className="aspect-square" />
          )}
        </div>
        <p className="text-center font-mono text-xs break-all text-muted">{url}</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => download(`${fileName}.svg`, svg, "image/svg+xml")} disabled={!svg}>
            <Download /> SVG
          </Button>
          <Button variant="outline" onClick={() => void png()}>
            <Download /> PNG
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
