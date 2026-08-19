// X Bookmark Media Saver - Content Script
//
// Media now comes from interceptor.js, which reads X's own bookmarks API
// response in the page context. The DOM scanner below is a fallback for media
// that is already on screen before the interceptor sees a request (e.g. the
// extension was reloaded mid-session).

(function () {
  'use strict';

  const AUTH_KEY = 'xbms_auth';

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

  // Errors that mean "this tweet is already in the state we want" are not
  // failures — the bookmark is gone either way.
  function isAlreadyGone(message) {
    return /not ?found|does not exist|no status found|already/i.test(message || '');
  }

  async function unbookmarkOne(statusId) {
    try {
      if (await unbookmarkViaUi(statusId)) return { ok: true, via: 'ui' };
    } catch (e) {
      console.warn('[XBMS] UI removal threw for', statusId, e.message);
    }

    const stored = await chrome.storage.local.get(AUTH_KEY).catch(() => ({}));
    auth = { ...(stored[AUTH_KEY] || {}), ...auth };

    const credentials = {
      queryId: auth.DeleteBookmarkQueryId,
      bearer: auth.bearerToken,
      csrf: document.cookie.match(/ct0=([^;]+)/)?.[1] || auth.csrfToken || null
    };

    if (!credentials.csrf) {
      return { ok: false, fatal: 'auth', error: 'Not signed in to X' };
    }
    if (!credentials.queryId || !credentials.bearer) {
      return { ok: false, fatal: 'auth', error: 'Bookmark API details not captured — reload the bookmarks page' };
    }

    try {
      await unbookmarkViaApi(statusId, credentials);
      hideArticle(statusId); // the page won't do it for us
      return { ok: true, via: 'api' };
    } catch (e) {
      // A rate limit applies to everything that follows; a missing tweet does not.
      if (e.rateLimited) return { ok: false, fatal: 'rate-limit', error: e.message };
      if (isAlreadyGone(e.message)) return { ok: true, via: 'already-gone' };
      return { ok: false, error: e.message };
    }
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'GET_DETECTED_MEDIA') {
      sendResponse({ items: scanDom() });

    } else if (msg.type === 'CLEAR_MEDIA') {
      sendResponse({ ok: true });

    } else if (msg.type === 'IS_BOOKMARKS_PAGE') {
      sendResponse({ isBookmarksPage: checkIfBookmarksPage() });

    } else if (msg.type === 'UNBOOKMARK_ONE') {
      (async () => { sendResponse(await unbookmarkOne(msg.statusId)); })();
      return true;
    }

    return true;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────

  checkIfBookmarksPage();
  console.log('[XBMS] content script loaded. Bookmarks page:', isBookmarksPage);
})();
