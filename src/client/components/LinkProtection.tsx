import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, KeyRound, RotateCcw, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LINK_ACCESS_HOURS, LINK_PASSWORD_MAX, LINK_PASSWORD_MIN, MAX_CLICK_LIMIT } from "../../shared/protection";
import { api, call, keys } from "../api";
import { num } from "../lib/format";
import { cn, copy } from "../lib/utils";
import { Button, Input, Switch } from "./ui";

export type PasswordMode = "keep" | "set" | "remove";

const WORDS = ["amber", "breeze", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lumen", "meadow", "nova", "orbit", "pebble", "quartz", "river", "sierra", "timber", "umber", "velvet", "willow", "zephyr"];

/** Three words and two digits: easy to read out, hard to guess. */
function suggestPassword(): string {
  const r = crypto.getRandomValues(new Uint32Array(4));
  return `${WORDS[r[0]! % WORDS.length]}-${WORDS[r[1]! % WORDS.length]}-${WORDS[r[2]! % WORDS.length]}-${r[3]! % 90 + 10}`;
}

/** A capped link's counter, with a reset. */
function CapCounter({ domain, slug, limit }: { domain: string; slug: string; limit: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.cap(domain, slug), queryFn: () => call(api.links[":domain"][":slug"].cap.$get({ param: { domain, slug } })) });
  const reset = useMutation({
    mutationFn: () => call(api.links[":domain"][":slug"].cap.reset.$post({ param: { domain, slug } })),
    onSuccess: (r) => {
      qc.setQueryData(keys.cap(domain, slug), r);
      toast.success("Click count reset", { description: `The link opens ${num(limit)} more times.` });
    },
    onError: (e) => toast.error(e.message),
  });
  if (!q.data) return null;
  const used = Math.min(q.data.count, limit);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">
          <span className="font-medium text-fg tabular">{num(q.data.count)}</span> of {num(limit)} used{q.data.count >= limit ? " · visitors now see the “limit reached” page" : ""}
        </span>
        <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline disabled:opacity-50" onClick={() => reset.mutate()} disabled={reset.isPending || q.data.count === 0}>
          <RotateCcw className="size-3" /> Reset count
        </button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div className={cn("h-full rounded-full", used >= limit ? "bg-danger" : "bg-accent")} style={{ width: `${(used / limit) * 100}%` }} />
      </div>
    </div>
  );
}

/** Link form → Protection: a password, and a limit on how many times the link opens. */
export function LinkProtection({
  link,
  mode,
  onMode,
  password,
  onPassword,
  passwordError,
  capOn,
  onCapOn,
  maxClicks,
  onMaxClicks,
  capError,
}: {
  /** The saved link when editing, for the current state and the counter. */
  link?: { domain: string; slug: string; protected: boolean; maxClicks: number | null };
  mode: PasswordMode;
  onMode: (m: PasswordMode) => void;
  password: string;
  onPassword: (p: string) => void;
  passwordError: string | null;
  capOn: boolean;
  onCapOn: (on: boolean) => void;
  maxClicks: string;
  onMaxClicks: (v: string) => void;
  capError: string | null;
}) {
  const [show, setShow] = useState(false);
  const hasPassword = link?.protected ?? false;
  const editingPassword = mode === "set";

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <KeyRound className="size-4 text-accent" aria-hidden /> Password
            </p>
            <p className="text-xs text-muted">
              {mode === "remove"
                ? "Will be removed when you save: anyone with the link can open it."
                : hasPassword && mode === "keep"
                  ? "Set. Visitors enter it before they're sent on."
                  : "Visitors enter it before they're sent on."}
            </p>
          </div>
          {!editingPassword ? (
            <div className="flex gap-2">
              {mode === "remove" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onMode("keep")}>
                  Keep password
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onMode("set");
                      onPassword("");
                    }}
                  >
                    {hasPassword ? "Change" : "Add a password"}
                  </Button>
                  {hasPassword ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => onMode("remove")}>
                      Remove
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
        {editingPassword ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  id="link-password"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  aria-label={hasPassword ? "New password" : "Password"}
                  aria-invalid={Boolean(passwordError)}
                  maxLength={LINK_PASSWORD_MAX}
                  className="pr-10"
                  value={password}
                  placeholder={hasPassword ? "New password" : `At least ${LINK_PASSWORD_MIN} characters`}
                  onChange={(e) => onPassword(e.target.value)}
                  autoFocus
                />
                <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onPassword(suggestPassword());
                  setShow(true);
                }}
              >
                <Wand2 /> Suggest
              </Button>
              {password ? (
                <Button type="button" variant="ghost" size="icon" aria-label="Copy password" onClick={() => void copy(password, "Password copied")}>
                  <Copy />
                </Button>
              ) : null}
            </div>
            {passwordError ? (
              <p role="alert" className="text-xs text-danger">
                {passwordError}
              </p>
            ) : null}
            <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => onMode("keep")}>
              {hasPassword ? "Keep the current password" : "Cancel"}
            </button>
          </div>
        ) : null}
        {(hasPassword && mode !== "remove") || editingPassword ? (
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">
            <li>A correct password is remembered in that browser for {LINK_ACCESS_HOURS} hours. Changing it signs everyone out.</li>
            <li>Share it separately from the link. It can't be shown again later, only replaced.</li>
            <li>This protects the short link, not the destination: anyone who has the destination's own address can still open it.</li>
          </ul>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <Switch
          id="cap-on"
          label="Limit how many times it opens"
          description="After that many visits, people see a “limit reached” page. Bots and link previews don't use any."
          checked={capOn}
          onCheckedChange={onCapOn}
        />
        {capOn ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                id="max-clicks"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_CLICK_LIMIT}
                aria-label="Most visits allowed"
                aria-invalid={Boolean(capError)}
                className="w-40 tabular"
                value={maxClicks}
                onChange={(e) => onMaxClicks(e.target.value)}
              />
              <span className="text-sm text-muted">visits</span>
            </div>
            {capError ? (
              <p role="alert" className="text-xs text-danger">
                {capError}
              </p>
            ) : null}
            {link?.maxClicks ? <CapCounter domain={link.domain} slug={link.slug} limit={link.maxClicks} /> : <p className="text-xs text-muted">Counting starts when you save.</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
