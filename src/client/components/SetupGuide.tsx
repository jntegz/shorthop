import { BookOpen, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PROVIDER_INFO, PROVIDERS, type Provider, type SiteDTO } from "../../shared/sites";
import { copy } from "../lib/utils";
import { suggestedSecretName } from "./PaymentProviders";
import { Button, Card, CardHeader, Select } from "./ui";

function Code({ children, label }: { children: string; label: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3 pr-12 font-mono text-xs leading-relaxed text-fg">{children}</pre>
      <Button size="icon-sm" variant="ghost" className="absolute top-1.5 right-1.5" aria-label={`Copy ${label}`} onClick={() => void copy(children, "Copied")}>
        <Copy />
      </Button>
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h4 className="mt-5 mb-2 text-sm font-semibold text-fg first:mt-0">{children}</h4>;
}

/** Client and server examples: how the visit reference reaches each provider. */
function checkoutExamples(p: Provider, domain: string): { label: string; code: string }[] {
  const success = `https://${domain}/thanks`;
  const serverFetch = `// In the browser: send the visit reference with the checkout request
const res = await fetch("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "pro", ref: window.shorthop?.ref() }),
});
location.href = (await res.json()).url;`;
  switch (p) {
    case "stripe":
      return [
        { label: "Payment Link (no code)", code: `<!-- The script adds client_reference_id=sh_<ref> when the link is clicked -->
<a href="https://buy.stripe.com/abc123">Buy now</a>

<!-- In the Payment Link's settings, set the confirmation page to:
     ${success}?session_id={CHECKOUT_SESSION_ID} -->` },
        { label: "Checkout Session (your server)", code: `${serverFetch}

// On your server (Node, stripe package)
const session = await stripe.checkout.sessions.create({
  mode: "payment",                       // or "subscription"
  line_items: [{ price: "price_123", quantity: 1 }],
  client_reference_id: req.body.ref ? "sh_" + req.body.ref : undefined,
  success_url: "${success}?session_id={CHECKOUT_SESSION_ID}",
});
res.json({ url: session.url });` },
      ];
    case "paddle":
      return [
        { label: "Paddle.js (automatic)", code: `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  Paddle.Initialize({ token: "live_..." });
  // The tracker adds customData.sh_ref to every Paddle.Checkout.open call.
  document.querySelector("#buy").onclick = () =>
    Paddle.Checkout.open({ items: [{ priceId: "pri_123", quantity: 1 }] });
</script>` },
        { label: "Transaction from your server", code: `// POST https://api.paddle.com/transactions
{
  "items": [{ "price_id": "pri_123", "quantity": 1 }],
  "custom_data": { "sh_ref": "<ref from window.shorthop.ref()>" }
}` },
      ];
    case "lemonsqueezy":
      return [
        { label: "Checkout link (no code)", code: `<!-- The script adds checkout[custom][sh_ref]=<ref> -->
<a href="https://yourstore.lemonsqueezy.com/checkout/buy/VARIANT_ID">Buy now</a>` },
        { label: "Checkout from your server", code: `// POST https://api.lemonsqueezy.com/v1/checkouts
{
  "data": {
    "type": "checkouts",
    "attributes": { "checkout_data": { "custom": { "sh_ref": "<ref>" } } },
    "relationships": {
      "store":   { "data": { "type": "stores",   "id": "1" } },
      "variant": { "data": { "type": "variants", "id": "2" } }
    }
  }
}` },
      ];
    case "dodo":
      return [
        { label: "Checkout link (no code)", code: `<!-- The script adds metadata_tl_ref=<ref> -->
<a href="https://checkout.dodopayments.com/buy/pdt_123?quantity=1&redirect_url=${encodeURIComponent(success)}">Buy now</a>` },
        { label: "Checkout session from your server", code: `// POST https://live.dodopayments.com/checkouts
{
  "product_cart": [{ "product_id": "pdt_123", "quantity": 1 }],
  "metadata": { "sh_ref": "<ref>" },
  "return_url": "${success}"
}` },
      ];
    case "creem":
      return [
        { label: "Payment link (no code)", code: `<!-- The script adds metadata[sh_ref]=<ref> -->
<a href="https://www.creem.io/payment/prod_123">Buy now</a>` },
        { label: "Checkout from your server", code: `// POST https://api.creem.io/v1/checkouts   (header x-api-key)
{
  "product_id": "prod_123",
  "metadata": { "sh_ref": "<ref>" },
  "success_url": "${success}"
}` },
      ];
    case "gumroad":
      return [
        { label: "Product link (no code)", code: `<!-- The script adds ?sh_ref=<ref>; Gumroad sends it back as url_params[sh_ref] -->
<a href="https://you.gumroad.com/l/product">Buy on Gumroad</a>
<script src="https://gumroad.com/js/gumroad.js"></script>  <!-- the overlay works too -->` },
        { label: "Add every event (optional, API)", code: `# The Ping setting sends sales and refunds. For disputes and cancellations too:
for r in sale refund dispute dispute_won cancellation subscription_ended; do
  curl -X PUT https://api.gumroad.com/v2/resource_subscriptions \\
    -d access_token=$GUMROAD_ACCESS_TOKEN -d resource_name=$r \\
    -d post_url="<the webhook address above>"
done` },
      ];
    case "fastspring":
      return [
        { label: "Store Builder (automatic)", code: `<script id="fsc-api"
  src="https://sbl.onfastspring.com/sbl/1.0.1/fastspring-builder.min.js"
  type="text/javascript" data-storefront="yourstore.onfastspring.com/popup-yourstore"></script>
<!-- The tracker calls fastspring.builder.tag({ sh_ref }) as soon as both are loaded -->
<button data-fsc-item-path-value="your-product" data-fsc-action="Add,Checkout">Buy</button>` },
        { label: "Session from your server", code: `// POST https://api.fastspring.com/sessions   (Basic auth: API username:password)
{
  "account": "<account id>",
  "items": [{ "product": "your-product", "quantity": 1 }],
  "tags": { "sh_ref": "<ref>" }
}` },
      ];
    case "paypal":
      return [
        { label: "PayPal buttons (one-time)", code: `<script src="https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&currency=USD"></script>
<div id="paypal"></div>
<script>
  paypal.Buttons({
    createOrder: (data, actions) => actions.order.create({
      purchase_units: [{ amount: { value: "49.00" }, custom_id: window.shorthop?.ref() || undefined }],
    }),
    onApprove: (data, actions) => actions.order.capture(),
  }).render("#paypal");
</script>` },
        { label: "PayPal subscriptions", code: `<script src="https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&vault=true&intent=subscription"></script>
<script>
  paypal.Buttons({
    createSubscription: (data, actions) => actions.subscription.create({
      plan_id: "P-123",
      custom_id: window.shorthop?.ref() || undefined,
    }),
  }).render("#paypal");
</script>` },
      ];
  }
}

/** The manual: one provider at a time, from creating the webhook to a verified test payment. */
export function SetupGuide({ site, origin }: { site: SiteDTO; origin: string }) {
  const [p, setP] = useState<Provider>("stripe");
  const info = PROVIDER_INFO[p];
  const domain = site.domains[0] ?? "example.com";
  const secretName = info.webhookSecret ? suggestedSecretName(info.webhookSecret.suggestedName, site) : null;
  const keyName = info.apiKey ? suggestedSecretName(info.apiKey.suggestedName, site) : null;

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><BookOpen className="size-4 text-accent" /> Setup guide</span>}
        description="Step by step for each provider, with examples. Pick one."
        action={
          <Select aria-label="Provider" value={p} onChange={(e) => setP(e.target.value as Provider)} className="h-9 w-48">
            {PROVIDERS.map((x) => <option key={x} value={x}>{PROVIDER_INFO[x].label}</option>)}
          </Select>
        }
      />
      <div className="px-4 pb-5 text-sm leading-relaxed">
        <H>1. Install the tracking script</H>
        <p className="text-muted">Section 1 above, in the &lt;head&gt; of every page, including the checkout and thank-you pages.</p>

        <H>2. Switch {info.label} on and create its webhook</H>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>Under Payment providers, switch on <strong className="text-fg">{info.label}</strong>. Its webhook address appears.</li>
          <li>In {info.label}: <span className="text-fg">{info.where}</span>. Paste the address.</li>
          <li>Choose these events: <span className="font-mono text-xs text-fg">{info.events.join(", ")}</span>.</li>
          {p === "paypal" ? <li>Copy the <strong className="text-fg">Webhook ID</strong> PayPal shows, and your app's <strong className="text-fg">Client ID</strong>, into the PayPal settings here.</li> : null}
          {p === "gumroad" ? <li>Gumroad doesn't sign its pings: the random token in the address is the proof. Add an access token too, so each sale is confirmed with Gumroad before it's counted.</li> : null}
        </ol>

        <H>3. Add the secrets (safely)</H>
        <p className="text-muted">Keep secrets as <strong className="text-fg">Cloudflare Worker secrets</strong>: only their name is saved here, the value stays in Cloudflare. In the project folder:</p>
        <Code label="commands">{[secretName && `npx wrangler secret put ${secretName}`, keyName && `npx wrangler secret put ${keyName}${info.apiKey?.required ? "" : "   # optional"}`].filter(Boolean).join("\n") || "# No secret needed for this provider"}</Code>
        <p className="mt-2 text-muted">
          Wrangler asks for the value and deploys it at once. In the dashboard instead: Workers &amp; Pages → your Worker → Settings → Variables and Secrets → Add, type <em>Secret</em>, then Deploy. Then type the same name under {info.label} → "Cloudflare secret" → <strong className="text-fg">Use this name</strong>.
          {" "}For local testing, use "Paste here" instead: wrangler dev only loads the secrets listed in wrangler.jsonc.
        </p>

        <H>4. Pass the visit reference through checkout</H>
        <p className="mb-2 text-muted">{info.checkout}</p>
        <div className="space-y-3">
          {checkoutExamples(p, domain).map((ex) => (
            <div key={ex.label}>
              <p className="mb-1 text-xs font-medium text-muted">{ex.label}</p>
              <Code label={ex.label}>{ex.code}</Code>
            </div>
          ))}
        </div>

        <H>5. Check it</H>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>Press <strong className="text-fg">Check connection</strong> under {info.label}: every line should be green, except "Webhooks" until the first one arrives.</li>
          <li>Send a test event from {info.label} (or make a test-mode purchase). The check then shows when it arrived; the payment appears under Payments, marked "test" and left out of revenue.</li>
          <li>To see matching work, open your site in a private window, click the buy button, pay in test mode, and look for "Checkout reference" in the Payments list.</li>
        </ol>

        <div className="mt-6 rounded-md border border-line bg-surface-2/60 p-4">
          <p className="mb-2 flex items-center gap-2 font-semibold text-fg"><ShieldCheck className="size-4 text-good" /> How secrets are protected</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li><strong className="text-fg">Cloudflare secret (recommended):</strong> the value is encrypted by Cloudflare and only this Worker can read it. Shorthop stores just its name; the admin, the database and backups never contain it.</li>
            <li><strong className="text-fg">Pasted here:</strong> encrypted with AES-256-GCM before it's stored, with a key derived from <code className="font-mono text-xs">SESSION_SECRET</code>, which is itself a Cloudflare secret, so the database alone can't reveal it. It's never shown or sent back to the browser. Rotating SESSION_SECRET makes pasted secrets unreadable: paste them again.</li>
            <li>Only people with <em>Manage websites</em> can add or change secrets. A connection can't be pointed at the Worker's own secrets (SESSION_SECRET and the like): those names are refused.</li>
            <li>Every webhook is verified before anything is stored (signature, URL token or PayPal's own check), and each event is processed once, so a replayed request does nothing.</li>
            <li>Use read-only or restricted API keys where the provider offers them (Stripe restricted keys, Paddle per-permission keys).</li>
          </ul>
        </div>

        <p className="mt-4 text-xs text-muted">
          Docs: <a href={info.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{info.label} webhooks <ExternalLink className="size-3" /></a>
          {" · "}Webhook base address: <span className="font-mono">{origin}/_pay/</span>
        </p>
      </div>
    </Card>
  );
}
