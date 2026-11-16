/**
 * Pinterest Media Downloader — background service worker (Manifest V3)
 *
 * Responsibilities:
 *  - Receive DOWNLOAD_MEDIA messages from the popup.
 *  - Sanitise the chosen basename into a filesystem-safe slug.
 *  - Name files according to the spec:
 *        first file  ->  <basename><ext>
 *        subsequent  ->  <basename>1<ext>, <basename>2<ext>, ...
 *    A single shared counter is used across all media types, but the file
 *    extension always reflects the real file type (.mp4 / .gif / .jpg / ...).
 *  - Hand each URL to chrome.downloads with conflictAction:'uniquify' so any
 *    name collision is resolved by Chrome instead of failing.
 *  - Notify the popup when the batch finishes.
 */

// ---- message router --------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_MEDIA') {
    downloadMedia(message.items || [], message.basename || 'pinterest')
      .then((count) => {
        // Best-effort notify — popup may already be closed.
        try {
          chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE', count });
        } catch (e) {
          /* ignore */
        }
        sendResponse({ ok: true, count });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });
    return true; // async
  }
  return false;
});

// ---- core ------------------------------------------------------------------

async function downloadMedia(items, basename) {
  const safe = sanitiseBasename(basename);
  let counter = 0;
  let success = 0;

  for (const item of items) {
    const ext = extensionFor(item.url, item.type);
    const filename =
      counter === 0 ? `${safe}${ext}` : `${safe}${counter}${ext}`;
    counter++;

    try {
      await chrome.downloads.download({
        url: item.url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      success++;
      // Small throttle so Chrome's download manager doesn't drop requests.
      await sleep(300);
    } catch (err) {
      console.warn('[Pinterest Downloader] failed:', item.url, err);
    }
  }

  return success;
}

// ---- helpers ---------------------------------------------------------------

function sanitiseBasename(name) {
  const cleaned = (name || '')
    .replace(/[^\w-]/g, '_') // letters, digits, underscore, hyphen only
    .replace(/_+/g, '_') // collapse runs of underscore
    .replace(/^_|_$/g, ''); // trim leading/trailing underscore
  return cleaned || 'pinterest';
}

function extensionFor(url, type) {
  // Try to read a real extension off the URL first (strip query string).
  const cleanUrl = (url || '').split('?')[0].split('#')[0];
  const m = cleanUrl.match(/\.(\w{2,4})$/);
  if (m) {
    const ext = m[1].toLowerCase();
    if (['mp4', 'm4v', 'webm', 'mov', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) {
      return '.' + ext;
    }
  }
  // Fall back to the detected type.
  if (type === 'video') return '.mp4';
  if (type === 'gif') return '.gif';
  if (type === 'image') return '.jpg';
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
