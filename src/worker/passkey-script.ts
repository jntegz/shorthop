// The one script of the login pages (served at PASSKEY_SCRIPT by login.ts):
// "Sign in with a passkey". Plain browser JavaScript, no build step, so the
// pages keep a CSP of script-src 'self'. It asks for options, lets the
// browser talk to the passkey, sends the answer back and follows the result.

export const PASSKEY_LOGIN_JS = `(() => {
  const box = document.getElementById("passkey");
  if (!box || !window.PublicKeyCredential || !navigator.credentials) return;
  box.hidden = false;
  const button = box.querySelector("button");
  const error = document.getElementById("passkey-error");
  const b64 = (buf) => {
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const bytes = (s) => {
    const p = s.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(p + "===".slice((p.length + 3) % 4)), (c) => c.charCodeAt(0));
  };
  const post = async (url, body) => {
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  };
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
  };
  button.addEventListener("click", async () => {
    error.hidden = true;
    button.disabled = true;
    try {
      const start = await post("/_admin/login/passkey/options", {});
      if (!start.ok) return fail(start.body.error || "Passkeys can't be used right now. Use your password.");
      const o = start.body.options;
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: bytes(o.challenge),
          rpId: o.rpId,
          timeout: o.timeout,
          userVerification: o.userVerification,
          allowCredentials: (o.allowCredentials || []).map((c) => ({ type: "public-key", id: bytes(c.id), transports: c.transports })),
        },
      });
      if (!cred) return fail("No passkey was chosen.");
      const r = cred.response;
      const done = await post("/_admin/login/passkey", {
        next: box.dataset.next,
        response: {
          id: cred.id,
          rawId: b64(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: b64(r.clientDataJSON),
            authenticatorData: b64(r.authenticatorData),
            signature: b64(r.signature),
            ...(r.userHandle ? { userHandle: b64(r.userHandle) } : {}),
          },
          clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
          ...(cred.authenticatorAttachment ? { authenticatorAttachment: cred.authenticatorAttachment } : {}),
        },
      });
      if (!done.ok) return fail(done.body.error || "That passkey didn't work. Try again, or use your password.");
      location.assign(done.body.next);
    } catch (err) {
      fail(err && err.name === "NotAllowedError" ? "The passkey request was cancelled or timed out. Try again." : "That didn't work. Try again, or use your password.");
    }
  });
})();
`;
