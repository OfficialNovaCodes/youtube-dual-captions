// Isolated-world content script. Receives caption tracks from interceptor.js,
// parses them, and renders a two-line (original + Spanish) overlay on the player.
(() => {
  'use strict';

  const state = { primary: [], secondary: [] };

  // Clicking the caption overlay hides/shows the original-language line
  // (so you can quiz yourself against just the translation). Remembered
  // across videos and sessions.
  let hidePrimary = false;
  try { hidePrimary = localStorage.getItem('ydc-hide-primary') === '1'; } catch {}

  // While the mouse is held down on the captions (drag-selecting a word),
  // freeze caption updates so the selection isn't wiped mid-drag.
  let holdUpdates = false;
  document.addEventListener('mouseup', () => { holdUpdates = false; });

  // Expand a selection range outward so it always covers whole words
  // (accented Spanish letters included).
  const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
  function snapRangeToWords(range) {
    const sc = range.startContainer;
    if (sc.nodeType === Node.TEXT_NODE) {
      const t = sc.textContent;
      let i = range.startOffset;
      while (i > 0 && WORD_CHAR.test(t[i - 1])) i--;
      range.setStart(sc, i);
    }
    const ec = range.endContainer;
    if (ec.nodeType === Node.TEXT_NODE) {
      const t = ec.textContent;
      let j = range.endOffset;
      while (j < t.length && WORD_CHAR.test(t[j])) j++;
      range.setEnd(ec, j);
    }
  }

  function cleanText(t) {
    return t
      .replace(/\n/g, ' ')
      .replace(/>>+/g, '') // strip speaker-change markers
      .replace(/\s+/g, ' ');
  }

  function parseJson3(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    const cues = [];
    for (const ev of data.events || []) {
      if (!ev.segs || ev.aAppend) continue;
      const start = ev.tStartMs || 0;
      // Auto-generated tracks carry per-word timestamps (tOffsetMs),
      // which lets us reveal words as they are spoken.
      const words = [];
      for (const s of ev.segs) {
        const text = s.utf8 || '';
        if (!text.trim()) continue;
        words.push({ t: start + (s.tOffsetMs || 0), text });
      }
      const text = cleanText(words.map((w) => w.text).join('')).trim();
      if (!text) continue;
      cues.push({ start, end: start + (ev.dDurationMs || 3000), words, text });
    }
    return cues;
  }

  // Translations get rate-limited by YouTube sometimes, so cache the Spanish
  // track per video: rewatching or refreshing never re-asks YouTube.
  const ES_CACHE_KEY = 'ydc-es-cache-v1';
  function readCacheMap() {
    try { return JSON.parse(localStorage.getItem(ES_CACHE_KEY)) || {}; } catch { return {}; }
  }
  function saveEsCache(videoId, cues) {
    try {
      const compact = cues.map((c) => [c.start, c.end, c.text]);
      if (JSON.stringify(compact).length > 250000) return; // don't hog storage
      const map = readCacheMap();
      map[videoId] = { t: Date.now(), c: compact };
      // keep only the 6 most recent videos
      Object.keys(map).sort((a, b) => map[b].t - map[a].t).slice(6)
        .forEach((id) => delete map[id]);
      localStorage.setItem(ES_CACHE_KEY, JSON.stringify(map));
    } catch {}
  }
  function loadEsCache(videoId) {
    const entry = readCacheMap()[videoId];
    if (!entry || !Array.isArray(entry.c) || !entry.c.length) return null;
    return entry.c.map(([start, end, text]) => ({ start, end, text, words: [{ t: start, text }] }));
  }

  document.addEventListener('ydc:track', (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    const cues = parseJson3(d.body);
    if (cues.length) {
      state[d.role] = cues;
      if (d.role === 'secondary' && d.videoId) saveEsCache(d.videoId, cues);
    }
    // Translation missing (e.g. rate-limited)? Use the cached one meanwhile.
    if (d.videoId && !state.secondary.length) {
      const cached = loadEsCache(d.videoId);
      if (cached) state.secondary = cached;
    }
  });

  function reset() {
    state.primary = [];
    state.secondary = [];
  }
  document.addEventListener('yt-navigate-start', reset);
  window.addEventListener('yt-navigate-start', reset);

  function cueText(cue, tMs) {
    // With per-word timing, only show words already spoken (real-time flow).
    // Tracks without word timing (e.g. translations) show the full line.
    if (cue.words.length > 1) {
      const spoken = cue.words.filter((w) => w.t <= tMs).map((w) => w.text).join('');
      return cleanText(spoken).trim();
    }
    return cue.text;
  }

  function activeText(cues, tMs) {
    const lines = [];
    for (const c of cues) {
      if (tMs >= c.start && tMs < c.end) {
        const text = cueText(c, tMs);
        if (text) lines.push(text);
      }
      if (lines.length === 2) break; // auto-captions roll two lines
    }
    return lines.join('\n');
  }

  function ensureOverlay(player) {
    let overlay = player.querySelector('#ydc-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ydc-overlay';
      const primaryLine = document.createElement('div');
      primaryLine.className = 'ydc-line ydc-line--primary';
      const secondaryLine = document.createElement('div');
      secondaryLine.className = 'ydc-line ydc-line--secondary';
      overlay.append(primaryLine, secondaryLine);
      // Quick click toggles the English line; the delay lets a hold or
      // double-click (word selection -> tutor bubble) cancel the toggle.
      let clickTimer = null;
      let holdTimer = null;
      overlay.addEventListener('click', (e) => {
        e.stopPropagation(); // don't let the click pause the video
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          if (window.getSelection().toString().trim()) return; // selecting, not toggling
          hidePrimary = !hidePrimary;
          try { localStorage.setItem('ydc-hide-primary', hidePrimary ? '1' : '0'); } catch {}
        }, 300);
      });
      overlay.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        clearTimeout(clickTimer);
      });
      // Press-and-hold on a word highlights the whole word under the cursor.
      overlay.addEventListener('mousedown', (e) => {
        holdUpdates = true; // freeze caption text while the button is down
        clearTimeout(holdTimer);
        const { clientX, clientY } = e;
        holdTimer = setTimeout(() => {
          const sel = window.getSelection();
          if (sel.toString().trim()) return; // already drag-selecting
          const range = document.caretRangeFromPoint(clientX, clientY);
          if (!range || !overlay.contains(range.startContainer)) return;
          snapRangeToWords(range);
          if (!range.toString().trim()) return;
          sel.removeAllRanges();
          sel.addRange(range);
        }, 350);
      });
      // Releasing the mouse finishes the gesture: snap the selection to whole
      // words (single word, or the group dragged across) and ask the tutor.
      overlay.addEventListener('mouseup', () => {
        clearTimeout(holdTimer);
        // Read synchronously: a deferred read can race the caption re-render
        // and capture the wrong text.
        const sel = window.getSelection();
        if (sel.rangeCount && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          snapRangeToWords(range);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        const selection = sel.toString().replace(/\s+/g, ' ').trim();
        if (selection) {
          // Which line was highlighted decides the pronunciation voice.
          const container = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
          const el = container && (container.nodeType === Node.TEXT_NODE ? container.parentElement : container);
          const lang = el && el.closest && el.closest('.ydc-line--secondary') ? 'es' : 'en';
          explainSelection(selection, lang);
        }
      });
      player.appendChild(overlay);
    }
    return overlay;
  }

  function setLine(el, text) {
    if (el.textContent !== text) el.textContent = text;
    el.style.display = text ? '' : 'none';
  }

  // ---- Pronunciation: speak the highlighted text with the browser's TTS ----

  let currentSpeech = { text: '', lang: 'es' };

  function pickVoice(langBase) {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const prefs = langBase === 'es'
      ? ['es-MX', 'es-US', 'es-419', 'es-ES', 'es']
      : ['en-US', 'en'];
    for (const pref of prefs) {
      const v = voices.find((v) => v.lang === pref || v.lang.replace('_', '-').startsWith(pref));
      if (v) return v;
    }
    return voices.find((v) => v.lang.toLowerCase().startsWith(langBase)) || null;
  }

  function speak() {
    if (!currentSpeech.text || !window.speechSynthesis) return;
    try {
      speechSynthesis.cancel(); // stop any previous playback
      const u = new SpeechSynthesisUtterance(currentSpeech.text);
      const voice = pickVoice(currentSpeech.lang);
      if (voice) u.voice = voice;
      u.lang = (voice && voice.lang) || (currentSpeech.lang === 'es' ? 'es-MX' : 'en-US');
      u.rate = 0.85; // a touch slower than native speed, easier to shadow
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  // Chrome loads voices asynchronously; touching the list primes it.
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
  }

  // ---- Tutor bubble: highlight a word/phrase -> Claude explains it ----

  function requestExplanation(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'ydc-explain', payload }, (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (resp && resp.ok) resolve(resp.text);
          else reject(new Error((resp && resp.error) || 'No response from extension.'));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function ensureBubble(player) {
    let bubble = player.querySelector('#ydc-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'ydc-bubble';
      const header = document.createElement('div');
      header.className = 'ydc-bubble-header';
      const title = document.createElement('span');
      title.className = 'ydc-bubble-title';
      const speakBtn = document.createElement('button');
      speakBtn.className = 'ydc-bubble-speak';
      speakBtn.textContent = '🔊';
      speakBtn.title = 'Hear it pronounced';
      speakBtn.addEventListener('click', () => speak());
      const close = document.createElement('button');
      close.className = 'ydc-bubble-close';
      close.textContent = '×';
      close.addEventListener('click', () => hideBubble());
      header.append(title, speakBtn, close);
      const body = document.createElement('div');
      body.className = 'ydc-bubble-body';
      bubble.append(header, body);
      bubble.addEventListener('click', (e) => e.stopPropagation());
      bubble.addEventListener('dblclick', (e) => e.stopPropagation());
      bubble.addEventListener('mouseup', (e) => e.stopPropagation());
      bubble.addEventListener('mousedown', (e) => e.stopPropagation());
      // Keep scrolling inside the bubble from reaching YouTube's own
      // scroll handlers (e.g. the fullscreen scroll-for-related-videos UI).
      bubble.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
      bubble.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
      player.appendChild(bubble);
    }
    return bubble;
  }

  function hideBubble() {
    const bubble = document.getElementById('ydc-bubble');
    if (bubble) bubble.style.display = 'none';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideBubble();
  });

  let explainSeq = 0;
  function explainSelection(selection, lang) {
    const player = document.getElementById('movie_player');
    if (!player) return;
    currentSpeech = { text: selection, lang: lang || 'es' };
    const overlay = player.querySelector('#ydc-overlay');
    const english = overlay ? overlay.children[0].textContent.replace(/\s+/g, ' ').trim() : '';
    const spanish = overlay ? overlay.children[1].textContent.replace(/\s+/g, ' ').trim() : '';

    const video = player.querySelector('video');
    if (video && !video.paused) video.pause(); // hold the moment while reading

    const bubble = ensureBubble(player);
    const title = bubble.querySelector('.ydc-bubble-title');
    const body = bubble.querySelector('.ydc-bubble-body');
    title.textContent = `“${selection}”`;
    body.textContent = 'Thinking…';
    bubble.style.display = 'block'; // must override the stylesheet's display:none

    const seq = ++explainSeq;
    requestExplanation({ selection, english, spanish }).then(
      (text) => { if (seq === explainSeq) body.textContent = text; },
      (err) => {
        if (seq !== explainSeq) return;
        // "Extension context invalidated" = the extension was reloaded while
        // this tab stayed open; only a page refresh reconnects them.
        body.textContent = /context invalidated|receiving end does not exist/i.test(err.message)
          ? 'The extension was updated — refresh this YouTube tab (⌘R) to reconnect the tutor.'
          : `Couldn't get an explanation: ${err.message}`;
      },
    );
  }

  let cachePollCountdown = 0;
  function tick() {
    if (location.pathname.startsWith('/shorts')) return; // dormant on Shorts
    const player = document.getElementById('movie_player');
    if (!player) return;
    const video = player.querySelector('video');
    const ccButton = player.querySelector('.ytp-subtitles-button');
    const ccOn = ccButton && ccButton.getAttribute('aria-pressed') === 'true';
    const haveCues = state.primary.length > 0 || state.secondary.length > 0;

    const overlay = ensureOverlay(player);

    // Scale caption text with the player, like YouTube's native captions
    // (2.2% of player width, clamped to stay readable at the extremes).
    const size = Math.round(Math.max(12, Math.min(40, player.clientWidth * 0.022)));
    if (overlay.__ydcFontSize !== size) {
      overlay.__ydcFontSize = size;
      overlay.style.fontSize = size + 'px';
    }

    const active = Boolean(video && ccOn && haveCues);
    overlay.style.display = active ? '' : 'none';
    player.classList.toggle('ydc-hide-native', active);
    if (!active) return;

    // Translation still missing? Peek at the shared cache every ~5s — another
    // tab (or a later retry) may have fetched it for this video already.
    if (!state.secondary.length && --cachePollCountdown <= 0) {
      cachePollCountdown = 50;
      const vid = new URLSearchParams(location.search).get('v');
      const cached = vid && loadEsCache(vid);
      if (cached) state.secondary = cached;
    }

    if (holdUpdates) return; // don't wipe an in-progress selection
    const tMs = video.currentTime * 1000;
    // Quiz mode (English hidden) only applies while Spanish is present —
    // never leave the viewer with no captions at all.
    const hideEn = hidePrimary && state.secondary.length > 0;
    setLine(overlay.children[0], hideEn ? '' : activeText(state.primary, tMs));
    setLine(overlay.children[1], activeText(state.secondary, tMs));
  }

  setInterval(tick, 100);
})();
