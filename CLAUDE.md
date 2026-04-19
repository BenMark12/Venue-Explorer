# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Venue Explorer is a single-page map-based directory of restaurants and bars. The codebase has three distinct parts:

1. **`index.html`** — the entire frontend app (~2770 lines, HTML + CSS + JS in one file). No framework, no build step. Uses Firebase v9 compat SDKs via CDN, Google Maps/Places (new) API, and MarkerClusterer. Opening the file in a browser is the full app.

2. **`functions/index.js`** — Firebase Cloud Functions v2 (Node). Two functions:
   - `enrichVenueOnCreate` — Firestore trigger on `venues/{venueId}` that calls Claude for user-added venues and writes the enrichment back to the same document.
   - `recommendVenues` — HTTPS callable that loads all venues, formats them into a prompt, and returns Claude's top-3 recommendations with rationale.

3. **`enrich-venues.js`** — one-off local script to bulk-enrich existing Firestore venues. Run manually when backfilling.

Data flow: the frontend writes venues to Firestore → the `enrichVenueOnCreate` trigger calls Claude to enrich → the frontend re-reads the enriched doc. AI search calls `recommendVenues` via `firebase.functions().httpsCallable`.

### Venue enrichment shape

When adding fields to enriched venues, keep these three places in sync, since the prompt schema is duplicated:
- `functions/index.js` — `ENRICHMENT_PROMPT`
- `enrich-venues.js` — `ENRICHMENT_PROMPT` (same content, separate copy)
- `index.html` — drawer rendering (`openDrawer`) and the venue list sent to `recommendVenues`

Current enrichment keys: `michelin` (`{listed, stars}`), `worlds50best` (`{listed, rank}`), `priceRange`, `website`, `reviewSummary`, `reviewExtracts[]`, `cuisineStyle`, `knownFor`.

### Claude response handling

Both functions and the bulk script ask Claude for raw JSON, then strip ``` ```json fences defensively before `JSON.parse`. If you change the prompt, keep this strip step — Claude sometimes returns fenced output regardless.

## Commands

Frontend: open `index.html` directly or serve the repo root (`python3 -m http.server` etc.). There is no build.

Firebase Functions (inside `functions/`):
- No `package.json` is tracked — create one locally if missing, with deps `firebase-functions`, `firebase-admin`, `@anthropic-ai/sdk`, then `npm install`.
- `firebase emulators:start --only functions` — local testing.
- `firebase deploy --only functions` — deploy. Set `ANTHROPIC_API_KEY` via `functions/.env` (read at runtime via `process.env.ANTHROPIC_API_KEY`) before deploying.

Bulk enrichment (from repo root):
- `npm install firebase-admin @anthropic-ai/sdk` — no root `package.json` is tracked; create one if needed.
- Place Firebase service account JSON at `./serviceAccount.json` (gitignored).
- `ANTHROPIC_API_KEY=sk-ant-... node enrich-venues.js` — skips already-enriched docs, 2s delay between calls.

No test suite, no linter configured.

## Repository conventions

- **No `package.json` or `package-lock.json` is tracked anywhere.** The root `.gitignore` lines `package.json` and `package-lock.json` are unanchored patterns, so they match recursively including `functions/package.json`. Only `.gitignore`, `enrich-venues.js`, `functions/.gitignore`, `functions/index.js`, and `index.html` are tracked. Don't assume `npm install` will work on a fresh checkout — you'll need to create manifests first.
- **Firebase config and the Google Places API key are committed in `index.html`.** They are client-side keys intended to be public; don't try to "fix" this by moving them to env vars without discussing first.
- **`serviceAccount.json` must never be committed** — it's gitignored and grants admin access to Firestore.
- **Firebase project:** `venue-3faae`. The Firestore `venues` collection is the source of truth; the frontend seeds it from an inline CSV (`CSV_RAW` in `index.html`) only on first load when the collection is empty.
- **Model:** all three Claude call sites (`functions/index.js:63`, `functions/index.js:165`, `enrich-venues.js:73`) use `claude-opus-4-6`. If bumping, update all three together.
