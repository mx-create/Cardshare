# Cardshare v2 API (Cloudflare Worker): skeleton

This is not deployed and has no secrets. The app does not use it yet: with no `window.CARDSHARE_API` set, `sync.js`
answers every call from its built-in mock server and a simulated Microsoft 365 tenant. The routes and JSON shapes here
match that mock exactly, so switching over is one line in the page:

```html
<script>window.CARDSHARE_API="https://api.cardshare.io"</script>  <!-- before sync.js -->
```

## Two ways an organisation manages work cards

| | Microsoft 365 (Entra ID) | By hand (small firms) |
|---|---|---|
| Where staff details live | In the organisation's own directory. **Cardshare doesn't store them.** | In Cardshare's D1, as the admin typed them |
| A phone's check-in | Reads that one user from Graph (`GET /users/{id}?$select=…`), maps it, returns it, keeps nothing | Reads the row from D1 |
| Joiners | Appear automatically; they sign in with Microsoft or an email link | Admin adds them |
| Overrides | Full access: the admin can override any mapped field, name and work email included, for one person. Stored in `ms_overrides` | n/a (the admin edits the record) |
| Leavers | Disabled or deleted in Microsoft 365 → next check-in answers `410` → phone wipes the card | Admin removes them → row deleted → `410` |
| Offline | A phone hides its work card after 14 days without a successful check-in (`OFFLINE_LIMIT_DAYS` in `sync.js`, on the phone; could become an org setting) | Same |
| What Cardshare stores | Org record, verified domains, tenant ID and consent state, device rows (tenant + user object ID + hashed token), admin overrides | The above (minus Microsoft) plus each person's name, title, company, office phone, work email |

The employee's mobile, Personal card and Links never reach the server in either mode.

## Routes

| Route | Who | What |
|---|---|---|
| `POST /v1/discover {domain}` | phone | `{org:{name, microsoft}}` for a verified, discoverable domain, else `{org:null}`. Only the domain is sent |
| `POST /v1/auth/link {email}` | phone | Always `202`, known address or not |
| `GET /v1/auth/microsoft/start` → `/callback` | phone | Sign in with Microsoft (OIDC). Ends at `<app>/?signin=<one-time token>`, the same as an email link |
| `POST /v1/auth/verify {token}` | phone | One-time token → `{deviceToken}` |
| `GET /v1/card` | phone | The card, logos and `ETag`; `304` unchanged, `410` removed, `401` signed out, `503` directory unreachable (phone keeps its copy) |
| `POST /v1/checkin {version}` | phone | `{changed}`, the cheap daily "anything changed?" |
| `POST /v1/auth/signout` | phone | Revokes this phone's token |
| `GET /v1/admin/microsoft/connect` → `/callback` | admin | Admin consent; stores the tenant ID, switches the org to Microsoft mode |
| `POST /v1/admin/microsoft/disconnect`, `/sync`; `GET /v1/admin/microsoft/branding` | admin | Disconnect, recount, sign-in page logos |
| `/v1/admin/org`, `/logos/*`, `/employees`, `/invite`, `/activity` | admin | As before. In Microsoft mode `/employees` is read live from Graph and `PATCH` sets overrides |

## Microsoft 365: app registration (multi-tenant)

One app registration in Cardshare's own Entra tenant, used by every customer.

1. Entra admin centre → App registrations → New. **Supported account types: Accounts in any organizational directory
   (multitenant).** Name it "Cardshare". Put its client ID in `MS_CLIENT_ID` in `wrangler.toml`.
2. Redirect URIs (Web): `https://api.cardshare.io/v1/admin/microsoft/callback` and
   `https://api.cardshare.io/v1/auth/microsoft/callback`.
3. API permissions → Microsoft Graph:
   - **Application `User.Read.All`.** The phone's check-in runs with no signed-in user, so it needs an app-only permission,
     and the narrower `User.ReadBasic.All` exists only as a delegated permission and leaves out `jobTitle`,
     `businessPhones`, `department` and `officeLocation`. `User.Read.All` is read-only. It technically allows reading every
     property of every user, so the Worker limits itself in code: one user at a time, always with
     `$select=id,displayName,jobTitle,companyName,businessPhones,mail,userPrincipalName,department,officeLocation,accountEnabled`.
     `mobilePhone` is never selected.
   - **Application `OrganizationalBranding.Read.All`** (optional). Only for "Use our Microsoft 365 sign-in logo"
     (`bannerLogo`, `squareLogo`, `squareLogoDark`). The connection works without it.
   - **Delegated `openid`, `profile`, `email`** for "Sign in with Microsoft" on the phone. Only the ID token's `tid` and
     `oid` are used.
   - No write permissions of any kind.
4. Certificates & secrets: a client secret is enough for development (`wrangler secret put MS_CLIENT_SECRET`). In
   production use a certificate credential (`client_assertion`) and rotate it.
5. Publisher verification (a Microsoft Partner Network ID) before real customers: without it, customers' admins see
   "unverified", and many tenants block consent to unverified multi-tenant apps.

**Switching an existing org from by hand to Microsoft 365** (the consent callback): every hand-typed person's work
email is looked up in the directory. Signed-in phones whose person matches are moved to that Entra user (same device
token, so they stay signed in and get the directory card at their next check-in). Phones with no match are deleted and
wipe their work card at the next check-in. Then the hand-typed records are deleted.

A customer's IT admin connects from the admin console. That opens `login.microsoftonline.com/organizations/v2.0/adminconsent`,
which grants the application permissions for their tenant. They can revoke it any time under Enterprise applications in
their own Entra admin centre. "Disconnect" in Cardshare deletes our side, but it can't revoke their consent for them.

### Graph calls (`src/microsoft.js`)

- `getUser`: `GET /users/{id}?$select=…`, called on every check-in. A `404` or `accountEnabled: false` is a leaver.
- `findUserByEmail`: `GET /users?$filter=mail eq '…' or userPrincipalName eq '…'`, used for the email-link path.
- `listUsers`: the admin console's People page. Read live, never stored, only a count kept.
- `organization`: tenant name and verified domains when connecting. These become the org's domains.
- `brandingLogo`: `GET /organization/{id}/branding/localizations/default/{bannerLogo|squareLogo|squareLogoDark}`.
- `usersDelta`: `GET /users/delta`. **Not used today.** It's there for if we ever cache cards (for example, to cut Graph
  calls at scale). Then only the `deltaLink` would be stored, and leavers would arrive as `@removed` entries.

Graph throttling: one `GET /users/{id}` per phone per day is far below the limits. If the directory is unreachable, the
phone gets `503`, keeps its cached card and tries again at its next check-in.

## Before a first deploy

1. `wrangler d1 create cardshare` and put the id in `wrangler.toml`; `wrangler d1 execute cardshare --file=schema.sql`.
2. `wrangler r2 bucket create cardshare-logos`.
3. The Entra app registration above; `wrangler secret put MS_CLIENT_SECRET`.
4. Pick an email provider, implement `sendMail()`, `wrangler secret put MAIL_API_KEY`.
5. Still to build: ID-token signature checks (JWKS) in `redeemSignIn`, rate limits on `/discover` and `/auth/link`,
   DNS TXT verification for manual-mode domains, server-side SVG sanitising, the admin sign-in screen in `/admin/`,
   billing, data export and delete-my-data.
6. Before real customers: a Microsoft Partner Network (MPN) ID and **verified publisher** status for the Entra app.
   Without it the consent screen says "unverified", and many tenants block consent to unverified multi-tenant apps.
7. Consent wording: Microsoft shows `User.Read.All` to the IT admin as **"Read all users' full profiles"**. That is
   Microsoft's fixed text and can't be narrowed on the consent screen, even though Cardshare reads only the listed fields
   with `$select`. Say so plainly on the Connect screen and in the privacy policy and sales material, so IT admins aren't
   put off by it.
