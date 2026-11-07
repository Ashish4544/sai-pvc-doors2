# Sai PVC Doors Billing (offline PWA)

Plain HTML, CSS and JavaScript. No backend, no accounts, no paid services.
Bills are stored on the phone (IndexedDB) and work with no internet after the first load.

## Put it on your phone (one time, about 10 minutes)

You need a free GitHub account. The app must be hosted once so Chrome can install it.

1. Go to github.com, sign in, tap **+** > **New repository**. Name it `sai-pvc-billing`, choose **Public**, tap **Create repository**.
2. Tap **uploading an existing file**. Upload ALL files and folders from this project
   (`index.html`, `app.js`, `assets.js`, `style.css`, `xlsx.js`, `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png`).
   There are no folders. All files sit at the top level. Tap **Commit changes**.
   (On a phone, use Chrome's "Desktop site" option, or do this step from a computer.)
3. Open **Settings > Pages**. Under "Build and deployment", set Source to **Deploy from a branch**,
   Branch **main**, folder **/ (root)**, then **Save**.
4. Wait 1 to 2 minutes. Your address will be `https://YOURNAME.github.io/sai-pvc-billing/`
5. Open that address in **Chrome on Android**. Wait for the home screen to appear.
6. Tap the Chrome menu (three dots) > **Install app** (or **Add to Home screen** > **Install**).
   Use the same menu and **Install app**, not a plain shortcut, so it opens full screen.
7. Open it once while online. After that, put the phone in airplane mode and check that it still opens.

## Daily use
- **Create Bill**: type customer, add doors (length, width in inches). Press Enter on the keyboard to jump to the next door.
  Tap **Save & Generate Bill**, then **Download PNG** or **Share** to send on WhatsApp.
- **Payments**: open any bill, then Mark Paid, or enter an amount and tap Add Partial Payment.
- **Previous pending**: filled in automatically for a returning customer. The old bill is marked "Carried forward",
  so the same balance is never added twice. Take payments on the newest bill.
- **Excel**: Backup / Restore / Excel > Download Excel. It is also downloaded after each new bill (can be turned off there).
- **Backup**: take a JSON backup every week or two (Home shows a reminder) and keep it in Google Drive or WhatsApp.
  Clearing Chrome's site data or uninstalling the app erases the bills on the phone, so the backup is your safety net.

## Updating the app later
Upload the changed files to GitHub. In `sw.js` change `const VERSION = 'v1';` to `'v2'` (then `'v3'` and so on)
so phones pick up the new files. Saved bills are not touched by updates.

## Files
`index.html` page, `style.css` look, `app.js` all logic, `xlsx.js` small Excel writer, `sw.js` offline cache,
`manifest.json` install info, `assets.js` logo and Google Pay QR (cut from your invoice template), `icon-*.png` app icons.
