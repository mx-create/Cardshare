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
| `fonts/` | Inter and Poppins (logo), plus Fraunces and Outfit (v2 brand fonts), Latin subset, served with the site so pages load with no outside requests (SIL Open Font License, texts alongside) |

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
- **Offline limit.** A managed work card that hasn't had a successful check-in for 14 days is paused: Work and Share
  say "Your work card needs to check in with <Org>. Connect to the internet to refresh it." with a Try again button,
  and the card comes back at the next successful check-in. Personal and Links are unaffected. The limit is one constant,
  `OFFLINE_LIMIT_DAYS` in `sync.js`; it could become a per-organisation setting later.
- **Company logo** in the header on Work (My card and Share), never inside the QR (`logo.js`,
  `docs/v2-design/LogoRules.dc.html`).
- **Company branding** (`brand.js`). A managed Work card takes the organisation's colours: the header band, card panel,
  Work pill, main button and "Managed by" banner, in My card and in Share when it shows Work. Personal and Links keep the
  Cardshare theme. The QR always stays plain (dark on white, no logo, no brand colour), and "work card · via cardshare"
  stays. Branding comes with the card at check-in (the ETag covers it) and is cached for offline use. Brand fonts load
  from the site's own `fonts/` folder (Fraunces and Outfit, Latin subset, 400/600/700, SIL OFL licences alongside),
  are cached by the service worker, and fall back to system fonts. The app makes no outside requests.
- **Never unreadable.** Text on the card and button text on the primary colour must reach WCAG 4.5:1. If an admin saves
  a pair that doesn't, the phone uses the nearest passing shade of the same hue.
- **Suspended organisations.** While Cardshare has an organisation suspended, its phones keep the work card but don't
  show it (it is paused, not wiped), and say so. It comes back at the next check-in after the organisation is restored.
  Only deleting an organisation, removing a person or a leaver in Microsoft 365 wipes a work card.

**Admin console** (`/admin/`)
- Choose where work cards come from: Microsoft 365 / by hand / Google (coming soon). Each has its own privacy line.
- Microsoft: connect through a simulated admin-consent screen; connected state (tenant, last sync, people found); field
  mapping; per-person overrides; "Simulate: disable" to show a leaver; Disconnect. Admins have full override access:
  any mapped field (name, title, company, office phone, work email, department, location) for any one person.
- Switching from by hand to Microsoft 365 deletes the hand-typed records. Phones already signed in are carried over:
  a phone whose work email matches a directory user stays signed in and gets the Microsoft data at its next check-in;
  a phone with no match is signed out and wipes its work card.
- Logo: upload, or "Use our Microsoft 365 sign-in logo" (banner, square, square dark), all through the same fit rules.
- The real app runs in a phone frame, with "Check in now", an Offline switch and "Simulate 15 days offline".
- **Sign-in.** "Sign in with Microsoft" (organisations on Microsoft 365) or an emailed link ("Open my link" stands in for
  the email). Each admin sees only their own organisation's people, branding and settings.
- **Roles.** Owner and Admin. Owners connect or disconnect Microsoft 365, verify domains and manage admins. Admins
  manage people, branding and the logo. An admin can belong to several organisations and switches between them in the header.
- **Branding.** Five brand colours (Primary, Accent, Card background, Text, Button text), each with a colour picker, hex,
  RGB and HSL. Separate light and dark versions for the app's light and dark themes (dark generated from light, or edited
  by hand). Live WCAG checks with "Use nearest passing shade". Quick starts: pick colours from the logo, "Use Microsoft 365
  branding" (sign-in page background colour), and presets. Card style: corners (sharp / soft / round), card background
  (brand colour / light / dark), header logo (centre / left), and font (Inter, a serif, a geometric sans, or system).
  A live preview runs the real app in two phone frames (My card and Share), in light or dark theme.
- **Set up Cardshare for your organisation.** Work email → confirm by link → name the organisation → prove the domain
  (connecting Microsoft 365 counts; otherwise a DNS TXT record at `_cardshare.<domain>`, or an email to the admin's pick
  of `admin@`, `postmaster@` or `webmaster@<domain>`) → choose where cards come from → pick a starting look. Personal
  addresses (gmail.com and so on) can't own an organisation. If the domain already uses Cardshare, sign-up offers
  **Request access** instead: the organisation's owners see the request under Admins (and in Activity) and can approve
  it, which adds the person as an Admin, or decline it. Staff only find an organisation by typing their email once its domain is verified.

**Platform console** (`/admin/platform/`, for Cardshare staff) lists every organisation: source, domains and whether
they're verified, phones signed in, records held (hand-typed organisations only), and a plan placeholder. It can
suspend, restore and delete organisations. It never shows anyone's staff details. In the prototype, a "Sign in as
platform owner" button stands in for the real sign-in, which is limited to the addresses in `PLATFORM_OWNERS`.

**Sample data** (in the mock):

| Organisation | Cards from | Domain | Admin(s) | Look |
|---|---|---|---|---|
| Harbour Studio | Microsoft 365 | harbour.example | ava.collins@ (Owner) | Coral and navy, serif, wide wordmark |
| Nordlys | By hand | nordlys.example | ingrid.solberg@ (Owner) | Deep fjord card, round corners, geometric, square mark on the left |
| Pine & Post | By hand | pinepost.example | jo.fairley@ (Owner), ingrid.solberg@nordlys.example (Admin) | Forest and cream, sharp corners, no logo (initials) |
| (not set up yet) | Microsoft 365 tenant | kestrel.example | rowan.blake@ to try sign-up | |

Staff to try on the phone: maya.patel@harbour.example (and others in the Harbour directory), erik.dahl@nordlys.example,
hannah.price@pinepost.example.

| File | What it is |
|---|---|
| `sync.js` | Every server call, plus a mock server and a simulated Microsoft 365 tenant in localStorage, so all of it runs with no backend |
| `logo.js` | The 200 × 40 logo slot, its fallbacks, and upload trimming |
| `brand.js` | Brand colours, light/dark sets, contrast checks and fixes, palette from a logo, presets. Shared by the phone and the console |
| `admin/index.html` | Admin console (prototype) |
| `admin/gate.js` | Admin sign-in and "Set up Cardshare for your organisation" |
| `admin/branding.js` | The Branding card and its live preview |
| `admin/platform/index.html` | Platform console (prototype, Cardshare staff) |
| `worker/` | Cloudflare Worker skeleton: D1 schema, R2 logos, Graph client and Entra app notes, the same API as the mock. Not deployed |
| `docs/v2-design/` | The approved phone mock-ups |

To try it: open **dev.cardshare.io/admin/**, which deploys this branch (or serve the folder with `python3 -m http.server`
and open `/admin/`). Everything is simulated in your browser; "Reset sample data" starts again.
1. Click a sample admin, then "Email me a sign-in link" → "Open my link" (or, for Ava, "Sign in with Microsoft").
2. Ingrid has two organisations: switch between Nordlys and Pine & Post in the header.
3. Branding: change a colour and watch both preview phones. Type a button text close to the primary to see the contrast
   warning and "Use nearest passing shade".
4. Phone frame: My card → Work → "Sign in with work email" with erik.dahl@nordlys.example (email link) or
   maya.patel@harbour.example (Sign in with Microsoft). Each phone gets its own organisation's card and colours.
5. Sign out → "Set up Cardshare for your organisation" with rowan.blake@kestrel.example (Microsoft 365) or any
   name@yourco.example (by hand, DNS or email verification).
6. `/admin/platform/` → "Sign in as platform owner": suspend Nordlys, then "Check in now" on a Nordlys phone.
The service worker on this branch uses its own cache name (`cardshare-v2-dev-N`).
