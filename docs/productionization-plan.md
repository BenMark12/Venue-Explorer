# Productionization plan

Migration from the current single-file Firebase app to Next.js + Clerk + Vercel Blob.

## Current state

- `index.html` (~2770 lines) — vanilla JS + Firebase v9 compat SDKs, Google Maps, MarkerClusterer
- `functions/index.js` — Firebase Cloud Functions (Firestore trigger + callable)
- `enrich-venues.js` — one-off bulk enrichment script
- Firestore `venues` collection; Claude API via `claude-opus-4-6`
- No tests, no build step, no auth, no rate limiting

## Target state

- Next.js 15 App Router on Vercel
- Clerk for auth (anonymous read, signed-in write)
- Vercel Blob as the data store, accessed via `folio-db-next` (markdown + YAML frontmatter per venue)
- Next.js route handlers replace Firebase Functions
- Upstash rate limiter on AI endpoints
- Claude calls upgraded to `claude-opus-4-7` with adaptive thinking + prompt caching

---

## Phase 0 — Scaffold (~1hr)

- `create-next-app@latest venue-explorer-next --typescript --app` in a sibling directory
- Install dependencies:
  - `@clerk/nextjs`
  - `@vercel/blob`
  - `folio-db-next`
  - `@anthropic-ai/sdk`
  - `@googlemaps/react-wrapper` or `@react-google-maps/api`
  - `zod`
  - `vitest`
  - `@upstash/ratelimit` + `@upstash/redis`
- Link to a new Vercel project; create a Clerk application
- SCSS modules are on by default in Next.js

## Phase 1 — Data layer

**Decision: folio on Vercel Blob.**

The venue set is document-shaped, low-write, and the current enrichment schema maps cleanly onto YAML frontmatter. ~500 venues is comfortably within folio's sweet spot.

**Tradeoff:** folio gives per-key CAS but no cross-venue transactions or SQL joins. Not needed for this app — venues are independent documents. If the dataset grows past ~50k venues or needs SQL filtering, Neon Postgres is the fallback.

```ts
// lib/folio.ts
import { createFolio } from 'folio-db-next';
import { createBlobAdapter, createFsAdapter } from 'folio-db-next/adapters';
import { z } from 'zod';

const adapter =
  process.env.NODE_ENV === 'production'
    ? createBlobAdapter({ token: process.env.BLOB_READ_WRITE_TOKEN! })
    : createFsAdapter({ root: './data' });

export const folio = createFolio({ adapter });

export const venues = folio.volume('venues', {
  schema: z.object({
    name: z.string(),
    lat: z.number(),
    lng: z.number(),
    neighborhood: z.string().optional(),
    michelin: z.object({ listed: z.boolean(), stars: z.number().optional() }).optional(),
    worlds50best: z.object({ listed: z.boolean(), rank: z.number().optional() }).optional(),
    priceRange: z.string().optional(),
    website: z.string().url().optional(),
    cuisineStyle: z.string().optional(),
    knownFor: z.array(z.string()).default([]),
    reviewExtracts: z.array(z.string()).default([]),
    enrichedAt: z.string().datetime().optional(),
  }),
});
```

**Migration script** (one-off): export Firestore → one markdown file per venue. `body` = `reviewSummary`, frontmatter = everything else.

## Phase 2 — Port the UI

Break `index.html` into components:

```
app/
  layout.tsx                 # <ClerkProvider>
  page.tsx                   # Server component — loads venues via folio
  components/
    Map.tsx                  # 'use client' — google-maps wrapper
    Sidebar.tsx              # search + filters + AI search box
    VenueDrawer.tsx          # enrichment rendering
    AIResultsPane.tsx        # main-pane AI recs
    MobileFilterPanel.tsx
```

- Server component loads `venues.list({ fields: 'frontmatter' })` and passes to the client map
- Migrate inline CSS → SCSS modules, one per component
- Keep MarkerClusterer — it's framework-agnostic
- Google Maps must be client-only (dynamic import with `ssr: false`) since it touches `window`

## Phase 3 — API routes

Replaces Firebase Functions.

```
app/api/
  venues/route.ts                  # GET list, POST create (auth-gated)
  venues/[slug]/route.ts           # GET single, PATCH with ifMatch etag
  venues/[slug]/enrich/route.ts    # POST — calls Claude, writes back via folio.patch()
  recommend/route.ts               # POST — replaces recommendVenues callable
```

Claude calls use `claude-opus-4-7` with `thinking: { type: 'adaptive' }` (upgrade from `claude-opus-4-6`). Prompt caching on the venue list in `/recommend` cuts ~90% of the cost on repeated searches.

**Replace the Firestore trigger:** Blob has no `onCreate` hook, so enrichment runs synchronously on POST (or fire-and-forget via `after()` / a background fetch).

## Phase 4 — Auth + rate limits

- `middleware.ts` with `clerkMiddleware()` — protect all `/api/*` except `GET /api/venues`
- Anonymous users: read-only
- Signed-in users: can add and enrich venues
- Upstash ratelimit:
  - `/api/recommend` — 5/min/user
  - `/api/venues/[slug]/enrich` — 10/min/user
- Bot protection handled by Clerk; no App Check equivalent needed

## Phase 5 — Cutover

1. Deploy to preview; run migration script against prod Firestore → prod Vercel Blob
2. Swap DNS; keep Firebase read-only for one week as rollback
3. Retire the Firebase project

---

## Open questions / risks

1. **Google Maps API key** is currently committed in `index.html`. Keep the same pattern (public client key, restricted by HTTP referrer in the GCP console). Don't move it server-side.
2. **CSV seed data in `index.html`** becomes a one-time seed script, not inline.
3. **Enrichment latency:** synchronous enrichment on venue POST means the user waits for Claude. Consider returning 201 immediately and running enrichment via `after()` / a queued job.
4. **folio vs Postgres:** this is the hardest decision to reverse later. Sanity-check before Phase 1 starts.
