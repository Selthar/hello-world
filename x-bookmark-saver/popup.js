// X Bookmark Media Saver - Popup Script

let allQueue = [];
let currentFilter = 'queued';
let isDownloading = false;
let activeRun = null;

// Settings state — loaded from storage on init
let settings = {
  batchSize: 50,
  unbookmarkAfterSave: false,
  unbookmarkDelayMs: 2000,
  downloadDelayMs: 500
};

const BATCH_MIN = 5;
const BATCH_MAX = 200;
const BATCH_STEP = 5;

const DELAY_MIN = 1000;
const DELAY_MAX = 15000;
const DELAY_STEP = 1000;

const DL_MIN = 0;
const DL_MAX = 5000;
const DL_STEP = 500;

async function loadSettings() {
  const result = await chrome.storage.local.get('xbms_settings');
  if (result.xbms_settings) {
    settings = { ...settings, ...result.xbms_settings };
  }
}

async function saveSettings() {
  await chrome.storage.local.set({ xbms_settings: settings });
}

function applySettingsToUI() {
  $('batch-val').textContent = settings.batchSize;
  $('toggle-unbookmark').checked = settings.unbookmarkAfterSave;
  $('batch-dec').disabled = settings.batchSize <= BATCH_MIN;
  $('batch-inc').disabled = settings.batchSize >= BATCH_MAX;
  $('dlpace-val').textContent = settings.downloadDelayMs === 0 ? 'off' : `${(settings.downloadDelayMs / 1000).toFixed(1)}s`;
  $('dlpace-dec').disabled = settings.downloadDelayMs <= DL_MIN;
  $('dlpace-inc').disabled = settings.downloadDelayMs >= DL_MAX;
  $('delay-val').textContent = `${Math.round(settings.unbookmarkDelayMs / 1000)}s`;
  $('delay-dec').disabled = settings.unbookmarkDelayMs <= DELAY_MIN;
  $('delay-inc').disabled = settings.unbookmarkDelayMs >= DELAY_MAX;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function toast(msg, type = 'info', duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.className = '', duration);
}

function $(id) { return document.getElementById(id); }

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendContent(tab, msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

// ─── UI RENDERING ────────────────────────────────────────────────────────────

function updateStats() {
  const queued = allQueue.filter(i => i.status === 'queued').length;
  const downloaded = allQueue.filter(i => i.status === 'downloaded').length;
  const failed = allQueue.filter(i => i.status === 'failed').length;

  $('stat-queued').textContent = queued;
  $('stat-downloaded').textContent = downloaded;
  $('stat-failed').textContent = failed;
  $('stat-total').textContent = allQueue.length;

  $('btn-download-all').disabled = queued === 0 || isDownloading;
  if (activeRun?.kind === 'unbookmark') $('btn-unbookmark-downloaded').disabled = true;
}

function getFilteredItems() {
  if (currentFilter === 'all') return allQueue;
  return allQueue.filter(i => i.status === currentFilter);
}

function renderList() {
  const list = $('media-list');
  const empty = $('empty-state');
  const items = getFilteredItems();

  updateStats();

  if (items.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  list.style.display = 'block';
  empty.style.display = 'none';

  list.innerHTML = items.map(item => {
    const thumbHtml = item.thumbnail
      ? `<img src="${escHtml(item.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const placeholderHtml = `<div class="thumb-placeholder" ${item.thumbnail ? 'style="display:none"' : ''}>${item.type === 'image' ? '🖼️' : item.type === 'gif' ? '🎞️' : '🎬'}</div>`;

    const typeLabel = item.type.toUpperCase();
    const tweetBadge = item.tweetUrl
      ? `<a href="${escHtml(item.tweetUrl)}" target="_blank" title="Open tweet" style="color:var(--muted);text-decoration:none">↗</a>`
      : '';

    const canDownload = item.status === 'queued' || item.status === 'failed';
    const dlDisabled = isDownloading ? 'disabled' : '';

    return `
      <div class="media-item" data-id="${escHtml(item.id)}">
        <div class="thumb-wrap">
          ${thumbHtml}
          ${placeholderHtml}
          <div class="type-badge">${typeLabel}</div>
        </div>
        <div class="item-info">
          <div class="item-filename" title="${escHtml(item.filename)}">${escHtml(item.filename)}</div>
          <div class="item-meta">
            <span class="item-status ${item.status}">${item.status}</span>
            ${item.username ? `<span>@${escHtml(item.username)}</span>` : ''}
            ${item.postedAt ? `<span>${escHtml(item.postedAt)}</span>` : ''}
            ${tweetBadge}
          </div>
        </div>
        <div class="item-actions">
          ${canDownload ? `<button class="icon-btn dl" title="Download" ${dlDisabled} data-action="download" data-id="${escHtml(item.id)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>` : ''}
          <button class="icon-btn rm" title="Remove from queue &amp; history" data-action="remove" data-id="${escHtml(item.id)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── RUN STATE ──────────────────────────────────────────────────────────────
//
// Long jobs run in the background worker, so the popup reflects their state
// rather than owning it. Closing the popup does not stop anything.

function renderRun(run) {
  activeRun = run && run.active ? run : null;
  isDownloading = Boolean(activeRun && activeRun.kind === 'download');

  const progressBar = $('progress-bar');
  const progressFill = $('progress-fill');
  const dlBtn = $('btn-download-all');
  const unBtn = $('btn-unbookmark-downloaded');

  if (!activeRun) {
    progressBar.style.display = 'none';
    progressFill.style.width = '0%';
    unBtn.disabled = false;
    unBtn.textContent = 'Unbookmark';
    dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download All`;
    updateStats();
    return;
  }

  const pct = activeRun.total > 0 ? (activeRun.index / activeRun.total) * 100 : 0;
  progressBar.style.display = 'block';
  progressFill.style.width = `${pct}%`;

  if (activeRun.kind === 'download') {
    dlBtn.disabled = true;
    dlBtn.innerHTML = `<span class="spinner"></span> Saving ${activeRun.index}/${activeRun.total}`;
  } else {
    unBtn.disabled = true;
    unBtn.textContent = `${activeRun.index}/${activeRun.total}`;
  }
}

async function restoreRun() {
  const result = await sendBg({ type: 'GET_RUN' });
  renderRun(result?.run || null);
}

// ─── STATUS BAR ──────────────────────────────────────────────────────────────

async function updateStatusBar() {
  const tab = await getActiveTab();
  if (!tab) return;

  const isXPage = tab.url?.includes('x.com') || tab.url?.includes('twitter.com');
  const isBookmarks = tab.url?.includes('/bookmarks');

  const dot = $('status-dot');
  const text = $('status-text');

  if (!isXPage) {
    dot.className = 'status-dot inactive';
    text.innerHTML = 'Not on X.com — <strong>navigate to X first</strong>';
  } else if (!isBookmarks) {
    dot.className = 'status-dot inactive';
    text.innerHTML = 'On X but not bookmarks — <strong>go to /bookmarks</strong>';
  } else {
    dot.className = 'status-dot active';
    text.innerHTML = '<strong>Watching bookmarks</strong> — scroll to detect media';
  }
}

// ─── ACTIONS ────────────────────────────────────────────────────────────────

async function loadQueue() {
  const result = await sendBg({ type: 'GET_QUEUE' });
  allQueue = result?.queue || [];
  renderList();
}

async function rescan() {
  const tab = await getActiveTab();
  if (!tab) { toast('No active tab found', 'error'); return; }

  const resp = await sendContent(tab, { type: 'GET_DETECTED_MEDIA' });
  if (!resp) {
    toast('Cannot reach page — try refreshing X', 'error');
    return;
  }

  if (resp.items && resp.items.length > 0) {
    const bgResp = await sendBg({ type: 'MEDIA_DETECTED', items: resp.items });
    await loadQueue();
    toast(`Found ${bgResp?.added || 0} new item(s)`, 'success');
  } else {
    await loadQueue();
    toast('No media detected yet — scroll your bookmarks', 'info');
  }
}

// Event delegation for download and remove buttons
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('media-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const itemId = btn.dataset.id;
    if (!itemId) return;

    if (action === 'download') {
      if (isDownloading || btn.disabled) return;
      const item = allQueue.find(i => i.id === itemId);
      if (!item) return;
      btn.innerHTML = '<span class="spinner"></span>';
      btn.disabled = true;
      const result = await sendBg({ type: 'DOWNLOAD_ITEM', item });
      await loadQueue();
      if (result?.ok) toast('Downloaded!', 'success');
      else toast(`Failed: ${result?.error || 'unknown error'}`, 'error');

    } else if (action === 'remove') {
      await sendBg({ type: 'REMOVE_ITEM', itemId });
      allQueue = allQueue.filter(i => i.id !== itemId);
      renderList();
      toast('Removed from queue and history', 'info');
    }
  });
});

async function downloadAll() {
  const queued = allQueue.filter(i => i.status === 'queued');
  if (queued.length === 0) return;

  isDownloading = true;
  const btn = $('btn-download-all');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting...';

  // The worker owns the run from here — closing the popup does not stop it.
  await sendBg({ type: 'DOWNLOAD_ALL', settings });
  await restoreRun();
}

function finishRun(msg) {
  renderRun(null);
  loadQueue();

  if (msg.kind === 'unbookmark') {
    if (msg.stoppedReason) toast(`Unbookmarked ${msg.done} — ${msg.stoppedReason}`, 'info', 6000);
    else if (msg.failed > 0) toast(`Unbookmarked ${msg.done}, ${msg.failed} failed`, 'info', 4000);
    else toast(`Unbookmarked ${msg.done} tweets ✓`, 'success', 3500);
    return;
  }

  if (msg.stoppedReason) {
    toast(`${msg.done} saved — ${msg.stoppedReason}`, 'info', 6000);
    return;
  }
  const parts = [`${msg.done} saved`];
  if (msg.failed > 0) parts.push(`${msg.failed} failed`);
  if (msg.unbookmarked > 0) parts.push(`${msg.unbookmarked} unbookmarked`);
  toast(parts.join(', '), msg.failed > 0 ? 'info' : 'success', 3500);
}

async function clearQueue() {
  if (allQueue.length === 0) return;
  if (!confirm(`Clear all ${allQueue.length} items from the queue?`)) return;

  await sendBg({ type: 'CLEAR_QUEUE' });
  allQueue = [];
  renderList();
  toast('Queue cleared', 'info');
}

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applySettingsToUI();
  await updateStatusBar();
  await loadQueue();
  await restoreRun();

  // Filter tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderList();
    });
  });

  $('btn-download-all').addEventListener('click', downloadAll);
  $('btn-scan').addEventListener('click', rescan);
  $('btn-clear').addEventListener('click', clearQueue);

  // Settings panel toggle
  $('btn-settings').addEventListener('click', () => {
    const panel = $('settings-panel');
    const btn = $('btn-settings');
    const isOpen = panel.classList.toggle('open');
    btn.classList.toggle('active', isOpen);
  });

  // Batch size stepper
  $('batch-dec').addEventListener('click', async () => {
    settings.batchSize = Math.max(BATCH_MIN, settings.batchSize - BATCH_STEP);
    applySettingsToUI();
    await saveSettings();
  });

  $('batch-inc').addEventListener('click', async () => {
    settings.batchSize = Math.min(BATCH_MAX, settings.batchSize + BATCH_STEP);
    applySettingsToUI();
    await saveSettings();
  });

  // Download pace stepper
  $('dlpace-dec').addEventListener('click', async () => {
    settings.downloadDelayMs = Math.max(DL_MIN, settings.downloadDelayMs - DL_STEP);
    applySettingsToUI();
    await saveSettings();
  });

  $('dlpace-inc').addEventListener('click', async () => {
    settings.downloadDelayMs = Math.min(DL_MAX, settings.downloadDelayMs + DL_STEP);
    applySettingsToUI();
    await saveSettings();
  });

  // Unbookmark pace stepper
  $('delay-dec').addEventListener('click', async () => {
    settings.unbookmarkDelayMs = Math.max(DELAY_MIN, settings.unbookmarkDelayMs - DELAY_STEP);
    applySettingsToUI();
    await saveSettings();
  });

  $('delay-inc').addEventListener('click', async () => {
    settings.unbookmarkDelayMs = Math.min(DELAY_MAX, settings.unbookmarkDelayMs + DELAY_STEP);
    applySettingsToUI();
    await saveSettings();
  });

  // Export history as CSV
  $('btn-export').addEventListener('click', async () => {
    const btn = $('btn-export');
    btn.disabled = true;
    btn.textContent = 'Exporting...';
    const result = await sendBg({ type: 'EXPORT_HISTORY' });
    btn.disabled = false;
    btn.textContent = 'Export';
    if (result?.ok) toast(`Exported ${result.count} rows to ${result.filename}`, 'success', 4000);
    else toast(result?.error || 'Export failed', 'error');
  });

  // Unbookmark toggle
  $('toggle-unbookmark').addEventListener('change', async (e) => {
    settings.unbookmarkAfterSave = e.target.checked;
    await saveSettings();
  });

  // Unbookmark all downloaded items
  $('btn-unbookmark-downloaded').addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.url?.includes('x.com') && !tab?.url?.includes('twitter.com')) {
      toast('Go to X.com first — the page is needed to unbookmark', 'error', 3500);
      return;
    }

    const result = await sendBg({ type: 'UNBOOKMARK_DOWNLOADED' });
    if (!result?.statusIds?.length) {
      toast('No downloaded items to unbookmark', 'info');
      return;
    }

    if (!confirm(`Unbookmark ${result.count} tweet${result.count !== 1 ? 's' : ''} from X? This cannot be undone.`)) return;

    const started = await sendBg({
      type: 'START_UNBOOKMARK',
      statusIds: result.statusIds,
      settings
    });

    if (started?.ok) {
      await restoreRun();
      toast(`Unbookmarking ${started.total} — you can close this popup`, 'info', 4000);
    } else {
      toast(started?.error || 'Could not start', 'error', 4000);
    }
  });

  // Clear download history
  $('btn-clear-history').addEventListener('click', async () => {
    if (!confirm('Clear download history? Previously downloaded items can be queued again.')) return;
    await sendBg({ type: 'CLEAR_HISTORY' });
    toast('Download history cleared', 'success');
  });

  // Full reset — clears everything and tells content script to reset too
  $('btn-full-reset').addEventListener('click', async () => {
    if (!confirm('Full reset: clears queue, download history, and detection state. Use this if the extension is skipping bookmarks.')) return;
    const tab = await getActiveTab();
    // Reset background state
    await sendBg({ type: 'FULL_RESET' });
    // Reset content script state (committedKeys, pendingByKey, tweetContext)
    if (tab) await sendContent(tab, { type: 'CLEAR_MEDIA' });
    allQueue = [];
    renderList();
    toast('Full reset done — refresh the bookmarks page and scroll', 'success', 4000);
  });

  $('go-to-bookmarks').addEventListener('click', async (e) => {
    e.preventDefault();
    const tab = await getActiveTab();
    if (tab && (tab.url?.includes('x.com') || tab.url?.includes('twitter.com'))) {
      chrome.tabs.update(tab.id, { url: 'https://x.com/i/bookmarks' });
    } else {
      chrome.tabs.create({ url: 'https://x.com/i/bookmarks' });
    }
    window.close();
  });
});

// The worker drives everything; the popup just reflects it.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RUN_UPDATED') renderRun(msg.run);
  else if (msg.type === 'RUN_DONE') finishRun(msg);
  else if (msg.type === 'QUEUE_UPDATED') loadQueue();
});
