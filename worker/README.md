# Cardshare v2 API (Cloudflare Worker): skeleton

This is not deployed and has no secrets. The app does not use it yet: with no `window.CARDSHARE_API` set, `sync.js`
answers every call from its built-in mock server. The routes and JSON shapes here match that mock exactly, so
switching over is one line in the page:

```html
<script>window.CARDSHARE_API="https://api.cardshare.io"</script>  <!-- before sync.js -->
```

| Route | Who | What |
|---|---|---|
| `POST /v1/discover {domain}` | phone | `{org:{name}}` if a verified, discoverable domain; else `{org:null}`. Only the domain is sent, never the address |
| `POST /v1/auth/link {email}` | phone | Always `202`, known address or not, so nobody can probe who is a customer |
| `POST /v1/auth/verify {token}` | phone | One-time link token → `{deviceToken}` |
| `GET /v1/card` | phone | The org-managed card, logos and `ETag`; `304` if unchanged, `410` once removed, `401` if signed out |
| `POST /v1/checkin {version}` | phone | `{changed}`: the cheap daily "anything changed?" |
| `POST /v1/auth/signout` | phone | Revokes this phone's token |
| `GET /v1/logos/<org>/<file>` | phone | Logo from R2; versioned file names, cached forever |
| `/v1/admin/...` | admin | Org settings, logos, employees (add, edit, remove), invites, activity. Admins sign in by magic link too |

Tokens (links, devices, admin sessions) are stored only as SHA-256 hashes. The employee's mobile, Personal card and
Links never reach this server.

## Before a first deploy

1. `wrangler d1 create cardshare` and put the id in `wrangler.toml`; `wrangler d1 execute cardshare --file=schema.sql`.
2. `wrangler r2 bucket create cardshare-logos`.
3. Pick an email provider, implement `sendMail()`, then `wrangler secret put MAIL_API_KEY`.
4. Still to build: rate limits on `/discover` and `/auth/link`, DNS TXT verification of domains, server-side SVG
   sanitising, the admin sign-in screen in `/admin/`, billing, data export and delete-my-data.
