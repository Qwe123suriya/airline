# Translations (Thai → English)

- `js/game.js` is written in Thai. Every Thai text goes through `_T("…")` or `` _T`…` `` (defined in `js/i18n.js`).
- In English mode, `js/i18n.js` loads `js/en.js` and looks up each piece of text between HTML tags; `${…}` values are written `{0}`, `{1}`… in the dictionary so a translation can reorder them.
- After changing Thai text in the game: `cd tools/i18n && npm i && node check.js` lists text not wrapped in `_T` (`--wrap` fixes it) and Thai text with no English entry. Add the missing entries to `js/en.js`.
- This folder is not deployed (see `.assetsignore`).

## Test server
New versions go to the `test` branch first. Cloudflare Worker `airline-test` builds it (`npx wrangler deploy --env test`) and serves test.skyseatycoon.com, which shows a 🧪 badge and the admin test panel. When it looks good, `test` is merged into `main` (the live Worker `airline`).
