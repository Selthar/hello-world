// X Bookmark Media Saver - Background Service Worker
importScripts('zipper.js');

const STORAGE_KEY = 'xbms_queue';
const DOWNLOADED_KEY = 'xbms_downloaded';
const RUN_KEY = 'xbms_run';
const RATE_LOG_KEY = 'xbms_unbookmark_log';
const KEEPALIVE_ALARM = 'xbms_keepalive';

// Removals are writes against the account, so they are capped over a rolling
// hour. The log lives in storage so the cap holds across runs and restarts.
const UNBOOKMARK_HOURLY_CAP = 200;
const DEFAULT_UNBOOKMARK_DELAY_MS = 2000;
// Generous, and only counts unexpected errors — a tweet that is already gone
// is not a failure. This exists to catch something systemically broken.
const CONSECUTIVE_FAILURE_LIMIT = 10;

// Media fetches are ordinary CDN reads, but they still go out one at a time
// with a gap between them, and back off when a server asks us to.
const DEFAULT_DOWNLOAD_DELAY_MS = 500;
const FETCH_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Spread requests out so the timing doesn't look metronomic.
function jittered(ms) {
  return Math.round(ms * (0.6 + Math.random() * 0.8));
}

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

// Fetch a media URL and return its bytes as a Uint8Array.
// Retries transient failures with exponential backoff, honouring Retry-After
// when the server sends one. A 429 that survives every attempt is escalated so
// the caller can stop the whole run instead of grinding on.
async function fetchBytes(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(url, { headers: { 'Referer': 'https://x.com/' } });
    } catch (networkError) {
      lastError = networkError;
      if (attempt === FETCH_ATTEMPTS) break;
      await sleep(jittered(1000 * Math.pow(2, attempt - 1)));
      continue;
    }

    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());

    if (!RETRYABLE_STATUS.has(resp.status) || attempt === FETCH_ATTEMPTS) {
      const err = new Error(`HTTP ${resp.status}`);
      if (resp.status === 429) err.rateLimited = true;
      throw err;
    }

    const retryAfter = parseInt(resp.headers.get('Retry-After') || '', 10);
    const backoff = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, 60000)
      : 1000 * Math.pow(2, attempt - 1);
    console.warn(`[XBMS] HTTP ${resp.status} on attempt ${attempt}, waiting ${backoff}ms`);
    await sleep(jittered(backoff));
    lastError = new Error(`HTTP ${resp.status}`);
  }

  throw lastError || new Error('fetch failed');
}

// Build a zip of all queued items and trigger a single download
async function downloadAllAsZip(toDownload, onProgress, settings = {}) {
  const zip = new ZipBuilder();
  let completed = 0;
  let failed = 0;
  const total = toDownload.length;
  const failedItems = [];
  const succeededItems = [];
  let stoppedReason = null;

  const delayMs = Number.isFinite(Number(settings.downloadDelayMs))
    ? Number(settings.downloadDelayMs)
    : DEFAULT_DOWNLOAD_DELAY_MS;

  for (let i = 0; i < toDownload.length; i++) {
    const item = toDownload[i];
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
      // Rate limited even after backing off — keep what we have and stop, so
      // the rest stay queued for later rather than burning through as failures.
      if (err.rateLimited) {
        stoppedReason = 'X is rate limiting downloads — stopped, remaining items stay queued';
        break;
      }
    }
    await onProgress({ completed: completed + failed, total, downloaded: completed, failed, lastItemId: item.id });
    if (i < toDownload.length - 1 && delayMs > 0) await sleep(jittered(delayMs));
  }

  if (succeededItems.length === 0) {
    return { completed, failed, failedItems, succeededItems, stoppedReason };
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

  return { completed, failed, failedItems, succeededItems, stoppedReason };
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

// ─── HISTORY EXPORT ──────────────────────────────────────────────────────────

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(c => csvCell(row[c])).join(','));
  return lines.join('\r\n');
}

// One row per media item the extension has ever seen, so the folder on disk can
// be reconciled without going back through X.
async function exportHistory() {
  const queue = await getQueue();
  if (queue.length === 0) return { ok: false, error: 'Nothing to export yet' };

  const rows = queue.map(item => ({
    status: item.status || '',
    handle: item.username ? `@${item.username}` : '',
    posted: item.postedAt || '',
    type: item.type || '',
    filename: item.filename || '',
    folder: item.type === 'image' ? 'Images' : 'Videos',
    tweet_url: item.tweetUrl || '',
    status_id: item.statusId || '',
    media_url: item.url || '',
    error: item.error || ''
  }));

  rows.sort((a, b) => (a.handle + a.posted).localeCompare(b.handle + b.posted));

  const columns = ['status', 'handle', 'posted', 'type', 'filename', 'folder', 'tweet_url', 'status_id', 'media_url', 'error'];
  // Excel needs the BOM to read the file as UTF-8.
  const csv = '\uFEFF' + toCsv(rows, columns);
  const bytes = new TextEncoder().encode(csv);
  const dataUrl = await bytesToDataUrl(bytes, 'text/csv');

  const filename = `X-Bookmarks-history-${new Date().toISOString().slice(0, 10)}.csv`;
  const id = await startDownload({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' });
  await waitForDownload(id);

  return { ok: true, count: rows.length, filename };
}

// ─── RUN STATE ───────────────────────────────────────────────────────────────
//
// Long jobs are owned by the worker, not the popup, and their progress lives in
// storage. Closing the popup does not stop anything, and reopening it shows the
// run still going. An alarm resurrects the worker if Chrome shuts it down
// mid-run.

async function getRun() {
  const result = await chrome.storage.local.get(RUN_KEY);
  return result[RUN_KEY] || null;
}

async function setRun(run) {
  await chrome.storage.local.set({ [RUN_KEY]: run });
  chrome.runtime.sendMessage({ type: 'RUN_UPDATED', run }).catch(() => {});
}

async function clearRun(summary) {
  await chrome.storage.local.remove(RUN_KEY);
  chrome.alarms.clear(KEEPALIVE_ALARM);
  chrome.runtime.sendMessage({ type: 'RUN_DONE', ...summary }).catch(() => {});
}

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

async function recentRemovals() {
  const stored = await chrome.storage.local.get(RATE_LOG_KEY);
  const cutoff = Date.now() - 60 * 60 * 1000;
  return (stored[RATE_LOG_KEY] || []).filter(t => t > cutoff);
}

// ─── BOOKMARK WRITE RUNS ─────────────────────────────────────────────────────
//
// Removing and restoring bookmarks are the same loop with a different message.
// Both are account writes and share the hourly cap.

const RUN_ACTIONS = {
  unbookmark: { message: 'UNBOOKMARK_ONE' },
  rebookmark: { message: 'REBOOKMARK_ONE' }
};

let writeLoopActive = false;

async function startWriteRun(kind, statusIds, settings = {}) {
  if (!RUN_ACTIONS[kind]) return { ok: false, error: `Unknown run type: ${kind}` };
  if (statusIds.length === 0) return { ok: false, error: 'Nothing to do' };
  const existing = await getRun();
  if (existing?.active) return { ok: false, error: 'A run is already in progress' };

  await setRun({
    kind, active: true, ids: statusIds, index: 0,
    done: 0, failed: 0, total: statusIds.length,
    settings, startedAt: Date.now(), stoppedReason: null
  });
  startKeepalive();
  driveWriteRun();
  return { ok: true, started: true, total: statusIds.length };
}

const startUnbookmarkRun = (statusIds, settings) => startWriteRun('unbookmark', statusIds, settings);

async function driveWriteRun() {
  if (writeLoopActive) return;
  writeLoopActive = true;

  try {
    let consecutiveFailures = 0;

    while (true) {
      const run = await getRun();
      if (!run?.active || !RUN_ACTIONS[run.kind]) break;

      if (run.index >= run.ids.length) {
        await clearRun({ kind: run.kind, done: run.done, failed: run.failed, stoppedReason: null });
        break;
      }

      const rateLog = await recentRemovals();
      if (rateLog.length >= UNBOOKMARK_HOURLY_CAP) {
        await stopWriteRun(run, `Hourly limit reached (${UNBOOKMARK_HOURLY_CAP}) — resume later`);
        break;
      }

      const tab = await findXTab();
      if (!tab) {
        await stopWriteRun(run, 'No X tab open — open x.com and start again');
        break;
      }

      const statusId = run.ids[run.index];
      let result;
      try {
        result = await chrome.tabs.sendMessage(tab.id, { type: RUN_ACTIONS[run.kind].message, statusId });
      } catch {
        result = { ok: false, fatal: 'page', error: 'X page not ready — reload it and start again' };
      }

      // Anything fatal applies to the whole run; everything else is one tweet's
      // problem and the run carries on.
      if (result?.fatal) {
        await stopWriteRun(run, result.error || 'Stopped');
        break;
      }

      if (result?.ok) {
        rateLog.push(Date.now());
        await chrome.storage.local.set({ [RATE_LOG_KEY]: rateLog });
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        console.warn(`[XBMS] ${run.kind} failed for`, statusId, result?.error);
      }

      await setRun({
        ...run,
        index: run.index + 1,
        done: run.done + (result?.ok ? 1 : 0),
        failed: run.failed + (result?.ok ? 0 : 1)
      });

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        const latest = await getRun();
        await stopWriteRun(latest, `Stopped after ${consecutiveFailures} failures in a row: ${result?.error || 'unknown error'}`);
        break;
      }

      const delay = Number(run.settings?.unbookmarkDelayMs) > 0
        ? Number(run.settings.unbookmarkDelayMs)
        : DEFAULT_UNBOOKMARK_DELAY_MS;
      await sleep(jittered(delay));
    }
  } finally {
    writeLoopActive = false;
  }
}

async function stopWriteRun(run, reason) {
  console.warn(`[XBMS] ${run?.kind || 'run'} stopped:`, reason);
  await clearRun({ kind: run?.kind || 'unbookmark', done: run?.done || 0, failed: run?.failed || 0, stoppedReason: reason });
}

// Chrome can shut the worker down mid-run; the alarm brings it back and the
// loop picks up from the stored index.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  const run = await getRun();
  if (run?.active && RUN_ACTIONS[run.kind]) driveWriteRun();
  else if (!run?.active) chrome.alarms.clear(KEEPALIVE_ALARM);
});

// ─── UNBOOKMARKING ───────────────────────────────────────────────────────────

async function findXTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => t.url?.includes('x.com/i/bookmarks'))
    || tabs.find(t => t.url?.includes('x.com') || t.url?.includes('twitter.com'))
    || null;
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

          await setRun({
            kind: 'download', active: true, index: 0, done: 0, failed: 0,
            total: toDownload.length, startedAt: Date.now(), stoppedReason: null
          });
          startKeepalive();

          try {
            const { completed, failed, failedItems, succeededItems, stoppedReason } = await downloadAllAsZip(
              toDownload,
              async (progress) => {
                await setRun({
                  kind: 'download', active: true, index: progress.completed,
                  done: progress.downloaded, failed: progress.failed,
                  total: progress.total, stoppedReason: null
                });
              },
              settings
            );

            for (const item of succeededItems) await markDownloaded(item.id);
            for (const item of failedItems) await markFailed(item.id, 'fetch error');

            // Close out the download run before starting the removal run —
            // only one run is active at a time.
            await clearRun({ kind: 'download', done: completed, failed, stoppedReason });

            if (unbookmark && succeededItems.length > 0) {
              // One tweet can hold several media items — unbookmark each once.
              const statusIds = [...new Set(succeededItems.map(i => i.statusId).filter(Boolean))];
              const result = await startUnbookmarkRun(statusIds, settings);
              if (!result?.ok) console.warn('[XBMS] unbookmark after save failed:', result?.error);
            }

          } catch (err) {
            await clearRun({
              kind: 'download', done: 0, failed: toDownload.length, stoppedReason: err.message
            });
          }
        })();

      } else if (msg.type === 'RESTORABLE_IDS') {
        const queue = await getQueue();
        const statusIds = [...new Set(queue.map(i => i.statusId).filter(Boolean))];
        sendResponse({ ok: true, statusIds, count: statusIds.length });

      } else if (msg.type === 'START_REBOOKMARK') {
        sendResponse(await startWriteRun('rebookmark', msg.statusIds || [], msg.settings || {}));

      } else if (msg.type === 'START_UNBOOKMARK') {
        sendResponse(await startWriteRun('unbookmark', msg.statusIds || [], msg.settings || {}));

      } else if (msg.type === 'GET_RUN') {
        sendResponse({ run: await getRun() });

      } else if (msg.type === 'CANCEL_RUN') {
        const run = await getRun();
        if (run) await clearRun({ kind: run.kind, done: run.done, failed: run.failed, stoppedReason: 'Cancelled' });
        sendResponse({ ok: true });

      } else if (msg.type === 'EXPORT_HISTORY') {
        sendResponse(await exportHistory());

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
