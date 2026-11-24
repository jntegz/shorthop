// A software passkey for tests: an ES256 key pair that answers WebAuthn
// registration and sign-in requests the way a browser and authenticator do
// (attestation "none", user verified), so the server's real checks run.

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// --- Just enough CBOR ---------------------------------------------------------

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  const parts: Uint8Array[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concat(...parts);
}

// --- The authenticator ------------------------------------------------------------

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

/** Raw r||s (WebCrypto) to the DER sequence WebAuthn signatures use. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([2, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export interface SoftPasskey {
  id: string;
  /** Answers a registration request (PublicKeyCredentialCreationOptionsJSON). */
  register(options: { challenge: string; rp: { id?: string } }, origin: string): Promise<Record<string, unknown>>;
  /** Answers a sign-in request (PublicKeyCredentialRequestOptionsJSON). */
  signIn(options: { challenge: string; rpId?: string }, origin: string, opts?: { counter?: number; userVerified?: boolean }): Promise<Record<string, unknown>>;
}

export async function softPasskey(): Promise<SoftPasskey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const id = b64url(credId);
  const cose = cbor(
    new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, raw.slice(1, 33)],
      [-3, raw.slice(33, 65)],
    ]),
  );
  let counter = 0;

  return {
    id,
    async register(options, origin) {
      const rpId = options.rp.id ?? new URL(origin).hostname;
      const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const credLen = new Uint8Array([0, credId.length]);
      const authData = concat(await sha256(enc.encode(rpId)), new Uint8Array([0x45]), u32(counter), new Uint8Array(16), credLen, credId, cose);
      const attestation = cbor(
        new Map<string, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ["internal"] },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    async signIn(options, origin, opts = {}) {
      counter = opts.counter ?? counter + 1;
      const rpId = options.rpId ?? new URL(origin).hostname;
      const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const flags = opts.userVerified === false ? 0x01 : 0x05;
      const authData = concat(await sha256(enc.encode(rpId)), new Uint8Array([flags]), u32(counter));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, concat(authData, await sha256(clientData))));
      return {
        id,
        rawId: id,
        type: "public-key",
        response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(derSignature(sig)) },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
