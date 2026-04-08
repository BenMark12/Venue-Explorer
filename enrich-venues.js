/**
 * Bulk venue enrichment script
 * Reads all venues from Firestore, calls Claude for each unenriched one,
 * and writes the enrichment data back.
 *
 * Usage:
 *   node enrich-venues.js
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY environment variable set
 *   - serviceAccount.json in this directory (downloaded from Firebase Console)
 */

const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

// ── Config ──
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'serviceAccount.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DELAY_MS = 2000; // delay between API calls to avoid rate limits

if (!ANTHROPIC_API_KEY) {
  console.error('Error: Set the ANTHROPIC_API_KEY environment variable first.');
  console.error('  PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."');
  process.exit(1);
}

// Initialise Firebase Admin
const serviceAccount = require(SERVICE_ACCOUNT_PATH);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const ENRICHMENT_PROMPT = (name, type, location) => `
You are a restaurant and bar research assistant. For the venue below, provide structured information in valid JSON only — no markdown, no explanation, just the raw JSON object.

Venue: "${name}"
Type: "${type}"
Location: "${location}"

Return this exact JSON structure:
{
  "michelin": {
    "listed": true or false,
    "stars": 0, 1, 2, or 3 (0 if listed in guide but no stars, null if not listed at all)
  },
  "worlds50best": {
    "listed": true or false,
    "rank": number or null
  },
  "priceRange": "£", "££", "£££", or "££££",
  "website": "url or null",
  "reviewSummary": "2-3 sentence summary of what critics and diners say about this venue. Be specific and factual.",
  "reviewExtracts": [
    "Publication or source: quote or paraphrase",
    "Publication or source: quote or paraphrase"
  ],
  "cuisineStyle": "brief description e.g. Modern British, Japanese Omakase",
  "knownFor": "one sentence on what this venue is best known for"
}

Be accurate. If you are not confident a venue is on the Michelin guide or World's 50 Best, set listed to false. Only include factual information you are confident about.
`;

async function enrichVenue(doc) {
  const venue = doc.data();
  const prompt = ENRICHMENT_PROMPT(venue.name, venue.type, venue.location);

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  let raw = message.content[0].text.trim();
  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let enrichment;
  try {
    enrichment = JSON.parse(raw);
  } catch(parseErr) {
    console.error('Raw response was:', raw);
    throw new Error('JSON parse failed: ' + parseErr.message);
  }

  await doc.ref.update({
    ...enrichment,
    enriched: true,
    enrichedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Fetching venues from Firestore…');
  const snapshot = await db.collection('venues').get();
  const all = snapshot.docs;
  const toEnrich = all.filter(doc => !doc.data().enriched);

  console.log(`Total venues: ${all.length}`);
  console.log(`Already enriched: ${all.length - toEnrich.length}`);
  console.log(`To enrich: ${toEnrich.length}\n`);

  if (toEnrich.length === 0) {
    console.log('All venues already enriched!');
    process.exit(0);
  }

  let done = 0;
  let failed = 0;

  for (const doc of toEnrich) {
    const venue = doc.data();
    process.stdout.write(`[${done + 1}/${toEnrich.length}] ${venue.name} (${venue.location})… `);

    try {
      await enrichVenue(doc);
      console.log('✓');
      done++;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      failed++;
    }

    if (done + failed < toEnrich.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone. Enriched: ${done}, Failed: ${failed}`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
