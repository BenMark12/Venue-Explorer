const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ maxInstances: 5, timeoutSeconds: 120, memory: '256MiB' });

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

exports.enrichVenueOnCreate = onDocumentCreated('venues/{venueId}', async (event) => {
  const snap = event.data;
  if (!snap) return null;

  const venue = snap.data();

  // Only enrich user-added venues
  if (venue.source !== 'user') return null;
  if (venue.enriched) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('No Anthropic API key. Add ANTHROPIC_API_KEY to functions/.env');
    return null;
  }

  const client = new Anthropic({ apiKey });

  try {
    console.log(`Enriching: ${venue.name}`);
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: ENRICHMENT_PROMPT(venue.name, venue.type, venue.location) }]
    });

    const raw = message.content[0].text.trim();
    const enrichment = JSON.parse(raw);

    await snap.ref.update({
      ...enrichment,
      enriched: true,
      enrichedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Enriched: ${venue.name}`);
  } catch (e) {
    console.error(`Failed to enrich ${venue.name}:`, e.message);
  }

  return null;
});
