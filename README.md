# Cardshare

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
