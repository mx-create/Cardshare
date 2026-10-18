# Cardshare

A free contact card that lives on your phone. Make a Personal and a Work card, add your links, and show a QR
that any phone camera can read. No sign-up, no app, no server: everything stays in the browser.

## What it does

- **My card:** Personal, Work and Links, each saved with one button.
- **Share:** a QR for the Personal or Work card (their camera offers to save you as a contact), or for any one
  link (website, WhatsApp, LinkedIn, Instagram, X, YouTube, TikTok, Facebook, Telegram, Spotify, one custom link).
- **Get paid:** a QR for your Monzo or Revolut page (monzo.me / revolut.me username) or a Stripe payment link. They
  scan and pay on that service's own page. Monzo can carry a fixed amount; otherwise they choose it.
- **Cardshare:** always in the Links picker, a QR to cardshare.io so whoever scans it can make their own card.
- **Themes:** Midnight, Daylight, Ocean and Ember, from the round button beside the logo.
- **Works offline** once opened, and can be added to the home screen.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: markup, styles and script |
| `qrcode.js` | QR generator (Kazuhiko Arase, MIT licence) |
| (in `index.html`) | Link icons: brand marks from [Simple Icons](https://simpleicons.org) 9.21.0 (CC0) |
| `sw.js` | Keeps the app working with no signal |
| `about/index.html` | The product and how-to page, at `/about` |
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
