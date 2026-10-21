# iOS Shortcut: shorten a link from the share sheet

Creates a short link from any app's share sheet and copies it to the clipboard. With a saved token it takes about 3 seconds.

## Build it

1. Open **Shortcuts** → **+** → name it **Shorten link**.
2. Tap the **ⓘ** (details) button → turn on **Show in Share Sheet**, and set the input types to **URLs** and **Safari web pages**.
3. Add these actions in order:

   | # | Action | Settings |
   |---|---|---|
   | 1 | **Ask for Input** (optional) | Prompt: "Custom slug (leave empty for random)", Input Type: Text |
   | 2 | **Get Contents of URL** | URL: `https://ADMIN_HOST/api/links?format=text` · Method: **POST** · Headers: `Authorization` = `Bearer YOUR_API_TOKEN` · Request Body: **JSON** with `url` (Text) = **Shortcut Input**, and `slug` (Text) = **Provided Input** from step 1 |
   | 3 | **If** | *Contents of URL* **begins with** `https://` |
   | 4 | **Copy to Clipboard** | *Contents of URL* |
   | 5 | **Show Notification** | "Copied *Contents of URL*" |
   | 6 | **Otherwise** → **Get Dictionary Value** | Key `error` in *Contents of URL* (errors come back as JSON) |
   | 7 | **Show Alert** | *Dictionary Value* |
   | 8 | **End If** | |

4. Replace `ADMIN_HOST` with your admin host (the primary short domain if you have no separate one), and `YOUR_API_TOKEN` with the API token the setup showed you (stored in your password manager).

If you skip step 1, leave out `slug` and every link gets a random 6-character slug.

## Use it

Share any page → **Shorten link** → paste anywhere. The new link works worldwide within about a minute and shows up in the admin right away.

Add `?s=li` (LinkedIn), `?s=nl` (newsletter) or any other tag when you post the link. It attributes clicks to that source even when the app sends no referrer.

## Troubleshooting

| Message | Cause |
|---|---|
| `Missing or invalid API token.` | The `Authorization` header is wrong or the token was rotated (`npm run setup -- secrets --rotate`) |
| `Too many failed attempts…` | 10 bad tokens in a minute from your IP; wait a minute |
| `Target must start with https://.` | The shared item isn't an https URL |
| `slug: "x" is already taken on <domain>.` | Pick another slug |
| A web page or a Cloudflare Access sign-in instead of a link | Access covers `/api`: limit the Access application to the paths `_admin` and `_admin/*` ([setup manual](SETUP.md#access)) |

## Same thing from a terminal

```sh
curl -X POST 'https://ADMIN_HOST/api/links?format=text' \
  -H "Authorization: Bearer $SHORTHOP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/new-post","slug":"new-post","tags":["linkedin"]}'
```

The JSON body also accepts `domain` (another of your short domains; the primary one by default), `title`, `notes`, `expiresAt` (ISO date or unix seconds), `utm` (true/false) and `passQuery` (true/false). Without `?format=text`, the response is the full link as JSON.
