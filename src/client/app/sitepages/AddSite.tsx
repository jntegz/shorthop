// "Add a website" (a ui Dialog): domain, name, time zone (the browser's by
// default) and currency; on success the new site's
// Settings and setup opens, where the script and payments are set up.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { SiteDTO } from "../../../shared/sites";
import { api, ApiError, call, keys } from "../../api";
import { browserTimeZone, currencyOptions, timeZones } from "../../lib/sites";
import { Button, Dialog, Input } from "../ui";
import { sitePages } from "../sites/common";
import { ComboField, zoneOptions } from "./parts";

export function AddSite({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [currency, setCurrency] = useState("USD");
  const zones = useMemo(() => zoneOptions([...new Set([timezone, ...timeZones()])]), [timezone]);
  const currencies = useMemo(() => currencyOptions(), []);
  const create = useMutation({
    mutationFn: () => call(api.sites.$post({ json: { name: name.trim() || domain.trim(), domains: [domain], timezone, currency } })),
    onSuccess: (site: SiteDTO) => {
      void qc.invalidateQueries({ queryKey: keys.sites });
      toast.success(`${site.name} added`, { description: "Next: install the script and connect your payments." });
      onOpenChange(false);
      setName("");
      setDomain("");
      navigate(sitePages.settings(site.id));
    },
  });
  const error = !create.error ? null : create.error instanceof ApiError ? create.error.message : "Couldn’t reach the server. Check your connection and try again.";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a website"
      description="A site you own. Days are counted in its time zone and revenue is shown in its currency."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="sitepage-add-site" variant="primary" loading={create.isPending}>
            Add website
          </Button>
        </>
      }
    >
      <form id="sitepage-add-site" onSubmit={submit} className="sitepage-form">
        <Input
          id="site-domain"
          label="Domain"
          hint="Subdomains count too: example.com covers app.example.com."
          required
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
        <Input id="site-name" label="Name" placeholder={domain || "My product"} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="sitepage-grid2">
          <ComboField id="site-tz" label="Time zone" value={timezone} onChange={(v) => v && setTimezone(v)} options={zones} placeholder="Type a city or region…" />
          <ComboField
            id="site-currency"
            label="Currency"
            hint="Payments in other currencies are converted at the day’s ECB rate."
            value={currency}
            onChange={(v) => v && setCurrency(v)}
            options={currencies}
            placeholder="Type a code or name…"
          />
        </div>
        {error ? (
          <p role="alert" className="ui-field-error">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
