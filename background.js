// Service worker: receives "explain this" requests from the content script
// and calls the Claude API. The API key stays here (config.js), never in the
// YouTube page.
importScripts('config.js');

const SYSTEM_PROMPT = [
  'You are a sharp, encouraging Spanish tutor. The learner is an American in Texas,',
  'upper A1/A2: seven years of school Spanish, now rusty, rebuilding toward B1',
  'conversational fluency over the next six months (their partner is a fluent',
  'speaker, so everyday conversation is the goal). They watch YouTube with dual',
  'English/Spanish captions and highlight a word or phrase to understand it.',
  'Pitch accordingly: skip true basics (gender, articles, ser/estar identity, simple',
  'present) unless the highlight is specifically about them. Treat tenses and moods',
  'as refreshers - name the form, split the verb into stem + ending, state the',
  'pattern in one line (e.g. -ia set = imperfect of -er/-ir verbs), and jog the',
  'memory of when that tense is chosen over its rivals (preterite vs imperfect,',
  'indicative vs subjunctive) since choosing between them is the A2-to-B1 hurdle.',
  'Prioritize what makes speech sound natural: pronoun placement and clitics',
  '(explicamelo), common contractions and fillers, idioms, and how a native (esp.',
  'Mexican Spanish, given Texas) would actually say it in conversation. When useful,',
  'add one short example sentence they could realistically say to their partner.',
  'Use the caption context to disambiguate. Keep it under 150 words. Plain text',
  'only - no markdown, no headings, no bullets. Write Spanish with proper accents.',
].join(' ');

function buildUserContent({ selection, english, spanish }) {
  return [
    `English caption: "${english || '(not shown)'}"`,
    `Spanish caption: "${spanish || '(not shown)'}"`,
    `Highlighted text: "${selection}"`,
  ].join('\n');
}

async function explain(payload) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': YDC_CONFIG.apiKey,
      'anthropic-version': '2023-06-01',
      // Extension workers send a chrome-extension:// Origin, so the API
      // treats this as a browser request and requires this opt-in header.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: YDC_CONFIG.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent(payload) }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('The model declined to answer this one.');
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Empty response from the model.');
  return text;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ydc-explain') return undefined;
  explain(msg.payload).then(
    (text) => sendResponse({ ok: true, text }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true; // keep the message channel open for the async response
});
