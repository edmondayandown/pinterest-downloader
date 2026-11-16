/**
 * Pinterest Media Downloader — popup script
 *
 * Owns the popup UI state and bridges the user's choices to the content
 * script (scanning + scrolling) and the background service worker (downloads).
 */

const $ = (id) => document.getElementById(id);

let currentMedia = []; // [{url, type}]
let isScrolling = false;
let pageInfo = null;
let pollTimer = null;
let currentTabId = null;

// ---- init ------------------------------------------------------------------

async function init() {
  // Restore last-used media-type preferences.
  const settings = await chrome.storage.local.get(['types']);
  const t = settings.types || {};
  if (t.video !== undefined) $('type-video').checked = t.video;
  if (t.gif !== undefined) $('type-gif').checked = t.gif;
  if (t.image !== undefined) $('type-image').checked = t.image;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;

  if (!tab || !tab.url || !/pinterest\./.test(tab.url)) {
    setStatus('Open pinterest.com first', 'err');
    disableAll();
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    if (!response) {
      setStatus('Refresh the Pinterest tab', 'warn');
      disableAll();
      return;
    }
    currentMedia = response.media || [];
    isScrolling = response.scrolling || false;
    pageInfo = response.pageInfo || {};

    if (pageInfo.isPinDetail) {
      setStatus('Pin detail · related included', 'ok');
    } else if (pageInfo.isSearch) {
      setStatus('Search results', 'ok');
    } else {
      setStatus('Pinterest page', 'ok');
    }

    // Pre-fill filename from search query / pin title if user hasn't typed one.
    if (pageInfo.searchQuery && !$('basename').value) {
      $('basename').value = pageInfo.searchQuery;
    }

    if (isScrolling) startPolling(tab.id);
  } catch (e) {
    setStatus('Refresh the Pinterest tab', 'warn');
    disableAll();
    return;
  }

  updateUI();
}

function setStatus(text, level) {
  $('pageStatus').textContent = text;
  const dot = $('statusDot');
  dot.classList.remove('ok', 'warn', 'err');
  if (level) dot.classList.add(level);
}

function disableAll() {
  ['basename', 'scrollBtn', 'downloadBtn', 'clearBtn', 'type-video', 'type-gif', 'type-image'].forEach(
    (id) => ($(id).disabled = true)
  );
}

// ---- UI sync ---------------------------------------------------------------

function updateUI() {
  // Counts
  const counts = { video: 0, gif: 0, image: 0 };
  currentMedia.forEach((m) => {
    if (counts[m.type] !== undefined) counts[m.type]++;
  });
  $('foundCount').textContent = currentMedia.length;
  $('videoCount').textContent = counts.video;
  $('gifCount').textContent = counts.gif;
  $('imageCount').textContent = counts.image;

  // Scroll button state
  $('scrollBtn').textContent = isScrolling ? 'Stop scroll' : 'Start scroll';
  $('scrollBtn').classList.toggle('active', isScrolling);
  $('scrollSub').textContent = isScrolling ? 'Scrolling…' : 'Idle';

  // Download button — enabled if at least one selected type has matches
  const types = getSelectedTypes();
  const anyMatch = currentMedia.some((m) => types[m.type]);
  $('downloadBtn').disabled = !anyMatch;

  updatePreview();
}

function updatePreview() {
  const name = $('basename').value.trim() || 'name';
  $('preview0').textContent = name;
  $('preview1').textContent = name + '1';
  $('preview2').textContent = name + '2';
}

function getSelectedTypes() {
  return {
    video: $('type-video').checked,
    gif: $('type-gif').checked,
    image: $('type-image').checked,
  };
}

function filteredMedia() {
  const types = getSelectedTypes();
  return currentMedia.filter((m) => types[m.type]);
}

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
}

// ---- events ----------------------------------------------------------------

$('basename').addEventListener('input', updatePreview);

['type-video', 'type-gif', 'type-image'].forEach((id) => {
  $(id).addEventListener('change', async () => {
    await chrome.storage.local.set({ types: getSelectedTypes() });
    updateUI();
  });
});

$('scrollBtn').addEventListener('click', async () => {
  if (!currentTabId) return;
  try {
    if (isScrolling) {
      await chrome.tabs.sendMessage(currentTabId, { type: 'STOP_SCROLL' });
      isScrolling = false;
      stopPolling();
    } else {
      await chrome.tabs.sendMessage(currentTabId, { type: 'START_SCROLL' });
      isScrolling = true;
      startPolling(currentTabId);
    }
    updateUI();
  } catch (e) {
    showToast('Tab not responding — refresh Pinterest');
  }
});

$('downloadBtn').addEventListener('click', async () => {
  const basename = $('basename').value.trim();
  if (!basename) {
    showToast('Enter a file name first');
    $('basename').focus();
    return;
  }

  const items = filteredMedia();
  if (items.length === 0) {
    showToast('No matching media to download');
    return;
  }

  $('downloadBtn').disabled = true;
  $('downloadBtn').textContent = 'Downloading…';

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA',
      items,
      basename,
    });
    if (resp && resp.ok) {
      showToast(`Started ${resp.count} of ${items.length} downloads`);
    } else {
      showToast('Download failed — try again');
    }
  } catch (e) {
    showToast('Download error — see console');
  }

  $('downloadBtn').textContent = 'Download all';
  $('downloadBtn').disabled = false;
  updateUI();
});

$('clearBtn').addEventListener('click', async () => {
  if (!currentTabId) return;
  try {
    await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR' });
    currentMedia = [];
    updateUI();
    showToast('Cleared');
  } catch (e) {
    /* ignore */
  }
});

// ---- polling the content script while scrolling ----------------------------

function startPolling(tabId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' });
      if (!resp) return;
      currentMedia = resp.media || [];
      const wasScrolling = isScrolling;
      isScrolling = resp.scrolling || false;
      updateUI();
      if (wasScrolling && !isScrolling) {
        stopPolling();
        showToast(`Scroll finished · ${currentMedia.length} items found`);
      }
    } catch (e) {
      /* tab might be navigating — ignore */
    }
  }, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- messages from background / content ------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DOWNLOAD_COMPLETE') {
    showToast(`Downloaded ${message.count} files`);
  } else if (message.type === 'SCROLL_PROGRESS') {
    // Lightweight live update without a full GET_STATE round-trip.
    $('foundCount').textContent = message.count;
  }
});

// Kick things off.
init();
