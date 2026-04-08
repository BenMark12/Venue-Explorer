const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
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

// ── Cloud Function: auto-enrich when a new venue document is created ──
exports.enrichVenueOnCreate = onDocumentCreated('venues/{venueId}', async (event) => {
  const snap = event.data;
  if (!snap) return null;

  const venue = snap.data();
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

    let raw = message.content[0].text.trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
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

// ── Cloud Function: AI venue recommendation ──
exports.recommendVenues = onCall({ timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
  const query = (request.data && request.data.query || '').trim();
  if (!query) throw new HttpsError('invalid-argument', 'A search query is required.');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpsError('internal', 'API key not configured.');

  // Fetch all venues from Firestore
  const snapshot = await db.collection('venues').get();
  const venues = [];
  snapshot.forEach(doc => {
    const v = doc.data();
    venues.push({
      name: v.name,
      type: v.type,
      location: v.location,
      reason: v.reason,
      food: v.food,
      service: v.service,
      experience: v.experience,
      overall: v.overall,
      liked: v.liked || '',
      cuisineStyle: v.cuisineStyle || '',
      knownFor: v.knownFor || '',
      reviewSummary: v.reviewSummary || '',
      michelin: v.michelin || null,
      worlds50best: v.worlds50best || null,
      priceRange: v.priceRange || '',
    });
  });

  if (venues.length === 0) throw new HttpsError('not-found', 'No venues found.');

  const venueList = venues.map((v, i) =>
    `${i + 1}. ${v.name} (${v.type}, ${v.location})
   Overall: ${v.overall}/10 | Food: ${v.food} | Service: ${v.service} | Experience: ${v.experience}
   Occasion: ${v.reason}
   ${v.cuisineStyle ? `Cuisine: ${v.cuisineStyle}` : ''}
   ${v.knownFor ? `Known for: ${v.knownFor}` : ''}
   ${v.reviewSummary ? `Critics: ${v.reviewSummary}` : ''}
   Personal notes: ${v.liked}
   ${v.michelin && v.michelin.listed ? `Michelin: ${v.michelin.stars > 0 ? v.michelin.stars + ' star(s)' : 'listed'}` : ''}
   ${v.worlds50best && v.worlds50best.listed ? `World's 50 Best: #${v.worlds50best.rank}` : ''}`
  ).join('\n\n');

  const prompt = `You are a personal dining and drinks advisor with deep knowledge of restaurants and bars. Based on the user's request, recommend the top 3 venues from the list below.

User is looking for: "${query}"

Available venues:
${venueList}

Return valid JSON only — no markdown, no explanation. Use this exact structure:
{
  "recommendations": [
    {
      "name": "exact venue name from the list",
      "rank": 1,
      "rationale": "2-3 sentences explaining specifically why this venue matches the request, referencing its scores, reviews, and what makes it right for this occasion"
    },
    {
      "name": "exact venue name from the list",
      "rank": 2,
      "rationale": "..."
    },
    {
      "name": "exact venue name from the list",
      "rank": 3,
      "rationale": "..."
    }
  ],
  "summary": "One sentence explaining the overall theme of your recommendations"
}

Only recommend venues from the list. Be specific in your rationale — reference the actual scores, cuisine, occasion type, and review details.`;

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  let raw = message.content[0].text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const result = JSON.parse(raw);

  // Attach full venue data to each recommendation so the UI can render it
  result.recommendations = result.recommendations.map(rec => {
    const venue = venues.find(v => v.name === rec.name);
    return { ...rec, venue };
  });

  return result;
});
