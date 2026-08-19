// X Bookmark Media Saver - Content Script

(function () {
  'use strict';

  let observer = null;
  let isBookmarksPage = false;

  function checkIfBookmarksPage() {
    const path = window.location.pathname;
    isBookmarksPage = path.includes('/bookmarks') || path.includes('/i/bookmarks');
    return isBookmarksPage;
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('twimg.com')) u.searchParams.delete('name');
      return u.toString();
    } catch { return url; }
  }

  function getBestImageUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'pbs.twimg.com') { u.searchParams.set('name', 'orig'); return u.toString(); }
      return url;
    } catch { return url; }
  }

  function extractUsername(articleEl) {
    if (!articleEl) return null;
    const statusLink = articleEl.querySelector('a[href*="/status/"]');
    if (statusLink) {
      const match = statusLink.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,50})\/status\//);
      if (match) return match[1];
    }
    for (const span of articleEl.querySelectorAll('span')) {
      const t = span.textContent?.trim();
      if (t && /^@[A-Za-z0-9_]{1,50}$/.test(t)) return t.slice(1);
    }
    for (const a of articleEl.querySelectorAll('a[href^="/"]')) {
      const href = a.getAttribute('href') || '';
      if (/^\/[A-Za-z0-9_]{1,50}$/.test(href)) return href.slice(1);
    }
    return null;
  }

  function generateFilename(url, type, username) {
    const prefix = username ? `@${username}_` : '';
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      const last = parts[parts.length - 1];
      if (type === 'image') {
        const fmt = u.searchParams.get('format') || 'jpg';
        return `${prefix}${last.replace(/\.[^.]+$/, '')}.${fmt}`;
      }
      // For videos/gifs — never use .m3u8 or .ts as the extension
      if (last.includes('.') && !last.endsWith('.m3u8') && !last.endsWith('.ts')) {
        return `${prefix}${last}`;
      }
      // Extract tweet ID from path for a clean filename
      const tweetId = parts.find(p => /^\d{10,}$/.test(p));
      if (tweetId) return `${prefix}${tweetId}.mp4`;
      return `${prefix}${last.replace(/\.[^.]+$/, '') || 'media_' + Date.now()}.mp4`;
    } catch { return `${prefix}media_${Date.now()}.${type === 'image' ? 'jpg' : 'mp4'}`; }
  }

  // ── State ────────────────────────────────────────────────────────────────────

  // committedKeys: items we've fully resolved and sent — never re-send
  const committedKeys = new Set();

  // pendingByKey: items seen but missing username/tweetUrl, retried on each scan
  const pendingByKey = new Map();
  const PENDING_TIMEOUT_MS = 10000;

  // tweetContext: statusId -> username, built up as we scan articles
  // Used by the video network sniffer to look up usernames by tweet ID
  const tweetContext = new Map();

  // ── Key generation ───────────────────────────────────────────────────────────

  function makeKey(mediaUrl, statusId) {
    if (!statusId) return mediaUrl;
    try {
      const u = new URL(mediaUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      const name = parts[parts.length - 1].replace(/\.[^.]+$/, '');
      return `${statusId}::${name}`;
    } catch { return mediaUrl; }
  }

  // ── Core detection logic ─────────────────────────────────────────────────────

  function processMediaCandidate(mediaUrl, rawUrl, thumbnail, type, article) {
    const now = Date.now();
    const tweetLink = article?.querySelector('a[href*="/status/"]');
    const tweetUrl = tweetLink ? `https://x.com${tweetLink.getAttribute('href')}` : null;
    const statusId = tweetUrl?.match(/\/status\/(\d+)/)?.[1] || null;
    const username = extractUsername(article);
    const key = makeKey(mediaUrl, statusId);

    if (committedKeys.has(key)) return null;

    if (username && tweetUrl) {
      committedKeys.add(key);
      pendingByKey.delete(key);
      if (statusId) tweetContext.set(statusId, username);
      return {
        id: key, type, url: mediaUrl, thumbnail,
        tweetUrl, statusId, username,
        filename: generateFilename(mediaUrl, type, username),
        detectedAt: now
      };
    }

    if (!pendingByKey.has(key)) {
      pendingByKey.set(key, { mediaUrl, rawUrl, thumbnail, type, tweetUrl, statusId, firstSeen: now });
      return null;
    }

    const p = pendingByKey.get(key);
    const resolvedTweetUrl = tweetUrl || p.tweetUrl;
    const resolvedStatusId = statusId || p.statusId;
    const resolvedKey = makeKey(mediaUrl, resolvedStatusId);
    const timedOut = (now - p.firstSeen) >= PENDING_TIMEOUT_MS;

    if (username || timedOut) {
      pendingByKey.delete(key);
      committedKeys.add(resolvedKey);
      if (resolvedStatusId && username) tweetContext.set(resolvedStatusId, username);
      return {
        id: resolvedKey, type, url: mediaUrl, thumbnail,
        tweetUrl: resolvedTweetUrl, statusId: resolvedStatusId,
        username: username || null,
        filename: generateFilename(mediaUrl, type, username || null),
        detectedAt: p.firstSeen
      };
    }

    // Still waiting — update with any newly available info
    if (tweetUrl && !p.tweetUrl) p.tweetUrl = tweetUrl;
    if (statusId && !p.statusId) p.statusId = statusId;
    return null;
  }

  function extractMediaFromElement(el) {
    const items = [];

    // Images
    const imgs = el.querySelectorAll(
      'img[src*="pbs.twimg.com/media"], img[srcset*="pbs.twimg.com/media"], img[data-src*="pbs.twimg.com/media"]'
    );
    imgs.forEach(img => {
      let rawUrl = img.src || '';
      if (!rawUrl.includes('pbs.twimg.com/media')) {
        const first = (img.getAttribute('srcset') || '').split(',')[0].trim().split(' ')[0];
        if (first.includes('pbs.twimg.com/media')) rawUrl = first;
      }
      if (!rawUrl.includes('pbs.twimg.com/media')) rawUrl = img.getAttribute('data-src') || '';
      if (!rawUrl || !rawUrl.includes('pbs.twimg.com/media')) return;
      const bestUrl = getBestImageUrl(rawUrl);
      const r = processMediaCandidate(bestUrl, rawUrl, rawUrl, 'image', img.closest('article'));
      if (r) items.push(r);
    });

    // Videos
    el.querySelectorAll('video[src*="twimg.com"], video source[src*="twimg.com"]').forEach(v => {
      const rawUrl = v.src || v.getAttribute('src');
      if (!rawUrl || !rawUrl.includes('twimg.com')) return;
      const norm = normalizeUrl(rawUrl);
      const poster = v.closest('video')?.poster || null;
      const r = processMediaCandidate(norm, rawUrl, poster, 'video', v.closest('article'));
      if (r) items.push(r);
    });

    // GIFs
    el.querySelectorAll('video[autoplay][loop]').forEach(v => {
      const src = v.src || v.querySelector('source')?.src;
      if (!src || !src.includes('twimg.com')) return;
      const r = processMediaCandidate(normalizeUrl(src), src, v.poster || null, 'gif', v.closest('article'));
      if (r) items.push(r);
    });

    return items;
  }

  // ── Scanning ─────────────────────────────────────────────────────────────────

  function scanNodes(nodes) {
    if (!checkIfBookmarksPage()) return;
    const newItems = [];

    document.querySelectorAll('article').forEach(a => {
      const uname = extractUsername(a);
      if (uname) {
        a.querySelectorAll('a[href*="/status/"]').forEach(link => {
          const sid = link.getAttribute('href').match(/\/status\/(\d+)/)?.[1];
          if (sid) tweetContext.set(sid, uname);
        });
      }
      extractMediaFromElement(a).forEach(i => newItems.push(i));
    });

    // For articles containing a video player, send username patches to background.
    // The background sniffer may have added those videos without a username
    // (amplify_video IDs don't appear in innerHTML), so we patch them here
    // by matching the video element's poster URL, which contains the same numeric ID.
    const videoPatches = {};
    document.querySelectorAll('article').forEach(a => {
      const uname = extractUsername(a);
      if (!uname) return;
      a.querySelectorAll('video').forEach(v => {
        // poster URL looks like: https://pbs.twimg.com/amplify_thumb/2038269794588475392/img/...
        // or the video src blob may not help, but poster reliably contains the media ID
        const poster = v.poster || '';
        const m = poster.match(/\/(\d{10,})\//);
        if (m) videoPatches[m[1]] = uname;
        // Also try the video's src if it's not a blob
        const src = v.src || '';
        const sm = src.match(/\/(amplify_video|ext_tw_video)\/(\d+)\//);
        if (sm) videoPatches[sm[2]] = uname;
      });
    });

    if (Object.keys(videoPatches).length > 0) {
      console.log('[XBMS] video patches from poster URLs:', videoPatches);
      chrome.runtime.sendMessage({ type: 'REGISTER_MEDIA_IDS', map: videoPatches }).catch(() => {});
    } else {
      const videoArticles = [...document.querySelectorAll('article')].filter(a => a.querySelector('video'));
      if (videoArticles.length > 0) {
        const sample = videoArticles[0].querySelector('video');
        console.log('[XBMS] no patches found | sample video poster:', sample?.poster?.slice(0, 80), '| src:', sample?.src?.slice(0, 80));
      }
    }

    nodes.forEach(n => {
      if (n.nodeType === 1) extractMediaFromElement(n).forEach(i => newItems.push(i));
    });

    if (newItems.length > 0) {
      chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', items: newItems }).catch(() => {});
    }
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      const added = [];
      mutations.forEach(m => m.addedNodes.forEach(n => added.push(n)));
      if (added.length) {
        setTimeout(() => scanNodes(added), 600);
        setTimeout(() => scanNodes(added), 1500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => scanNodes([]), 800);
    setTimeout(() => scanNodes([]), 2000);
  }

  let periodicTimer = null;
  function startPeriodicScan() {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = setInterval(() => { if (checkIfBookmarksPage()) scanNodes([]); }, 2000);
  }
  function stopPeriodicScan() {
    if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  }

  // ── URL change (SPA) ─────────────────────────────────────────────────────────

  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      checkIfBookmarksPage();
      if (isBookmarksPage) { setTimeout(() => scanNodes([]), 1000); startPeriodicScan(); }
      else stopPeriodicScan();
    }
  }).observe(document, { subtree: true, childList: true });

  // ── Messages ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'GET_DETECTED_MEDIA') {
      // Trigger a fresh scan and return whatever we find
      if (!checkIfBookmarksPage()) { sendResponse({ items: [] }); return true; }
      const items = [];
      document.querySelectorAll('article').forEach(a => {
        extractMediaFromElement(a).forEach(i => items.push(i));
      });
      sendResponse({ items });

    } else if (msg.type === 'CLEAR_MEDIA') {
      committedKeys.clear();
      pendingByKey.clear();
      tweetContext.clear();
      sendResponse({ ok: true });

    } else if (msg.type === 'IS_BOOKMARKS_PAGE') {
      sendResponse({ isBookmarksPage: checkIfBookmarksPage() });

    } else if (msg.type === 'GET_USERNAME_FOR_TWEET') {
      const { statusId } = msg;
      let username = null;

      if (statusId) {
        // 1. Fresh DOM search
        for (const article of document.querySelectorAll('article')) {
          const link = article.querySelector(`a[href*="/status/${statusId}"]`);
          if (link) {
            username = extractUsername(article);
            console.log('[XBMS] found article for', statusId, '| link href:', link.getAttribute('href'), '| username:', username);
            if (username) {
              tweetContext.set(statusId, username);
              break;
            }
          }
        }
        // 2. Fall back to cached context map
        if (!username) {
          username = tweetContext.get(statusId) || null;
          console.log('[XBMS] tweetContext fallback for', statusId, '->', username);
        }
      }

      console.log('[XBMS] GET_USERNAME_FOR_TWEET', statusId, '->', username, '| articles in DOM:', document.querySelectorAll('article').length);
      sendResponse({ username });

    } else if (msg.type === 'GET_ACTIVE_VIDEO_USERNAME') {
      let username = null;
      const playing = document.querySelector('video:not([paused])');
      if (playing) username = extractUsername(playing.closest('article'));
      if (!username) {
        for (const a of document.querySelectorAll('article')) {
          if (!a.querySelector('video')) continue;
          const r = a.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) { username = extractUsername(a); if (username) break; }
        }
      }
      sendResponse({ username });

    } else if (msg.type === 'UNBOOKMARK_ITEMS') {
      (async () => {
        const { statusIds = [] } = msg;
        let unbookmarked = 0;
        const csrfMatch = document.cookie.match(/ct0=([^;]+)/);
        const csrf = csrfMatch ? csrfMatch[1] : null;
        if (!csrf) { sendResponse({ ok: false, error: 'No CSRF token' }); return; }
        const qid = window.__xbms_deleteBookmarkQueryId || 'Wlmlj2-xzyS1GN3a6cj-mQ';
        const bearer = window.__xbms_bearerToken ||
          'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
        for (const sid of statusIds) {
          try {
            const resp = await fetch(`https://x.com/i/api/graphql/${qid}/DeleteBookmark`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearer}`,
                'X-Csrf-Token': csrf,
                'X-Twitter-Active-User': 'yes',
                'X-Twitter-Auth-Type': 'OAuth2Session',
                'X-Twitter-Client-Language': 'en',
              },
              body: JSON.stringify({ variables: { tweet_id: sid }, queryId: qid }),
              credentials: 'include'
            });
            if (resp.ok) unbookmarked++;
            else {
              const b = await resp.text().catch(() => '');
              console.warn('[XBMS] unbookmark failed', sid, resp.status, b.slice(0, 200));
            }
            await new Promise(r => setTimeout(r, 300));
          } catch (e) { console.warn('[XBMS] unbookmark error', sid, e.message); }
        }
        sendResponse({ ok: true, unbookmarked });
      })();
    }

    return true;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────

  checkIfBookmarksPage();
  startObserver();
  if (isBookmarksPage) startPeriodicScan();
  console.log('[X Bookmark Saver] Loaded. Bookmarks page:', isBookmarksPage);
})();
