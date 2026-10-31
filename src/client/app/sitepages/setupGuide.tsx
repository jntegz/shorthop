// The payment setup manual of Settings and setup (#setup-guide): one
// provider at a time, from creating the webhook to a verified test payment.

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { PROVIDER_INFO, PROVIDERS, type Provider, type SiteDTO } from "../../../shared/sites";
import { Section, Select } from "../ui";
import { C, Code } from "./parts";
import { suggestedSecretName } from "./providers";

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
        { label: "Checkout link (no code)", code: `<!-- The script adds metadata_sh_ref=<ref> -->
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
    <Section
      id="setup-guide"
      title="Setup guide"
      sub="Step by step for each provider, with examples. Pick one."
      aside={<Select label="Provider" hideLabel className="sitepage-toolfield" value={p} onChange={(e) => setP(e.target.value as Provider)} options={PROVIDERS.map((x) => ({ value: x, label: PROVIDER_INFO[x].label }))} />}
    >
      <div className="sitepage-prose">
        <h3 className="sitepage-h3">1. Install the tracking script</h3>
        <p>Install the script, at the top of this page, in the &lt;head&gt; of every page, including the checkout and thank-you pages.</p>

        <h3 className="sitepage-h3">2. Switch {info.label} on and create its webhook</h3>
        <ol>
          <li>Under Payment providers, switch on <strong>{info.label}</strong>. Its webhook address appears.</li>
          <li>In {info.label}: <strong>{info.where}</strong>. Paste the address.</li>
          <li>Choose these events: <C>{info.events.join(", ")}</C>.</li>
          {p === "paypal" ? <li>Copy the <strong>Webhook ID</strong> PayPal shows, and your app’s <strong>Client ID</strong>, into the PayPal settings here.</li> : null}
          {p === "gumroad" ? <li>Gumroad doesn’t sign its pings: the random token in the address is the proof. Add an access token too, so each sale is confirmed with Gumroad before it’s counted.</li> : null}
        </ol>

        <h3 className="sitepage-h3">3. Add the secrets (safely)</h3>
        <p>Keep secrets as <strong>Cloudflare Worker secrets</strong>: only their name is saved here, the value stays in Cloudflare. In the project folder:</p>
        <Code label="commands">{[secretName && `npx wrangler secret put ${secretName}`, keyName && `npx wrangler secret put ${keyName}${info.apiKey?.required ? "" : "   # optional"}`].filter(Boolean).join("\n") || "# No secret needed for this provider"}</Code>
        <p>
          Wrangler asks for the value and deploys it at once. In the dashboard instead: Workers &amp; Pages → your Worker → Settings → Variables and Secrets → Add, type <em>Secret</em>, then Deploy. Then type the same name under {info.label} → “Cloudflare secret” → <strong>Use this name</strong>. For local testing, use “Paste here” instead: wrangler dev only loads the secrets listed in wrangler.jsonc.
        </p>

        <h3 className="sitepage-h3">4. Pass the visit reference through checkout</h3>
        <p>{info.checkout}</p>
        {checkoutExamples(p, domain).map((ex) => (
          <div key={ex.label} className="sitepage-example">
            <p className="sitepage-label">{ex.label}</p>
            <Code label={ex.label}>{ex.code}</Code>
          </div>
        ))}

        <h3 className="sitepage-h3">5. Check it</h3>
        <ol>
          <li>Press <strong>Check connection</strong> under {info.label}: every line should be green, except “Webhooks” until the first one arrives.</li>
          <li>Send a test event from {info.label} (or make a test-mode purchase). The check then shows when it arrived; the payment appears under Payments, marked “test” and left out of revenue.</li>
          <li>To see matching work, open your site in a private window, click the buy button, pay in test mode, and look for “Checkout reference” in the Payments list.</li>
        </ol>

        <h3 className="sitepage-h3">How secrets are protected</h3>
        <ul>
          <li><strong>Cloudflare secret (recommended):</strong> the value is encrypted by Cloudflare and only this Worker can read it. Shorthop stores just its name; the admin, the database and backups never contain it.</li>
          <li>
            <strong>Pasted here:</strong> encrypted with AES-256-GCM before it’s stored, with a key from the <C>ENCRYPTION_KEY</C> Cloudflare secret (or, without one, derived from <C>SESSION_SECRET</C>), so the database alone can’t reveal it. It’s never shown or sent back to the browser. Without ENCRYPTION_KEY, rotating SESSION_SECRET makes pasted secrets unreadable: paste them again.
          </li>
          <li>Only people with <em>Manage websites</em> can add or change secrets. A connection can’t be pointed at the Worker’s own secrets (SESSION_SECRET and the like): those names are refused.</li>
          <li>Every webhook is verified before anything is stored (signature, URL token or PayPal’s own check), and each event is processed once, so a replayed request does nothing.</li>
          <li>Use read-only or restricted API keys where the provider offers them (Stripe restricted keys, Paddle per-permission keys).</li>
        </ul>

        <p className="sitepage-note">
          Docs:{" "}
          <a href={info.docs} target="_blank" rel="noreferrer" className="ui-text-button sitepage-ext">
            {info.label} webhooks
            <ExternalLink aria-hidden />
            <span className="ui-sr"> (opens in a new tab)</span>
          </a>
          {" · "}Webhook base address: <C>{`${origin}/_pay/`}</C>
        </p>
      </div>
    </Section>
  );
}
