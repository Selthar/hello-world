// X Bookmark Media Saver - Background Service Worker
importScripts('zipper.js');


const STORAGE_KEY = 'xbms_queue';
const DOWNLOADED_KEY = 'xbms_downloaded';

// Keep a running queue in storage so it persists across popup opens/closes
async function getQueue() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function getDownloaded() {
  const result = await chrome.storage.local.get(DOWNLOADED_KEY);
  return result[DOWNLOADED_KEY] || [];
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_KEY]: queue });
}

async function addToQueue(items) {
  const queue = await getQueue();
  const downloaded = await getDownloaded();
  const downloadedIds = new Set(downloaded);
  const existingIds = new Set(queue.map(i => i.id));

  let added = 0;
  for (const item of items) {
    if (downloadedIds.has(item.id)) {
      console.log(`[XBMS] skipping ${item.type} (already downloaded):`, item.filename);
    } else if (existingIds.has(item.id)) {
      // already queued, fine
    } else {
      queue.push({ ...item, status: 'queued' });
      added++;
    }
  }

  if (added > 0) {
    await saveQueue(queue);
    chrome.action.setBadgeText({ text: queue.filter(i => i.status === 'queued').length.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  }

  return added;
}

async function markDownloaded(itemId) {
  const downloaded = await getDownloaded();
  if (!downloaded.includes(itemId)) {
    downloaded.push(itemId);
    await chrome.storage.local.set({ [DOWNLOADED_KEY]: downloaded });
  }

  const queue = await getQueue();
  const updated = queue.map(i => i.id === itemId ? { ...i, status: 'downloaded' } : i);
  await saveQueue(updated);

  const remaining = updated.filter(i => i.status === 'queued').length;
  chrome.action.setBadgeText({ text: remaining > 0 ? remaining.toString() : '' });
}

async function markFailed(itemId, reason) {
  const queue = await getQueue();
  const updated = queue.map(i => i.id === itemId ? { ...i, status: 'failed', error: reason } : i);
  await saveQueue(updated);
}

async function clearQueue() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  chrome.action.setBadgeText({ text: '' });
}

// Download a single item (used for individual downloads only)
async function downloadItem(item) {
  return new Promise((resolve, reject) => {
    const folder = `X-Bookmarks/${item.type === 'image' ? 'Images' : 'Videos'}`;
    const filename = `${folder}/${item.filename}`;
    chrome.downloads.download(
      { url: item.url, filename, saveAs: false, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError.message); return; }
        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve(downloadId);
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(delta.error?.current || 'interrupted');
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

// Fetch a media URL and return its bytes as a Uint8Array
async function fetchBytes(url) {
  const resp = await fetch(url, {
    headers: { 'Referer': 'https://x.com/', 'Origin': 'https://x.com' }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

// Build a zip of all queued items and trigger a single download
async function downloadAllAsZip(toDownload, onProgress) {
  const zip = new ZipBuilder();
  let completed = 0;
  let failed = 0;
  const total = toDownload.length;
  const failedItems = [];
  const succeededItems = [];

  for (const item of toDownload) {
    await chrome.storage.local.set({ _keepalive: Date.now() });
    try {
      let bytes;
      if (item.type === 'video' && item.url.includes('.m3u8')) {
        bytes = await fetchHlsVideo(item.url);
      } else {
        bytes = await fetchBytes(item.url);
      }
      const folder = item.type === 'image' ? 'Images' : 'Videos';
      zip.addFile(`${folder}/${item.filename}`, bytes);
      succeededItems.push(item);
      completed++;
    } catch (err) {
      console.warn(`[XBMS] failed to fetch ${item.type} ${item.filename}:`, err.message, item.url);
      failed++;
      failedItems.push(item);
    }
    onProgress({ completed: completed + failed, total, downloaded: completed, failed, lastItemId: item.id });
    await new Promise(r => setTimeout(r, 50));
  }

  // Build zip and convert to data URL for a single download prompt
  const zipBytes = zip.build();
  const blob = new Blob([zipBytes], { type: 'application/zip' });
  const dataUrl = await blobToDataUrl(blob);

  // Generate filename with a per-day incrementing counter: X-Bookmarks-2026-03-17_01.zip
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `xbms_zip_counter_${today}`;
  const stored = await chrome.storage.local.get(counterKey);
  const count = (stored[counterKey] || 0) + 1;
  await chrome.storage.local.set({ [counterKey]: count });
  const seq = String(count).padStart(2, '0');
  const zipFilename = `X-Bookmarks-${today}_${seq}.zip`;

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: zipFilename, saveAs: false, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError.message); return; }
        const listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener); resolve();
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(delta.error?.current || 'interrupted');
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });

  return { completed, failed, failedItems, succeededItems };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ─── VIDEO SNIFFING VIA webRequest ──────────────────────────────────────────
// X streams video via HLS (.m3u8 playlists + .ts segments).
// We intercept the media playlist requests (the ones that list actual .ts chunks)
// and store them so we can download + concatenate all segments at save time.

const seenVideoUrls = new Set();

// Ask the content script in a given tab for the username of the currently
// playing video.
// Intercept X's own bookmark API calls to capture the live query ID and bearer token
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const url = details.url;
    if (!url.includes('x.com/i/api/graphql')) return;
    if (!url.includes('Bookmark')) return;

    // Extract query ID from URL: /i/api/graphql/<queryId>/DeleteBookmark
    const queryMatch = url.match(/\/graphql\/([^/]+)\/(Delete|Create)Bookmark/);
    if (!queryMatch) return;

    const queryId = queryMatch[1];
    const action = queryMatch[2]; // 'Delete' or 'Create'

    // Extract bearer token from Authorization header
    const authHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'authorization');
    const bearerToken = authHeader?.value?.replace('Bearer ', '') || null;

    // Inject these into the page so the content script can use them
    const tabs = details.tabId ? [{ id: details.tabId }] : [];
    if (tabs.length > 0) {
      chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        func: (qId, bToken) => {
          window.__xbms_deleteBookmarkQueryId = qId;
          if (bToken) window.__xbms_bearerToken = bToken;
        },
        args: [queryId, bearerToken]
      }).catch(() => {});
    }
  },
  { urls: ['https://x.com/i/api/graphql/*Bookmark*'] },
  ['requestHeaders']
);

async function getUsernameFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_ACTIVE_VIDEO_USERNAME' });
    return response?.username || null;
  } catch {
    return null;
  }
}

// Maps amplify_video/ext_tw_video asset ID -> username
// Populated when X's Bookmarks API response is intercepted via declarativeNetRequest
// For now this is populated opportunistically from the content script
const mediaIdToUsername = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    if (
      !details.initiator?.includes('x.com') &&
      !details.initiator?.includes('twitter.com')
    ) return;

    // Capture .m3u8 playlist URLs.
    // Prefer master playlists (no /avc1/ or /mp4a/ in path) over sub-playlists.
    // Skip audio-only playlists entirely — fetchHlsVideo handles audio via the master.
    if (
      url.includes('video.twimg.com') &&
      url.includes('.m3u8')
    ) {
      const isMaster = !url.includes('/avc1/') && !url.includes('/mp4a/') && !url.includes('/aud/');
      const isAudioOnly = url.includes('/mp4a/') || url.includes('/aud/');

      if (isAudioOnly) return;

      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const idPart = parts.find(p => /^\d{10,}$/.test(p)) || null; // null if not found, not the full URL

      console.log('[XBMS] video URL intercepted:', url);
      console.log('[XBMS] isMaster:', isMaster, '| idPart:', idPart);

      if (seenVideoUrls.has(url)) return;
      seenVideoUrls.add(url);

      (async () => {
        try {
          const tabs = await chrome.tabs.query({});
          const xTab = tabs.find(t => t.url?.includes('x.com/i/bookmarks'))
            || tabs.find(t => t.url?.includes('x.com') || t.url?.includes('twitter.com'));

          let username = null;
          if (idPart) {
            username = mediaIdToUsername.get(idPart) || null;
            if (!username) {
              const delays = [600, 1200, 2000, 3500];
              for (const delay of delays) {
                await new Promise(r => setTimeout(r, delay));
                username = mediaIdToUsername.get(idPart) || null;
                if (username) break;
              }
            }
          }
          console.log('[XBMS] video username resolved:', username, '| idPart:', idPart);

          // Check if this video is already in the queue (added by DOM scanner)
          // If so, update its username rather than adding a duplicate
          const queue = await getQueue();
          const existing = queue.find(i => {
            if (i.type !== 'video' || i.status !== 'queued') return false;
            try {
              const eid = new URL(i.url).pathname.split('/').filter(Boolean).find(p => /^\d{10,}$/.test(p));
              return eid && eid === idPart;
            } catch { return false; }
          });

          if (existing) {
            const existingIsMaster = !existing.url.includes('/avc1/') && !existing.url.includes('/mp4a/');
            if (existingIsMaster && !isMaster) return; // already have a better URL, skip
            // Update with master URL and username if we got one
            const updated = queue.map(i =>
              i.id === existing.id ? {
                ...i,
                id: isMaster ? url : i.id,
                url: isMaster ? url : i.url,
                username: username || i.username,
                filename: generateVideoFilename(isMaster ? url : i.url, username || i.username)
              } : i
            );
            await saveQueue(updated);
            // Notify popup of the update
            chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', items: [] }).catch(() => {});
            return;
          }

          // Not in queue — add it fresh
          const filename = generateVideoFilename(url, username);
          const item = {
            id: url, type: 'video', url,
            thumbnail: null,
            tweetUrl: idPart ? `https://x.com/i/status/${idPart}` : null,
            statusId: idPart || null,
            username, filename,
            detectedAt: Date.now(), source: 'network'
          };
          const added = await addToQueue([item]);
          if (added > 0) {
            chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', items: [item] }).catch(() => {});
          }
        } catch (e) { /* ignore */ }
      })();
    }
  },
  { urls: ['https://video.twimg.com/*'] }
);

function generateVideoFilename(url, username) {
  const prefix = username ? `@${username}_` : '';
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const dimPart = parts.find(p => /^\d+x\d+$/.test(p));  // e.g. 1280x720
    const idPart  = parts.find(p => /^\d{10,}$/.test(p));  // tweet-like numeric ID
    // Save as .ts — raw MPEG-TS, playable in VLC, ffmpeg, most modern players
    if (idPart && dimPart) return `${prefix}${idPart}_${dimPart}.mp4`;
    if (idPart) return `${prefix}${idPart}.mp4`;
    return `${prefix}video_${Date.now()}.mp4`;
  } catch {
    return `${prefix}video_${Date.now()}.ts`;
  }
}

// Fetch segments from a single-track HLS media playlist and concatenate
async function fetchPlaylistSegments(m3u8Url) {
  const H = { 'Referer': 'https://x.com/', 'Origin': 'https://x.com' };
  const resp = await fetch(m3u8Url, { headers: H });
  if (!resp.ok) throw new Error(`Playlist fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  const playlistUrl = new URL(m3u8Url);
  const domainRoot = `${playlistUrl.protocol}//${playlistUrl.hostname}`;
  const playlistDir = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  function resolveUrl(path) {
    if (path.startsWith('http')) return path;
    if (path.startsWith('/')) return domainRoot + path;
    return playlistDir + path;
  }

  // Extract init segment from #EXT-X-MAP if present
  const initMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const initUrl = initMatch ? resolveUrl(initMatch[1]) : null;

  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const segmentUrls = lines.map(resolveUrl);

  const chunks = [];

  // Fetch init segment first if present
  if (initUrl) {
    const initResp = await fetch(initUrl, { headers: H });
    if (initResp.ok) chunks.push(new Uint8Array(await initResp.arrayBuffer()));
  }

  for (const segUrl of segmentUrls) {
    const segResp = await fetch(segUrl, { headers: H });
    if (segResp.ok) chunks.push(new Uint8Array(await segResp.arrayBuffer()));
  }

  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// Fetch an HLS video — parses master playlist, fetches best video + audio tracks,
// and returns them interleaved as a combined fMP4 byte stream.
// Since true muxing requires ffmpeg, we return video-only for now (playable in VLC etc)
// and save audio as a separate file only if the video track is standalone.
async function fetchHlsVideo(m3u8Url) {
  console.log('[XBMS] fetchHlsVideo:', m3u8Url);

  const resp = await fetch(m3u8Url, { headers: { 'Referer': 'https://x.com/', 'Origin': 'https://x.com' } });
  if (!resp.ok) throw new Error(`Playlist fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();
  console.log('[XBMS] playlist:\n', text.slice(0, 600));

  const playlistUrl = new URL(m3u8Url);
  const domainRoot = `${playlistUrl.protocol}//${playlistUrl.hostname}`;
  const playlistDir = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  function resolveUrl(path) {
    if (path.startsWith('http')) return path;
    if (path.startsWith('/')) return domainRoot + path;
    return playlistDir + path;
  }

  // Check if this is already a media playlist (has segments, not sub-playlists)
  const allLines = text.split('\n').map(l => l.trim());
  const nonCommentLines = allLines.filter(l => l && !l.startsWith('#'));
  const hasM3u8Refs = nonCommentLines.some(l => l.includes('.m3u8'));

  if (!hasM3u8Refs) {
    // Already a media playlist — fetch directly
    console.log('[XBMS] media playlist, fetching segments directly');
    return fetchPlaylistSegments(m3u8Url);
  }

  // Master playlist — find best video stream (highest bandwidth/resolution)
  // Parse #EXT-X-STREAM-INF lines for video tracks
  const videoStreams = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      const nextLine = allLines[i + 1]?.trim();
      if (nextLine && !nextLine.startsWith('#')) {
        videoStreams.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          resolution: resMatch ? resMatch[1] : '',
          url: resolveUrl(nextLine)
        });
      }
    }
  }

  if (videoStreams.length > 0) {
    // Pick highest bandwidth stream
    videoStreams.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = videoStreams[0];
    console.log('[XBMS] best video stream:', best.resolution, best.bandwidth, best.url);
    return fetchPlaylistSegments(best.url);
  }

  // Fallback: just use the first non-comment line that's an m3u8
  const firstM3u8 = nonCommentLines.find(l => l.includes('.m3u8'));
  if (firstM3u8) return fetchHlsVideo(resolveUrl(firstM3u8));

  throw new Error('No playable stream found in master playlist');
}

// Handle messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'REGISTER_MEDIA_IDS') {
        const map = msg.map || {};
        let anyNew = false;
        for (const [id, username] of Object.entries(map)) {
          if (!mediaIdToUsername.has(id)) anyNew = true;
          mediaIdToUsername.set(id, username);
        }
        // Retroactively update any queued videos that were added without a username
        if (anyNew) {
          const queue = await getQueue();
          let changed = false;
          const updated = queue.map(item => {
            if (item.type !== 'video' || item.username) return item;
            try {
              const idInUrl = new URL(item.url).pathname.split('/').filter(Boolean).find(p => /^\d{10,}$/.test(p));
              const resolvedUsername = idInUrl ? (map[idInUrl] || mediaIdToUsername.get(idInUrl)) : null;
              if (resolvedUsername) {
                changed = true;
                return { ...item, username: resolvedUsername, filename: generateVideoFilename(item.url, resolvedUsername) };
              }
            } catch { /* ignore */ }
            return item;
          });
          if (changed) {
            await saveQueue(updated);
            chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', items: [] }).catch(() => {});
          }
        }
        sendResponse({ ok: true });

      } else if (msg.type === 'MEDIA_DETECTED') {
        const added = await addToQueue(msg.items);
        sendResponse({ ok: true, added });

      } else if (msg.type === 'GET_QUEUE') {
        const queue = await getQueue();
        sendResponse({ queue });

      } else if (msg.type === 'DOWNLOAD_ITEM') {
        const { item } = msg;
        try {
          await downloadItem(item);
          await markDownloaded(item.id);
          sendResponse({ ok: true });
        } catch (err) {
          await markFailed(item.id, err.toString());
          sendResponse({ ok: false, error: err.toString() });
        }

      } else if (msg.type === 'DOWNLOAD_ALL') {
        sendResponse({ ok: true, started: true });

        (async () => {
          const { settings = {} } = msg;
          const batchSize = settings.batchSize || 50;
          const unbookmark = settings.unbookmarkAfterSave || false;

          const queue = await getQueue();
          // Respect batch size — only take the first N queued items
          const toDownload = queue.filter(i => i.status === 'queued').slice(0, batchSize);
          if (toDownload.length === 0) return;

          try {
            const { completed, failed, failedItems, succeededItems } = await downloadAllAsZip(
              toDownload,
              (progress) => {
                chrome.runtime.sendMessage({
                  type: 'DOWNLOAD_PROGRESS',
                  ...progress,
                  lastStatus: 'fetching'
                }).catch(() => {});
              }
            );

            // Mark statuses
            for (const item of toDownload) {
              const wasFailed = failedItems.some(f => f.id === item.id);
              if (wasFailed) {
                await markFailed(item.id, 'fetch error');
              } else {
                await markDownloaded(item.id);
              }
            }

            // Unbookmark successfully saved items if setting is on
            if (unbookmark && succeededItems.length > 0) {
              try {
                const tabs = await chrome.tabs.query({});
                const xTab = tabs.find(t => t.url?.includes('x.com') || t.url?.includes('twitter.com'));
                if (xTab) {
                  // Dedupe by statusId — one tweet may have multiple media items
                  const statusIds = [...new Set(
                    succeededItems.map(i => i.statusId).filter(Boolean)
                  )];
                  if (statusIds.length > 0) {
                    chrome.tabs.sendMessage(xTab.id, {
                      type: 'UNBOOKMARK_ITEMS',
                      statusIds
                    }).catch(() => {});
                  }
                }
              } catch (e) { /* ignore if no X tab */ }
            }

            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_DONE',
              downloaded: completed,
              failed,
              total: toDownload.length
            }).catch(() => {});

          } catch (err) {
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_DONE',
              downloaded: 0,
              failed: toDownload.length,
              total: toDownload.length,
              error: err.message
            }).catch(() => {});
          }
        })();

      } else if (msg.type === 'UNBOOKMARK_DOWNLOADED') {
        // Collect all unique statusIds from downloaded items in the queue
        const queue = await getQueue();
        const statusIds = [...new Set(
          queue
            .filter(i => i.status === 'downloaded' && i.statusId)
            .map(i => i.statusId)
        )];
        sendResponse({ ok: true, statusIds, count: statusIds.length });

      } else if (msg.type === 'FULL_RESET') {
        // Clear queue, download history, and all extension state
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: [], [STORAGE_KEY]: [] });
        chrome.action.setBadgeText({ text: '' });
        // Also clear the mediaIdToUsername map in memory
        mediaIdToUsername.clear();
        sendResponse({ ok: true });

      } else if (msg.type === 'CLEAR_HISTORY') {
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: [] });
        sendResponse({ ok: true });

      } else if (msg.type === 'CLEAR_QUEUE') {
        await clearQueue();
        sendResponse({ ok: true });

      } else if (msg.type === 'REMOVE_ITEM') {
        // Remove from queue
        const queue = await getQueue();
        const updated = queue.filter(i => i.id !== msg.itemId);
        await saveQueue(updated);
        const remaining = updated.filter(i => i.status === 'queued').length;
        chrome.action.setBadgeText({ text: remaining > 0 ? remaining.toString() : '' });
        // Also remove from download history so it can be re-queued
        const downloaded = await getDownloaded();
        const updatedDownloaded = downloaded.filter(id => id !== msg.itemId);
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: updatedDownloaded });
        sendResponse({ ok: true });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});

// Update badge on install/startup
chrome.runtime.onStartup.addListener(async () => {
  const queue = await getQueue();
  const pending = queue.filter(i => i.status === 'queued').length;
  if (pending > 0) {
    chrome.action.setBadgeText({ text: pending.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  }
});
