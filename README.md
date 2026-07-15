# YouTube Dual Captions (EN + ES)

Shows two caption lines on the YouTube player at once:

- **White line** — the video's selected caption track (e.g. English)
- **Yellow line** — the same captions translated to Spanish via YouTube's own
  built-in auto-translate (no external translation API, no API keys)

## How it works

When you turn on captions (the **CC** button), YouTube fetches the caption
track from its `timedtext` API. The extension intercepts that response, then
re-requests the same track with `tlang=es` (YouTube's auto-translate), and
renders both tracks together in a custom overlay while hiding YouTube's native
caption box so nothing shows twice.

## Install (unpacked)

1. Copy `config.example.js` to `config.js` and paste in your own Anthropic
   API key (create one at https://platform.claude.com). The key powers the
   tutor bubble; each explanation costs a fraction of a cent. `config.js` is
   gitignored — never commit or share your real key.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this folder (`youtube-dual-captions`).
5. Reload any open YouTube tabs.

## Usage

1. Open a YouTube video.
2. Turn captions **on** with the CC button (or press `c`).
3. Both lines appear near the bottom of the player. Pick the English track in
   the gear menu if the video has several — the Spanish line always follows
   whatever track is selected.
4. **Click either caption line** to hide the English line (Spanish only —
   great for quizzing yourself); click again to bring it back. The choice is
   remembered across videos and sessions.
5. **Highlight a word or phrase to learn from it.** Press and hold on a word
   (it highlights the whole word), or click and drag across several words
   (the selection snaps to whole words when you release). The video pauses
   and a tutor bubble pops up explaining the meaning, the conjugation
   (infinitive, tense, person, and why that form), and anything notable
   about the sentence structure. Close it with the × button or Escape.
6. **Hear it pronounced.** Click the 🔊 button in the tutor bubble to hear
   the highlighted text spoken with the browser's built-in text-to-speech
   (Mexican Spanish voice preferred, slightly slowed for shadowing; an
   English voice is used if you highlighted the English line). Click again
   to replay.

## The tutor (Claude API)

The tutor bubble is powered by the Claude API. Your API key lives in
`config.js` — **never share, zip, or commit this folder while the key is in
there.** The key is only used by the extension's background worker to call
`api.anthropic.com`; it is never exposed to the YouTube page.

The default model is `claude-opus-4-8` (best explanations). For faster and
cheaper replies, edit `config.js` and set the model to `claude-haiku-4-5`.
Each explanation costs a fraction of a cent.

Captions can be on or off when the page loads — the extension reloads the
player's caption module automatically if it missed the initial request, so no
manual CC toggling is needed.

On logged-in profiles YouTube binds caption requests to a proof-of-origin
token and rejects modified re-fetches (429). The extension handles this by
asking the player itself to load the auto-translated track (a request with a
valid token), capturing it, and restoring the original track.

## Changing the languages

Edit the two constants at the top of `interceptor.js`:

```js
const TARGET_LANG = 'es';   // the translation line
const FALLBACK_BASE = 'en'; // used if the selected track is already Spanish
```

Then click the reload icon on the extension card in `chrome://extensions` and
refresh YouTube.

## Notes / limitations

- Translation quality is YouTube's machine translation of the caption text —
  good for practice, not always perfect Spanish.
- Works on regular videos with any caption track, including auto-generated
  ones. On live streams the rolling captions may lag slightly.
- YouTube changes its internals from time to time; if it ever breaks, the
  first thing to check is whether the `timedtext` request format changed.
