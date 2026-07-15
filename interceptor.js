// Runs in the page's MAIN world. Watches for YouTube's own caption
// (/api/timedtext) requests, forwards the response to the content script,
// and obtains a second, translated track (tlang=TARGET_LANG).
//
// Two ways to get the translation:
//  1. Re-fetch the captured URL with tlang added. Works when the URL isn't
//     bound to a proof-of-origin token.
//  2. When the URL carries a `pot` token (common on logged-in profiles), a
//     modified re-fetch gets rejected with 429 — so instead we ask the player
//     itself to load the auto-translated track (its own request carries a
//     valid token), capture it, then restore the original track.
//
// If captions were already on before this script attached (the base track was
// fetched before our hook existed), we reload the player's captions module so
// the request happens again where we can see it.
(() => {
  'use strict';

  const TARGET_LANG = 'es';   // translation language shown on the second line
  const FALLBACK_BASE = 'en'; // used if the selected track is already TARGET_LANG

  // YouTube uses regional codes (es-419, es-US) — match on the base language.
  function isLang(code, base) {
    return !!code && String(code).split('-')[0] === base;
  }

  const origFetch = window.fetch;
  const requestedCounterparts = new Set();
  const state = {
    videoId: null, primary: false, secondary: false,
    driven: false, bootstrapped: false, attempts: 0, retryPending: false,
  };
  let restoreTrack = null;

  function resetVideoState(videoId) {
    state.videoId = videoId;
    state.primary = false;
    state.secondary = false;
    state.driven = false;
    state.attempts = 0;
    state.retryPending = false;
  }

  // The translated track can be temporarily rate-limited (429) even for the
  // player's own request. Retry with spaced backoff until it comes through.
  const RETRY_DELAYS = [8000, 20000, 45000];
  function scheduleRetry() {
    if (state.secondary || state.retryPending) return;
    if (state.attempts >= RETRY_DELAYS.length) return;
    const delay = RETRY_DELAYS[state.attempts++];
    const vid = state.videoId;
    state.retryPending = true;
    setTimeout(() => {
      state.retryPending = false;
      if (state.secondary || state.videoId !== vid) return;
      state.driven = false;
      driveTranslation();
    }, delay);
  }

  function dispatchTrack(role, body) {
    document.dispatchEvent(new CustomEvent('ydc:track', {
      detail: JSON.stringify({ role, body })
    }));
  }

  function playerEl() {
    return document.getElementById('movie_player');
  }

  function ccIsOn() {
    const btn = document.querySelector('.ytp-subtitles-button');
    return btn && btn.getAttribute('aria-pressed') === 'true';
  }

  // Ask the player to load the auto-translated track (verified mechanism:
  // translationLanguage embedded in the track object), then restore the
  // original track once the translation has been captured.
  function driveTranslation() {
    if (state.driven) return true;
    const player = playerEl();
    if (!player || typeof player.setOption !== 'function' || typeof player.getOption !== 'function') {
      return false;
    }
    let saved = null;
    try { saved = player.getOption('captions', 'track'); } catch {}
    if (!saved || !saved.languageCode) return false;
    try {
      player.setOption('captions', 'track',
        Object.assign({}, saved, { translationLanguage: { languageCode: TARGET_LANG } }));
    } catch {
      return false;
    }
    state.driven = true;
    restoreTrack = () => {
      restoreTrack = null;
      try {
        const clean = Object.assign({}, saved);
        delete clean.translationLanguage;
        player.setOption('captions', 'track', clean);
      } catch {}
    };
    // Safety net: restore even if the translated track never arrives.
    setTimeout(() => { if (restoreTrack) restoreTrack(); }, 5000);
    scheduleRetry(); // watchdog: re-drive if the translation doesn't arrive
    return true;
  }

  async function fetchCounterpart(url) {
    const cp = new URL(url, location.origin);
    const tlang = cp.searchParams.get('tlang');
    const lang = cp.searchParams.get('lang');
    const isTarget = isLang(tlang, TARGET_LANG) || (!tlang && isLang(lang, TARGET_LANG));
    let role;
    if (isTarget) {
      role = 'primary';
      if (tlang) cp.searchParams.delete('tlang');
      else cp.searchParams.set('tlang', FALLBACK_BASE);
    } else {
      role = 'secondary';
      cp.searchParams.set('tlang', TARGET_LANG);
    }
    const cpUrl = cp.toString();
    if (cpUrl === url || requestedCounterparts.has(cpUrl)) return;
    requestedCounterparts.add(cpUrl);
    try {
      const resp = await origFetch(cpUrl, { credentials: 'same-origin' });
      const body = await resp.text();
      if (resp.ok && looksLikeCaptions(body)) {
        dispatchTrack(role, body);
        state[role] = true;
        return;
      }
    } catch (e) {
      // fall through to the player-driven path
    }
    if (role === 'secondary') driveTranslation();
  }

  // A 429/403 error page must never be mistaken for caption data.
  function looksLikeCaptions(body) {
    return typeof body === 'string' && body.charCodeAt(0) === 123 /* '{' */ && body.includes('"events"');
  }

  async function handleTimedtext(url, bodyText, ok) {
    try {
      const u = new URL(url, location.origin);
      if (u.searchParams.get('fmt') !== 'json3') return;

      const videoId = u.searchParams.get('v') || '';
      if (videoId !== state.videoId) resetVideoState(videoId);

      const tlang = u.searchParams.get('tlang');
      const lang = u.searchParams.get('lang');
      const isTarget = isLang(tlang, TARGET_LANG) || (!tlang && isLang(lang, TARGET_LANG));
      const role = isTarget ? 'secondary' : 'primary';

      if (ok === false || !looksLikeCaptions(bodyText)) {
        // Rate-limited or error response — retry the translation later.
        if (role === 'secondary' && state.primary) scheduleRetry();
        return;
      }

      dispatchTrack(role, bodyText);
      state[role] = true;
      if (role === 'secondary' && restoreTrack) restoreTrack();
      if (state.primary && state.secondary) return;

      const missing = role === 'secondary' ? 'primary' : 'secondary';
      if (missing === 'secondary' && u.searchParams.has('pot')) {
        // Token-bound URL: a modified re-fetch would be rejected (429).
        if (driveTranslation()) return;
      }
      fetchCounterpart(url);
    } catch (e) {
      // Never break the page over caption handling.
    }
  }

  // If the base track loaded before our hook attached, reload the captions
  // module so the player requests it again where we can capture it.
  function bootstrap() {
    if (state.primary || state.bootstrapped) return;
    if (!ccIsOn()) return; // don't force captions on for the user
    const player = playerEl();
    if (!player || typeof player.loadModule !== 'function' || typeof player.unloadModule !== 'function') return;
    state.bootstrapped = true;
    try {
      player.unloadModule('captions');
      player.loadModule('captions');
    } catch (e) {}
  }
  setTimeout(bootstrap, 1500);
  setTimeout(bootstrap, 4000); // second chance if the player was still loading

  window.addEventListener('yt-navigate-start', () => {
    resetVideoState(null);
    state.bootstrapped = false;
  });
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(bootstrap, 1500);
    setTimeout(bootstrap, 4000);
  });

  function isTimedtext(url) {
    return typeof url === 'string' && url.includes('/api/timedtext');
  }

  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
    const p = origFetch.apply(this, args);
    if (isTimedtext(url)) {
      p.then((resp) => {
        const ok = resp.ok;
        resp.clone().text().then((body) => handleTimedtext(url, body, ok));
      }).catch(() => {});
    }
    return p;
  };

  // Some player versions load captions via XHR instead of fetch.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ydcUrl = typeof url === 'string' ? url : String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTimedtext(this._ydcUrl)) {
      this.addEventListener('load', () => {
        handleTimedtext(this._ydcUrl, this.responseText, this.status >= 200 && this.status < 300);
      });
    }
    return origSend.apply(this, args);
  };
})();
