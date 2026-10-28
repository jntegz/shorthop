import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { splitKey } from "../../shared/domains";
import type { LinkDTO } from "../../shared/types";
import { api, call, keys } from "../api";
import { linkKey } from "../lib/links";
import { useMe } from "../lib/me";
import { LinkPicker } from "./LinkPicker";
import { Button, Dialog, Field, Notice, Segmented } from "./ui";

type OffMode = "page" | "home" | "link";

const OFF_MODES = [
  { value: "page", label: "Not-found page" },
  { value: "home", label: "Main site" },
  { value: "link", label: "Another of my links" },
] as const;

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "the main site";
  } catch {
    return url ?? "the main site";
  }
}

/**
 * Turning a link off or back on. Off asks where visitors go meanwhile, and says
 * that automatic destination checks pause while it's off.
 */
export function LinkPower({ link, open, onOpenChange }: { link: LinkDTO; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const fallback = hostOf(useMe().data?.workspace.fallbackUrl);
  const self = linkKey(link.domain, link.slug);
  const saved = link.offRedirect;
  const [mode, setMode] = useState<OffMode>(saved === "home" ? "home" : saved ? "link" : "page");
  const [other, setOther] = useState(saved && saved !== "home" ? linkKey(saved.domain, saved.slug) : "");

  const save = useMutation({
    mutationFn: (json: { active: boolean; offRedirect?: LinkDTO["offRedirect"] }) =>
      call(api.links[":domain"][":slug"].$patch({ param: { domain: link.domain, slug: link.slug }, json })),
    onSuccess: (data) => {
      qc.setQueryData(keys.link(link.domain, link.slug), data);
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      toast.success(data.link.active ? "Link turned back on" : "Link turned off", { description: "Takes effect worldwide within about a minute." });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!link.active) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} title="Turn this link back on?" description="Visitors are sent to its destination again.">
        <p className="mb-4 text-sm text-muted">
          Automatic destination checks resume too, if they were on for this link. You can change them in the Destination check card.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate({ active: true })} loading={save.isPending}>
            Enable link
          </Button>
        </div>
      </Dialog>
    );
  }

  const target = splitKey(other);
  const missingLink = mode === "link" && !target;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Turn this link off?" description="Visitors no longer reach its destination until you turn it back on.">
      <div className="space-y-4">
        <Field
          label="Send visitors to"
          htmlFor="off-mode"
          hint={
            mode === "page"
              ? "They see the “not found” page set in Settings."
              : mode === "home"
                ? `They're redirected to ${fallback}.`
                : "They're redirected to that link (its click is counted there too). If it stops working, they see the “not found” page."
          }
        >
          <div id="off-mode">
            <Segmented label="Send visitors to" value={mode} onChange={setMode} options={OFF_MODES} />
          </div>
        </Field>
        {mode === "link" ? (
          <Field label="Link" htmlFor="off-link">
            <LinkPicker id="off-link" value={other} onChange={(key) => setOther(key)} exclude={[self]} />
          </Field>
        ) : null}
        <Notice tone="accent">Automatic destination checks pause while the link is off. Its stats and history stay.</Notice>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={missingLink}
            loading={save.isPending}
            onClick={() => save.mutate({ active: false, offRedirect: mode === "home" ? "home" : mode === "link" && target ? target : null })}
          >
            Disable link
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
