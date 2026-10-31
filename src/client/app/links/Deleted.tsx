// Links → Recently deleted: links that can still be brought back, and the
// restore that the dialog and a delete's "Undo" share.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { DELETED_RETENTION_DAYS } from "../../../shared/history";
import { api, call, keys } from "../../api";
import { actorName } from "../../components/LinkHistory";
import { ago, hostOf, whenFull } from "../../lib/format";
import { linkKey, linkPath, useLinkLabel } from "../../lib/links";
import { useCan } from "../../lib/me";
import { Button, Dialog, Empty, ErrorState, SkeletonText } from "../ui";

/** Brings back a deleted link; shared by the dialog and the "Undo" after a delete. */
export function useRestoreDeleted() {
  const qc = useQueryClient();
  const label = useLinkLabel();
  return useMutation({
    mutationFn: (l: { domain: string; slug: string }) => call(api.deleted[":domain"][":slug"].restore.$post({ param: l })),
    onSuccess: ({ link }) => {
      qc.setQueryData(keys.link(link.domain, link.slug), { link });
      void qc.invalidateQueries({ queryKey: keys.allLinks });
      void qc.invalidateQueries({ queryKey: keys.deleted });
      void qc.invalidateQueries({ queryKey: keys.checks });
      toast.success(`${label(link)} restored`, { description: "Live again worldwide within about a minute, with its stats." });
    },
    onError: (e) => toast.error(e.message),
  });
}

export function DeletedLinks({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const label = useLinkLabel();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: keys.deleted, queryFn: () => call(api.deleted.$get()), enabled: open });
  const restore = useRestoreDeleted();
  const canRestore = useCan()("links.delete");
  const links = q.data?.links ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Recently deleted"
      description={`Deleted links can be brought back for ${DELETED_RETENTION_DAYS} days, with their slug, settings and stats, as long as no new link has taken the slug.`}
      size="lg"
    >
      {q.isPending ? (
        <SkeletonText lines={4} />
      ) : q.isError ? (
        <ErrorState what="deleted links" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : links.length === 0 ? (
        <Empty title="Nothing deleted recently" compact>
          Links you delete show up here for {DELETED_RETENTION_DAYS} days.
        </Empty>
      ) : (
        <ul className="links-deleted">
          {links.map((l) => {
            const busy = restore.isPending && restore.variables?.domain === l.domain && restore.variables.slug === l.slug;
            return (
              <li key={linkKey(l.domain, l.slug)} className="links-deleted-row">
                <div className="links-deleted-main">
                  <p className="links-deleted-name">
                    {label(l)}
                    {l.title ? <span className="links-deleted-title">{l.title}</span> : null}
                  </p>
                  <p className="links-deleted-meta" title={l.target}>
                    {hostOf(l.target)} · deleted <span title={whenFull(l.deletedAt)}>{ago(l.deletedAt)}</span> by {actorName(l.actor)}
                  </p>
                </div>
                {canRestore ? (
                  <Button
                    size="sm"
                    icon={busy ? undefined : RotateCcw}
                    loading={busy}
                    disabled={restore.isPending && !busy}
                    onClick={() =>
                      restore.mutate(l, {
                        onSuccess: ({ link }) => {
                          onOpenChange(false);
                          navigate(linkPath(link));
                        },
                      })
                    }
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
