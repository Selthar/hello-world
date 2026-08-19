// X Bookmark Media Saver - Content Script
//
// Media now comes from interceptor.js, which reads X's own bookmarks API
// response in the page context. The DOM scanner below is a fallback for media
// that is already on screen before the interceptor sees a request (e.g. the
// extension was reloaded mid-session).

(function () {
  'use strict';

  const AUTH_KEY = 'xbms_auth';
  const RATE_LOG_KEY = 'xbms_unbookmark_log';

  // Removals are writes against your account, so they are paced deliberately.
  // The cap is a rolling one-hour window, kept in storage so it survives
  // reloads and applies across every batch.
  const DEFAULT_DELAY_MS = 2000;
  const HOURLY_CAP = 200;
  const CONSECUTIVE_FAILURE_LIMIT = 3;

  let isBookmarksPage = false;
  let auth = {};

  function checkIfBookmarksPage() {
    const path = window.location.pathname.toLowerCase();
    isBookmarksPage = path.includes('bookmark') || path.includes('/i/history');
    return isBookmarksPage;
  }

  // ── Auth relay ───────────────────────────────────────────────────────────────

  chrome.storage.local.get(AUTH_KEY).then(r => { auth = { ...(r[AUTH_KEY] || {}), ...auth }; }).catch(() => {});

  async function rememberAuth(update) {
    const before = JSON.stringify(auth);
    auth = { ...auth, ...update };
    if (JSON.stringify(auth) !== before) {
      try { await chrome.storage.local.set({ [AUTH_KEY]: auth }); } catch { /* ignore */ }
    }
  }

  // ── Interceptor messages ─────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__xbms !== true) return;

    if (data.kind === 'auth' && data.auth) {
      rememberAuth(data.auth);
    } else if (data.kind === 'media' && Array.isArray(data.items) && data.items.length > 0) {
      chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', items: data.items }).catch(() => {});
    }
  });

  // ── DOM fallback ─────────────────────────────────────────────────────────────

  // Only used to catch media the API interception missed. IDs use the same
  // `${statusId}_${index}` scheme as the API path so the two never duplicate.

  function articleStatusId(article) {
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const m = link.getAttribute('href').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function extractUsername(article) {
    if (!article) return null;
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const m = link.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
      if (m) return m[1];
    }
    const handle = [...article.querySelectorAll('span')]
      .map(s => s.textContent?.trim())
      .find(t => t && /^@[A-Za-z0-9_]{1,15}$/.test(t));
    if (handle) return handle.slice(1);
    return null;
  }

  function postedDate(article) {
    const time = article.querySelector('time[datetime]');
    if (!time) return null;
    const ms = Date.parse(time.getAttribute('datetime'));
    return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
  }

  function originalImageUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.set('name', 'orig');
      return u.toString();
    } catch { return url; }
  }

  function imageUrlFrom(img) {
    const candidates = [
      img.getAttribute('src') || '',
      (img.getAttribute('srcset') || '').split(',')[0].trim().split(' ')[0],
      img.getAttribute('data-src') || ''
    ];
    return candidates.find(u => u.includes('pbs.twimg.com/media')) || null;
  }

  function scanDom() {
    if (!checkIfBookmarksPage()) return [];
    const items = [];

    document.querySelectorAll('article').forEach(article => {
      const statusId = articleStatusId(article);
      if (!statusId) return;
      const username = extractUsername(article);
      const postedAt = postedDate(article);

      // Index media in DOM order so ids line up with the API's media array.
      let index = 0;

      article.querySelectorAll('img').forEach(img => {
        const raw = imageUrlFrom(img);
        if (!raw) return;
        items.push({
          id: `${statusId}_${index++}`,
          type: 'image',
          url: originalImageUrl(raw),
          thumbnail: raw,
          tweetUrl: username ? `https://x.com/${username}/status/${statusId}` : `https://x.com/i/status/${statusId}`,
          statusId, username, postedAt, source: 'dom'
        });
      });

      article.querySelectorAll('video').forEach(video => {
        const src = video.getAttribute('src') || video.querySelector('source')?.getAttribute('src') || '';
        if (!src.includes('twimg.com')) return; // blob: URLs are useless to us
        items.push({
          id: `${statusId}_${index++}`,
          type: video.hasAttribute('loop') ? 'gif' : 'video',
          url: src,
          thumbnail: video.getAttribute('poster') || null,
          tweetUrl: username ? `https://x.com/${username}/status/${statusId}` : `https://x.com/i/status/${statusId}`,
          statusId, username, postedAt, source: 'dom'
        });
      });
    });

    return items;
  }

  // ── Un-bookmarking ───────────────────────────────────────────────────────────
  //
  // Two routes. Clicking X's own button is preferred: X updates its own store,
  // so the row disappears immediately and the request carries whatever headers
  // X currently requires. Calling the API directly works but leaves the page
  // showing a stale list until it reloads, so anything removed that way is
  // hidden by hand.

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Spread requests out so the timing doesn't look metronomic.
  function jittered(ms) {
    return Math.round(ms * (0.6 + Math.random() * 0.8));
  }

  async function recentRemovals() {
    const stored = await chrome.storage.local.get(RATE_LOG_KEY).catch(() => ({}));
    const cutoff = Date.now() - 60 * 60 * 1000;
    return (stored[RATE_LOG_KEY] || []).filter(t => t > cutoff);
  }

  async function recordRemoval(log) {
    log.push(Date.now());
    await chrome.storage.local.set({ [RATE_LOG_KEY]: log }).catch(() => {});
  }

  function findArticle(statusId) {
    for (const article of document.querySelectorAll('article')) {
      if (article.querySelector(`a[href*="/status/${statusId}"]`)) return article;
    }
    return null;
  }

  async function unbookmarkViaUi(statusId) {
    const article = findArticle(statusId);
    if (!article) return false;

    const button = article.querySelector('[data-testid="removeBookmark"]');
    if (!button) return false;

    button.click();

    // X either drops the row from the timeline or flips the button back to
    // "bookmark". Either means it took.
    for (let i = 0; i < 12; i++) {
      await sleep(120);
      if (!article.isConnected) return true;
      if (!article.querySelector('[data-testid="removeBookmark"]')) return true;
    }
    return false;
  }

  function hideArticle(statusId) {
    const article = findArticle(statusId);
    const row = article?.closest('[data-testid="cellInnerDiv"]') || article;
    if (row) row.style.display = 'none';
  }

  async function unbookmarkViaApi(statusId, credentials) {
    const { queryId, bearer, csrf } = credentials;
    const resp = await fetch(`https://x.com/i/api/graphql/${queryId}/DeleteBookmark`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearer}`,
        'X-Csrf-Token': csrf,
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Auth-Type': 'OAuth2Session',
        'X-Twitter-Client-Language': 'en'
      },
      body: JSON.stringify({ variables: { tweet_id: statusId }, queryId }),
      credentials: 'include'
    });

    // Back off completely rather than retrying into a limit.
    if (resp.status === 429) {
      const err = new Error('X is rate limiting this account — stopped');
      err.rateLimited = true;
      throw err;
    }

    const body = await resp.json().catch(() => null);
    // X answers 200 with an errors[] array on failure, so check both.
    if (!resp.ok || body?.errors?.length) {
      throw new Error(body?.errors?.[0]?.message || `HTTP ${resp.status}`);
    }
  }

  async function unbookmarkAll(statusIds, settings = {}) {
    const stored = await chrome.storage.local.get(AUTH_KEY).catch(() => ({}));
    auth = { ...(stored[AUTH_KEY] || {}), ...auth };

    const credentials = {
      queryId: auth.DeleteBookmarkQueryId,
      bearer: auth.bearerToken,
      csrf: document.cookie.match(/ct0=([^;]+)/)?.[1] || auth.csrfToken || null
    };
    const canUseApi = Boolean(credentials.queryId && credentials.bearer && credentials.csrf);
    const delayMs = Number(settings.unbookmarkDelayMs) > 0 ? Number(settings.unbookmarkDelayMs) : DEFAULT_DELAY_MS;

    const rateLog = await recentRemovals();
    let unbookmarked = 0;
    let viaUi = 0;
    let consecutiveFailures = 0;
    let stoppedReason = null;
    const failures = [];

    for (let i = 0; i < statusIds.length; i++) {
      if (rateLog.length >= HOURLY_CAP) {
        stoppedReason = `Hourly limit reached (${HOURLY_CAP}) — resume later`;
        break;
      }

      const sid = statusIds[i];
      try {
        if (await unbookmarkViaUi(sid)) {
          unbookmarked++;
          viaUi++;
          await recordRemoval(rateLog);
          consecutiveFailures = 0;
        } else if (canUseApi) {
          await unbookmarkViaApi(sid, credentials);
          hideArticle(sid); // the page won't do it for us
          unbookmarked++;
          await recordRemoval(rateLog);
          consecutiveFailures = 0;
        } else {
          failures.push('Bookmark API details not captured yet — reload the bookmarks page');
          consecutiveFailures++;
        }
      } catch (e) {
        failures.push(e.message);
        consecutiveFailures++;
        if (e.rateLimited) { stoppedReason = e.message; break; }
      }

      // Something is systematically wrong — stop instead of hammering.
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        stoppedReason = `Stopped after ${consecutiveFailures} failures in a row: ${failures[failures.length - 1]}`;
        break;
      }

      chrome.runtime.sendMessage({
        type: 'UNBOOKMARK_PROGRESS', done: i + 1, total: statusIds.length
      }).catch(() => {});

      if (i < statusIds.length - 1) await sleep(jittered(delayMs));
    }

    if (failures.length > 0) console.warn('[XBMS] unbookmark failures:', failures.slice(0, 5));
    console.log(`[XBMS] unbookmarked ${unbookmarked}/${statusIds.length} (${viaUi} via X's own button)${stoppedReason ? ' — ' + stoppedReason : ''}`);

    return {
      ok: unbookmarked > 0 || statusIds.length === 0,
      unbookmarked,
      failed: failures.length,
      stoppedReason,
      error: stoppedReason || failures[0] || null
    };
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'GET_DETECTED_MEDIA') {
      sendResponse({ items: scanDom() });

    } else if (msg.type === 'CLEAR_MEDIA') {
      sendResponse({ ok: true });

    } else if (msg.type === 'IS_BOOKMARKS_PAGE') {
      sendResponse({ isBookmarksPage: checkIfBookmarksPage() });

    } else if (msg.type === 'UNBOOKMARK_ITEMS') {
      (async () => { sendResponse(await unbookmarkAll(msg.statusIds || [], msg.settings || {})); })();
      return true;
    }

    return true;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────

  checkIfBookmarksPage();
  console.log('[XBMS] content script loaded. Bookmarks page:', isBookmarksPage);
})();
