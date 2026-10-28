import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { downloadFile } from "../api";
import { Button } from "./ui";

/** An export button: fetches `href` with the admin session, then saves it. */
export function DownloadButton({ href, title, size, children }: { href: string; title?: string; size?: "sm" | "md"; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size={size}
      title={title}
      loading={busy}
      onClick={() => {
        setBusy(true);
        downloadFile(href)
          .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Export failed"))
          .finally(() => setBusy(false));
      }}
    >
      {children}
    </Button>
  );
}
