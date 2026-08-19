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

async function updateBadge(queue) {
  const remaining = queue.filter(i => i.status === 'queued').length;
  chrome.action.setBadgeText({ text: remaining > 0 ? remaining.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
}

// ─── FILENAMES ───────────────────────────────────────────────────────────────

function sanitize(part) {
  return String(part).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

function extensionFor(item) {
  if (item.type === 'image') {
    try {
      const u = new URL(item.url);
      const fromParam = u.searchParams.get('format');
      if (fromParam) return fromParam;
      const fromPath = u.pathname.match(/\.(jpg|jpeg|png|gif|webp)$/i);
      if (fromPath) return fromPath[1].toLowerCase();
    } catch { /* fall through */ }
    return 'jpg';
  }
  return 'mp4';
}

// @handle_2024-03-17_1780512345678901234_0.jpg
// Username and post date lead the name so files sort by author, then date.
function generateFilename(item) {
  const parts = [];
  parts.push(item.username ? `@${sanitize(item.username)}` : '@unknown');
  parts.push(item.postedAt ? sanitize(item.postedAt) : 'undated');
  parts.push(sanitize(item.statusId || item.id));

  const index = String(item.id || '').split('_')[1];
  if (index !== undefined && index !== '' && index !== '0') parts.push(index);

  return `${parts.join('_')}.${extensionFor(item)}`;
}

// ─── QUEUE ───────────────────────────────────────────────────────────────────

async function addToQueue(items) {
  const queue = await getQueue();
  const downloaded = new Set(await getDownloaded());
  const byId = new Map(queue.map(i => [i.id, i]));

  let added = 0;
  for (const raw of items) {
    if (!raw?.id || !raw?.url) continue;
    const item = { ...raw, filename: generateFilename(raw) };

    if (downloaded.has(item.id)) continue;

    const existing = byId.get(item.id);
    if (!existing) {
      queue.push({ ...item, status: 'queued' });
      byId.set(item.id, item);
      added++;
      continue;
    }

    // Prefer the API's data over the DOM fallback's, and fill in anything the
    // earlier sighting was missing.
    if (existing.status !== 'queued') continue;
    const better = (item.source === 'api' && existing.source !== 'api');
    if (better || (!existing.username && item.username) || (!existing.postedAt && item.postedAt)) {
      Object.assign(existing, {
        url: better ? item.url : existing.url,
        thumbnail: existing.thumbnail || item.thumbnail,
        username: item.username || existing.username,
        postedAt: item.postedAt || existing.postedAt,
        tweetUrl: item.tweetUrl || existing.tweetUrl,
        statusId: item.statusId || existing.statusId,
        source: better ? item.source : existing.source
      });
      existing.filename = generateFilename(existing);
    }
  }

  await saveQueue(queue);
  await updateBadge(queue);
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
  await updateBadge(updated);
}

async function markFailed(itemId, reason) {
  const queue = await getQueue();
  const updated = queue.map(i => i.id === itemId ? { ...i, status: 'failed', error: reason } : i);
  await saveQueue(updated);
  await updateBadge(updated);
}

async function clearQueue() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  chrome.action.setBadgeText({ text: '' });
}

// ─── DOWNLOADING ─────────────────────────────────────────────────────────────

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(downloadId);
      } else if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(delta.error?.current || 'interrupted'));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(downloadId);
    });
  });
}

// Download a single item (used for individual downloads only)
async function downloadItem(item) {
  const folder = `X-Bookmarks/${item.type === 'image' ? 'Images' : 'Videos'}`;
  const filename = `${folder}/${item.filename || generateFilename(item)}`;

  if (item.url.includes('.m3u8')) {
    // HLS has no single downloadable URL — stitch it, then hand over bytes.
    const bytes = await fetchHlsVideo(item.url);
    const dataUrl = await bytesToDataUrl(bytes, 'video/mp4');
    const id = await startDownload({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' });
    return waitForDownload(id);
  }

  const id = await startDownload({ url: item.url, filename, saveAs: false, conflictAction: 'uniquify' });
  return waitForDownload(id);
}

// Fetch a media URL and return its bytes as a Uint8Array
async function fetchBytes(url) {
  const resp = await fetch(url, { headers: { 'Referer': 'https://x.com/' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
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
      const bytes = item.url.includes('.m3u8')
        ? await fetchHlsVideo(item.url)
        : await fetchBytes(item.url);

      const folder = item.type === 'image' ? 'Images' : 'Videos';
      zip.addFile(`${folder}/${item.filename || generateFilename(item)}`, bytes);
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

  if (succeededItems.length === 0) {
    return { completed, failed, failedItems, succeededItems };
  }

  const dataUrl = await bytesToDataUrl(zip.build(), 'application/zip');

  // Generate filename with a per-day incrementing counter: X-Bookmarks-2026-03-17_01.zip
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `xbms_zip_counter_${today}`;
  const stored = await chrome.storage.local.get(counterKey);
  const count = (stored[counterKey] || 0) + 1;
  await chrome.storage.local.set({ [counterKey]: count });
  const zipFilename = `X-Bookmarks-${today}_${String(count).padStart(2, '0')}.zip`;

  const id = await startDownload({ url: dataUrl, filename: zipFilename, saveAs: false, conflictAction: 'uniquify' });
  await waitForDownload(id);

  return { completed, failed, failedItems, succeededItems };
}

function bytesToDataUrl(bytes, mimeType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
  });
}

// ─── HLS FALLBACK ────────────────────────────────────────────────────────────
// Only reached when X offers no progressive MP4 for a video (live/broadcast
// clips, mostly). Everything else now arrives as a direct .mp4 from the API.

async function fetchPlaylistSegments(m3u8Url) {
  const H = { 'Referer': 'https://x.com/' };
  const resp = await fetch(m3u8Url, { headers: H });
  if (!resp.ok) throw new Error(`Playlist fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  const playlistUrl = new URL(m3u8Url);
  const domainRoot = `${playlistUrl.protocol}//${playlistUrl.hostname}`;
  const playlistDir = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  const resolveUrl = (path) => {
    if (path.startsWith('http')) return path;
    if (path.startsWith('/')) return domainRoot + path;
    return playlistDir + path;
  };

  const initMatch = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const segmentUrls = text.split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(resolveUrl);

  const chunks = [];
  if (initMatch) {
    const initResp = await fetch(resolveUrl(initMatch[1]), { headers: H });
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

async function fetchHlsVideo(m3u8Url) {
  const resp = await fetch(m3u8Url, { headers: { 'Referer': 'https://x.com/' } });
  if (!resp.ok) throw new Error(`Playlist fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();

  const playlistUrl = new URL(m3u8Url);
  const domainRoot = `${playlistUrl.protocol}//${playlistUrl.hostname}`;
  const playlistDir = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const resolveUrl = (path) => {
    if (path.startsWith('http')) return path;
    if (path.startsWith('/')) return domainRoot + path;
    return playlistDir + path;
  };

  const allLines = text.split('\n').map(l => l.trim());
  const nonCommentLines = allLines.filter(l => l && !l.startsWith('#'));
  if (!nonCommentLines.some(l => l.includes('.m3u8'))) return fetchPlaylistSegments(m3u8Url);

  const videoStreams = [];
  for (let i = 0; i < allLines.length; i++) {
    if (!allLines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const nextLine = allLines[i + 1];
    if (!nextLine || nextLine.startsWith('#')) continue;
    videoStreams.push({
      bandwidth: parseInt(allLines[i].match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10),
      url: resolveUrl(nextLine)
    });
  }

  if (videoStreams.length > 0) {
    videoStreams.sort((a, b) => b.bandwidth - a.bandwidth);
    return fetchPlaylistSegments(videoStreams[0].url);
  }

  const firstM3u8 = nonCommentLines.find(l => l.includes('.m3u8'));
  if (firstM3u8) return fetchHlsVideo(resolveUrl(firstM3u8));
  throw new Error('No playable stream found in master playlist');
}

// ─── UNBOOKMARKING ───────────────────────────────────────────────────────────

async function findXTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => t.url?.includes('x.com/i/bookmarks'))
    || tabs.find(t => t.url?.includes('x.com') || t.url?.includes('twitter.com'))
    || null;
}

async function unbookmarkStatusIds(statusIds) {
  if (statusIds.length === 0) return { ok: true, unbookmarked: 0 };
  const tab = await findXTab();
  if (!tab) return { ok: false, error: 'No X tab open' };
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'UNBOOKMARK_ITEMS', statusIds });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── MESSAGES ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'MEDIA_DETECTED') {
        const added = await addToQueue(msg.items || []);
        if (added > 0) chrome.runtime.sendMessage({ type: 'QUEUE_UPDATED' }).catch(() => {});
        sendResponse({ ok: true, added });

      } else if (msg.type === 'GET_QUEUE') {
        sendResponse({ queue: await getQueue() });

      } else if (msg.type === 'DOWNLOAD_ITEM') {
        const { item } = msg;
        try {
          await downloadItem(item);
          await markDownloaded(item.id);
          sendResponse({ ok: true });
        } catch (err) {
          await markFailed(item.id, err.message);
          sendResponse({ ok: false, error: err.message });
        }

      } else if (msg.type === 'DOWNLOAD_ALL') {
        sendResponse({ ok: true, started: true });

        (async () => {
          const { settings = {} } = msg;
          const batchSize = settings.batchSize || 50;
          const unbookmark = settings.unbookmarkAfterSave || false;

          const queue = await getQueue();
          const toDownload = queue.filter(i => i.status === 'queued').slice(0, batchSize);
          if (toDownload.length === 0) return;

          try {
            const { completed, failed, failedItems, succeededItems } = await downloadAllAsZip(
              toDownload,
              (progress) => {
                chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', ...progress }).catch(() => {});
              }
            );

            for (const item of toDownload) {
              if (failedItems.some(f => f.id === item.id)) await markFailed(item.id, 'fetch error');
              else await markDownloaded(item.id);
            }

            let unbookmarked = 0;
            if (unbookmark && succeededItems.length > 0) {
              // One tweet can hold several media items — unbookmark each once.
              const statusIds = [...new Set(succeededItems.map(i => i.statusId).filter(Boolean))];
              const result = await unbookmarkStatusIds(statusIds);
              unbookmarked = result?.unbookmarked || 0;
              if (!result?.ok) console.warn('[XBMS] unbookmark after save failed:', result?.error);
            }

            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_DONE',
              downloaded: completed, failed, unbookmarked, total: toDownload.length
            }).catch(() => {});

          } catch (err) {
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_DONE',
              downloaded: 0, failed: toDownload.length, total: toDownload.length, error: err.message
            }).catch(() => {});
          }
        })();

      } else if (msg.type === 'UNBOOKMARK_DOWNLOADED') {
        const queue = await getQueue();
        const statusIds = [...new Set(
          queue.filter(i => i.status === 'downloaded' && i.statusId).map(i => i.statusId)
        )];
        sendResponse({ ok: true, statusIds, count: statusIds.length });

      } else if (msg.type === 'FULL_RESET') {
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: [], [STORAGE_KEY]: [] });
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });

      } else if (msg.type === 'CLEAR_HISTORY') {
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: [] });
        sendResponse({ ok: true });

      } else if (msg.type === 'CLEAR_QUEUE') {
        await clearQueue();
        sendResponse({ ok: true });

      } else if (msg.type === 'REMOVE_ITEM') {
        const queue = await getQueue();
        const updated = queue.filter(i => i.id !== msg.itemId);
        await saveQueue(updated);
        await updateBadge(updated);
        // Drop it from history too so it can be re-queued
        const downloaded = await getDownloaded();
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: downloaded.filter(id => id !== msg.itemId) });
        sendResponse({ ok: true });

      } else {
        sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});

chrome.runtime.onStartup.addListener(async () => updateBadge(await getQueue()));
