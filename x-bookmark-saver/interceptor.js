// X Bookmark Media Saver - Page-context interceptor
//
// Runs in the MAIN world at document_start, before X's bundle captures its own
// references to fetch/XHR. X renders bookmarks from a GraphQL response that
// already contains everything we need — handle, post date, image URLs and
// direct MP4 variants — so we read that instead of scraping the DOM, which
// changes shape every few months.

(function () {
  'use strict';

  const TAG = '[XBMS/net]';

  // ── What to capture ────────────────────────────────────────────────────────

  // The bookmarks timeline has been renamed before (and may be again), so match
  // the operation name when we can and fall back to "any timeline fetched while
  // the user is on the bookmarks/history page".
  function shouldCapture(url) {
    if (!url || !url.includes('/i/api/graphql/')) return false;
    const op = url.split('?')[0].split('/').pop() || '';
    if (/Bookmark/i.test(op)) return true;
    if (/^(Bookmarks|History)$/i.test(op)) return true;
    const path = location.pathname.toLowerCase();
    const onBookmarksPage = path.includes('bookmark') || path.includes('/i/history');
    return onBookmarksPage && /Timeline|Bookmarks|History/i.test(op);
  }

  function post(payload) {
    window.postMessage({ __xbms: true, ...payload }, location.origin);
  }

  // ── Auth capture (for un-bookmarking later) ────────────────────────────────

  function captureAuth(url, headers) {
    if (!url.includes('/i/api/graphql/')) return;

    const m = url.match(/\/graphql\/([^/?]+)\/(\w+)/);
    if (!m) return;
    const [, queryId, operation] = m;

    const auth = {};
    if (/^(Delete|Create)Bookmark$/.test(operation)) auth[`${operation}QueryId`] = queryId;

    // Headers arrive as a Headers object, a plain object, or an array of pairs
    // depending on how the caller built the request.
    const get = (name) => {
      if (!headers) return null;
      const want = name.toLowerCase();
      if (typeof headers.get === 'function') return headers.get(name);
      if (Array.isArray(headers)) {
        const hit = headers.find(h => String(h[0]).toLowerCase() === want);
        return hit ? hit[1] : null;
      }
      const key = Object.keys(headers).find(k => k.toLowerCase() === want);
      return key ? headers[key] : null;
    };

    const bearer = get('authorization');
    if (bearer) auth.bearerToken = String(bearer).replace(/^Bearer\s+/i, '');
    const csrf = get('x-csrf-token');
    if (csrf) auth.csrfToken = csrf;

    if (Object.keys(auth).length > 0) post({ kind: 'auth', auth });
  }

  // ── Response parsing ───────────────────────────────────────────────────────

  // Walk the timeline JSON and pull out every tweet result. X nests these
  // differently across timeline types and keeps changing the wrapper shape, so
  // recurse and collect anything that looks like a tweet rather than following
  // a fixed path.
  function collectTweetResults(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return out;

    if (Array.isArray(node)) {
      for (const child of node) collectTweetResults(child, out, depth + 1);
      return out;
    }

    const typename = node.__typename;
    if (typename === 'Tweet' || typename === 'TweetWithVisibilityResults') {
      const tweet = typename === 'TweetWithVisibilityResults' ? node.tweet : node;
      if (tweet && (tweet.rest_id || tweet.legacy)) out.push(tweet);
    }

    for (const key of Object.keys(node)) {
      if (key === 'user_results') continue; // users carry their own pinned tweets
      collectTweetResults(node[key], out, depth + 1);
    }
    return out;
  }

  function screenNameOf(tweet) {
    const user = tweet?.core?.user_results?.result;
    // Newer responses hoist screen_name out of legacy; older ones keep it there.
    return user?.core?.screen_name || user?.legacy?.screen_name || null;
  }

  // "Wed Oct 10 20:19:24 +0000 2018" -> "2018-10-10"
  function postedDateOf(tweet) {
    const raw = tweet?.legacy?.created_at;
    if (!raw) return null;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    return new Date(ms).toISOString().slice(0, 10);
  }

  function bestVideoVariant(variants) {
    const mp4s = (variants || []).filter(v => v.content_type === 'video/mp4' && v.url);
    if (mp4s.length === 0) return null;
    mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s[0].url;
  }

  function originalImageUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.set('name', 'orig');
      return u.toString();
    } catch { return url; }
  }

  // A bookmarked retweet carries its media on the retweeted tweet.
  function mediaSourceOf(tweet) {
    const rt = tweet?.legacy?.retweeted_status_result?.result;
    const rtTweet = rt?.__typename === 'TweetWithVisibilityResults' ? rt.tweet : rt;
    if (rtTweet?.legacy?.extended_entities?.media?.length) return rtTweet;
    return tweet;
  }

  function extractMedia(tweet) {
    // Un-bookmarking targets the bookmarked tweet, but handle/date/media should
    // describe whoever actually posted the media.
    const bookmarkedId = tweet?.rest_id || tweet?.legacy?.id_str || null;
    const source = mediaSourceOf(tweet);
    const media = source?.legacy?.extended_entities?.media || [];
    if (!bookmarkedId || media.length === 0) return [];

    const username = screenNameOf(source) || screenNameOf(tweet);
    const postedAt = postedDateOf(source) || postedDateOf(tweet);
    const sourceId = source?.rest_id || bookmarkedId;

    const items = [];
    media.forEach((m, index) => {
      const type = m.type === 'photo' ? 'image' : m.type === 'animated_gif' ? 'gif' : 'video';
      let url = null;

      if (type === 'image') {
        url = m.media_url_https ? originalImageUrl(m.media_url_https) : null;
      } else {
        url = bestVideoVariant(m.video_info?.variants);
        // No MP4 offered (rare, mostly live/broadcast) — fall back to HLS and
        // let the background worker stitch segments.
        if (!url) url = (m.video_info?.variants || []).find(v => v.url?.includes('.m3u8'))?.url || null;
      }

      if (!url) return;

      items.push({
        id: `${sourceId}_${index}`,
        type,
        url,
        thumbnail: m.media_url_https ? `${m.media_url_https}?name=small` : null,
        tweetUrl: username ? `https://x.com/${username}/status/${sourceId}` : `https://x.com/i/status/${sourceId}`,
        statusId: bookmarkedId,
        username,
        postedAt,
        source: 'api'
      });
    });
    return items;
  }

  function handleBody(url, text) {
    if (!text || text.length < 2) return;
    let json;
    try { json = JSON.parse(text); } catch { return; }

    const tweets = collectTweetResults(json, [], 0);
    if (tweets.length === 0) return;

    const items = [];
    for (const tweet of tweets) items.push(...extractMedia(tweet));
    if (items.length === 0) return;

    console.log(`${TAG} ${tweets.length} tweets -> ${items.length} media items from`, url.split('?')[0]);
    post({ kind: 'media', items });
  }

  // ── fetch ──────────────────────────────────────────────────────────────────

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : input?.url || ''; } catch { /* ignore */ }

    try {
      const headers = init?.headers || (typeof input === 'object' ? input?.headers : null);
      captureAuth(url, headers);
    } catch { /* never break the page's request */ }

    const result = nativeFetch.apply(this, arguments);

    if (shouldCapture(url)) {
      result.then(resp => {
        // clone() so the page still gets an unread body
        resp.clone().text().then(text => handleBody(url, text)).catch(() => {});
      }).catch(() => {});
    }
    return result;
  };

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────

  const NativeXHR = window.XMLHttpRequest;
  const open = NativeXHR.prototype.open;
  const send = NativeXHR.prototype.send;
  const setRequestHeader = NativeXHR.prototype.setRequestHeader;

  NativeXHR.prototype.open = function (method, url) {
    this.__xbmsUrl = url;
    this.__xbmsHeaders = {};
    return open.apply(this, arguments);
  };

  NativeXHR.prototype.setRequestHeader = function (name, value) {
    if (this.__xbmsHeaders) this.__xbmsHeaders[name] = value;
    return setRequestHeader.apply(this, arguments);
  };

  NativeXHR.prototype.send = function () {
    const url = this.__xbmsUrl || '';
    try { captureAuth(url, this.__xbmsHeaders); } catch { /* ignore */ }

    if (shouldCapture(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') handleBody(url, this.responseText);
        } catch { /* ignore */ }
      });
    }
    return send.apply(this, arguments);
  };

  // ── Bookmark query IDs from X's own bundle ─────────────────────────────────
  //
  // DeleteBookmark's queryId rotates with each deploy and we only see it if the
  // user un-bookmarks something by hand. X ships every operation's id in its JS
  // bundles, so read them from there instead of shipping a stale constant.

  async function scrapeQueryIds() {
    const scripts = [...document.querySelectorAll('script[src]')]
      .map(s => s.src)
      .filter(src => /\/(main|api|bundle)\.[\w.-]+\.js$/.test(src) || /responsive-web/.test(src));

    for (const src of scripts.slice(0, 12)) {
      try {
        const text = await (await nativeFetch(src)).text();
        if (!text.includes('DeleteBookmark')) continue;
        const found = {};
        for (const op of ['DeleteBookmark', 'CreateBookmark']) {
          const re = new RegExp(`queryId:"([^"]+)",operationName:"${op}"|operationName:"${op}",queryId:"([^"]+)"`);
          const m = text.match(re);
          if (m) found[`${op}QueryId`] = m[1] || m[2];
        }
        if (Object.keys(found).length > 0) {
          console.log(`${TAG} query ids from bundle:`, found);
          post({ kind: 'auth', auth: found });
          return;
        }
      } catch { /* try the next bundle */ }
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(scrapeQueryIds, 2500), { once: true });
  } else {
    setTimeout(scrapeQueryIds, 2500);
  }

  console.log(`${TAG} interceptor installed`);
})();
