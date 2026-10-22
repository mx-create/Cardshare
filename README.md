# Cardshare

> **Branch `v2-teams`: work in progress, do not merge.** Cardshare v2 adds Work cards managed by an organisation
> ("Cardshare for Teams") to the main app. See [v2 on this branch](#v2-on-this-branch) below. Production is `main`.

A free contact card that lives on your phone. Make a Personal and a Work card, add your links, and show a QR
that any phone camera can read. No sign-up, no app, no server: everything stays in the browser.

## What it does

- **My card:** Personal, Work and Links, each saved with one button.
- **Share:** a QR for the Personal or Work card (their camera offers to save you as a contact), or for any one
  link (website, WhatsApp, LinkedIn, Instagram, X, YouTube, TikTok, Facebook, Telegram, Spotify, one custom link).
- **Get paid:** a QR for your Monzo or Revolut page (monzo.me / revolut.me username) or a Stripe payment link. They
  scan and pay on that service's own page. For Monzo and UPI an amount can be typed under the QR on Share; the QR
  updates as you type, and the amount is not saved.
- **UPI:** a QR with your UPI ID that Google Pay, PhonePe, Paytm and other UPI apps read as a payment to you, in the
  standard `upi://pay` format.
- **Cardshare:** always in the Links picker, a QR to cardshare.io so whoever scans it can make their own card.
- **Checks as you type:** the mobile and WhatsApp fields have a country-code chip, picked from the phone's own
  language settings and changeable from a searchable list, or switched by typing `+` and a code. Numbers are grouped
  as typed, held to that country's length (a leading 0 is dropped) and stored as `+<code><number>`; a number that
  doesn't look like a mobile gets a warning. Email needs an @ and a finished domain, and a likely typo (gmial.com)
  is offered as a fix. A number cut short or a broken email stops the save, with the reason under the field.
- **QR size:** a meter under the card form once the card gets dense; a card too big to scan reliably can't be saved,
  and Share shows what is taking the space with a way to shorten each part (or leave the website off the card).
- **Themes:** Midnight, Daylight, Ocean and Ember, from the round button beside the logo.
- **Works offline** once opened, and can be added to the home screen.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: markup, styles and script |
| `qrcode.js` | QR generator (Kazuhiko Arase, MIT licence) |
| `demo/index.html` | A working demo of the planned team plan, at `/demo`: admin console beside an employee's phone, made-up data, nothing saved or sent. Not linked from the site and hidden from search engines |
| `icons.js` | Link and payment icons, shared by the app and the About page. Brand marks from [Simple Icons](https://simpleicons.org) 9.21.0 (CC0) |
| `sw.js` | Keeps the app working with no signal |
| `about/index.html` | The product page and tour, at `/about`: privacy, every feature, comparison, questions. The app links to its sections (`about/#pay` and so on) |
| `manifest.webmanifest`, `icons/` | Home-screen name and icons |
| `fonts/` | Inter and Poppins (logo), Latin subset, served with the site so pages load with no outside requests (SIL Open Font License, texts alongside) |

## Putting it online

Plain static files with no build step. Upload the folder to any web host, at the root of a domain or in a
subfolder; every path inside is relative. It has to be served over HTTPS for the home-screen install and
offline mode to work.

When `index.html`, `qrcode.js`, the fonts or the icons change, bump `CACHE` in `sw.js` (for example `cardshare-v4` to
`cardshare-v5`) so phones that already installed it pick up the new files.

## Where the data lives

Cards, links and the chosen theme are saved in the browser's local storage on that device. Nothing is sent
anywhere. Clearing the browser's site data, or opening the page on another device, starts from blank.

## v2 on this branch

**MVP scope.** An organisation manages its staff's work cards in one of two ways:

1. **Connect Microsoft 365 (Entra ID).** *"We don't store your people's data: it comes straight from your own directory."*
   When a phone checks in, the Worker reads that one person from Microsoft Graph, maps it to a card, returns it, and keeps
   nothing. Joiners can sign in straight away; anyone disabled or deleted in Microsoft 365 loses their work card at the
   next check-in. Read: name, title, company, office phone, work email, optionally department and office location.
   **Never read:** the mobile.
2. **By hand**, in the admin panel, for small firms. Cardshare stores what the admin types, until they remove the person;
   the panel says so.

Google Workspace is phase 2 and shows as "coming soon". Free personal mode is unchanged and still needs no sign-in.

What Cardshare stores for a Microsoft-connected organisation: the org record, its verified domains, the Microsoft tenant
ID and consent state, one row per signed-in phone (tenant + user object ID + a hashed device token), and any per-person
overrides the admin types to fill blanks. No Graph tokens are stored; they're fetched when needed and kept in memory.

**On the phone**
- **Work tab, two modes.** Filled in by hand as before, or managed. Typing a work email at an organisation's domain
  suggests signing in; a line at the top of Work offers it any time. Microsoft-connected organisations get
  **Sign in with Microsoft** as well as the emailed link.
- **Magic link.** "Check your work email" is worded the same whether or not the address is known. In the prototype no
  email is sent; an "Open my link" button stands in for tapping it.
- **Synced, not shared.** The phone keeps a device token and a cached copy of the card. The organisation's fields are
  locked; the mobile is the employee's own and is never sent.
- **Check-in.** On open and once a day the phone asks "anything changed?" (ETag). Changes arrive at the next check-in; a
  leaver's phone wipes the card and goes back to manual. "Sign out" does the same locally.
- **Company logo** in the header on Work (My card and Share), never inside the QR (`logo.js`,
  `docs/v2-design/LogoRules.dc.html`).

**Admin console** (`/admin/`)
- Choose where work cards come from: Microsoft 365 / by hand / Google (coming soon). Each has its own privacy line.
- Microsoft: connect through a simulated admin-consent screen; connected state (tenant, last sync, people found); field
  mapping; per-person overrides for blanks or wrong values; "Simulate: disable" to show a leaver; Disconnect.
- Logo: upload, or "Use our Microsoft 365 sign-in logo" (banner, square, square dark), all through the same fit rules.
- The real app runs in a phone frame, with "Check in now" and an Offline switch.

| File | What it is |
|---|---|
| `sync.js` | Every server call, plus a mock server and a simulated Microsoft 365 tenant in localStorage, so all of it runs with no backend |
| `logo.js` | The 200 × 40 logo slot, its fallbacks, and upload trimming |
| `admin/index.html` | Admin console (prototype) |
| `worker/` | Cloudflare Worker skeleton: D1 schema, R2 logos, Graph client and Entra app notes, the same API as the mock. Not deployed |
| `docs/v2-design/` | The approved phone mock-ups |

To try it: serve the folder (`python3 -m http.server`) and open `/admin/`. For Microsoft, pick Microsoft 365 → Connect →
Accept, then on the phone go to My card → Work → "Sign in with work email", type `priya.shah@harbour.example`, and tap
Sign in with Microsoft. Without connecting, type `maya.patel@harbour.example` on Work to use the hand-typed list.
The service worker on this branch uses its own cache name (`cardshare-v2-dev-N`).
