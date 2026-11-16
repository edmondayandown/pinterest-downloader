/**
 * Pinterest Media Downloader — content script
 *
 * Responsibilities:
 *  - Scan the Pinterest DOM for videos, GIFs and images using MULTIPLE strategies:
 *      1. <video src> and <video><source>
 *      2. data-* attributes that Pinterest hides video URLs in (data-video,
 *         data-src, data-video-url, data-content-url, data-original-src …)
 *      3. Inline-style background images on any element
 *      4. <img> srcset (Pinterest serves the same video as a poster image too)
 *      5. <a href> links that point directly at pinimg.com
 *      6. Open-graph / Twitter video meta tags (pin detail pages)
 *      7. **JSON blobs embedded in <script> tags** — this is where the real
 *         .mp4 URLs live for video pins in search results. Pinterest hydrates
 *         the page with a big JSON tree (Preload + __PINITIAL__ state) and
 *         video pin entries contain fields like video_list_v2 / video_list /
 *         url / image_video_url with the actual MP4.
 *  - Upgrade Pinterest image URLs from /236x/ → /originals/ for full quality.
 *  - Auto-scroll the page so lazy-loaded pins get rendered and picked up.
 *  - While scrolling, dispatch mouseenter/mousemove events over pin cards to
 *    force Pinterest to hydrate lazy <video> elements (hover-to-play).
 *  - Detect page type (search / pin detail / board) and pre-fill a filename.
 *
 * Messages handled:
 *   { type: 'GET_STATE' }   -> { media, scrolling, pageInfo }
 *   { type: 'SCAN' }        -> { media, pageInfo }     (one-shot deep scan)
 *   { type: 'START_SCROLL'} -> { ok }
 *   { type: 'STOP_SCROLL' } -> { ok, count }
 *   { type: 'CLEAR' }       -> { ok }
 */

(function () {
  'use strict';

  // ---- state ----------------------------------------------------------------

  /** @type {Map<string, {url:string, type:string}>} url -> item */
  const collectedMedia = new Map();

  let scrolling = false;
  let scrollTimer = null;
  let lastScrollHeight = 0;
  let stableCount = 0;
  let hoverIndex = 0;

  // ---- helpers --------------------------------------------------------------

  function detectMediaType(url) {
    const lower = (url || '').toLowerCase();
    if (
      lower.includes('/videos/') ||
      lower.endsWith('.mp4') ||
      lower.endsWith('.m4v') ||
      lower.endsWith('.webm') ||
      lower.endsWith('.mov') ||
      lower.includes('/video/') ||
      lower.includes('video_list')
    ) {
      return 'video';
    }
    if (lower.endsWith('.gif') || lower.includes('/gifs/')) {
      return 'gif';
    }
    return 'image';
  }

  function upgradeImageUrl(url) {
    if (!url) return url;
    return url.replace(/\/(236x|474x|564x|736x|991x|1024x)\//, '/originals/');
  }

  function safeUrl(u) {
    return (
      u &&
      typeof u === 'string' &&
      !u.startsWith('blob:') &&
      !u.startsWith('data:') &&
      !u.startsWith('about:')
    );
  }

  function isPinterestMedia(url) {
    const lower = (url || '').toLowerCase();
    return (
      lower.includes('pinimg.com') ||
      lower.includes('pinterest.') ||
      // Sometimes videos are served from pinterest's own CDN
      lower.includes('v.pinimg.com')
    );
  }

  // ---- scanning -------------------------------------------------------------

  function scanForMedia() {
    /** @type {Set<string>} */
    const seenThisPass = new Set();

    /**
     * @param {string} url
     * @param {string} type
     */
    function add(url, type) {
      if (!safeUrl(url)) return;
      if (seenThisPass.has(url)) return;
      if (!isPinterestMedia(url)) return;
      seenThisPass.add(url);
      if (!collectedMedia.has(url)) {
        collectedMedia.set(url, { url, type });
      }
    }

    // 1. <video> elements and their <source> children
    document.querySelectorAll('video').forEach((video) => {
      const candidates = [
        video.src,
        video.currentSrc,
        video.getAttribute('data-src'),
        video.getAttribute('data-video'),
        video.getAttribute('data-video-url'),
        video.getAttribute('data-hls-url'),
      ];
      candidates.forEach((src) => add(src, 'video'));
      video.querySelectorAll('source').forEach((s) => {
        add(s.src, 'video');
        add(s.getAttribute('data-src'), 'video');
      });
      // Poster image — keep as image too so the user can grab a still.
      if (video.poster) add(upgradeImageUrl(video.poster), 'image');
    });

    // 2. <img> elements pointing at pinimg.com
    document.querySelectorAll('img').forEach((img) => {
      const src = img.src || img.currentSrc;
      if (src && !src.startsWith('data:')) {
        const type = detectMediaType(src);
        add(upgradeImageUrl(src), type);
      }
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc) {
        const type = detectMediaType(dataSrc);
        add(upgradeImageUrl(dataSrc), type);
      }
    });

    // 3. srcset on <img> elements
    document.querySelectorAll('img[srcset]').forEach((img) => {
      const srcset = img.getAttribute('srcset') || '';
      srcset.split(',').forEach((part) => {
        const u = part.trim().split(/\s+/)[0];
        if (u && u.includes('pinimg.com')) {
          add(upgradeImageUrl(u), detectMediaType(u));
        }
      });
    });

    // 4. Inline-style background images on any element
    document.querySelectorAll('[style*="pinimg.com"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const re = /url\(["']?(https:\/\/[^"')]*pinimg\.com[^"')]*?)["']?\)/g;
      let m;
      while ((m = re.exec(style)) !== null) {
        add(upgradeImageUrl(m[1]), detectMediaType(m[1]));
      }
    });

    // 5. Open-Graph / Twitter video meta tags (pin detail pages)
    document
      .querySelectorAll(
        'meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[name="twitter:player:stream"]'
      )
      .forEach((meta) => {
        if (meta.content) add(meta.content, 'video');
      });

    // 6. <a href> links that point directly at pinimg.com
    document.querySelectorAll('a[href*="pinimg.com"]').forEach((a) => {
      add(a.href, detectMediaType(a.href));
    });

    // 7. **JSON inside <script> tags** — the big win for search results.
    //    Pinterest embeds pin data as JSON-LD / __PINITIAL__ state / <script id="initial-state">.
    //    We pull every string out of the JSON that looks like a pinimg URL.
    scanScriptJsons(add);

    // 8. data-* attributes on any element that look like video URLs.
    //    Pinterest sometimes stores the real URL on a wrapper div.
    document.querySelectorAll('[data-video], [data-video-url], [data-content-url]').forEach((el) => {
      ['data-video', 'data-video-url', 'data-content-url', 'data-src'].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (v) add(v, detectMediaType(v));
      });
    });

    return Array.from(collectedMedia.values());
  }

  /**
   * Walk every <script> tag in the page, look for JSON-shaped content, and
   * extract any string that contains a pinimg.com URL. This catches both
   * explicit JSON.parse-able blobs and the inline `window.__PINITIAL__ = {...}`
   * style assignments Pinterest uses.
   *
   * @param {(url: string, type: string) => void} add
   */
  function scanScriptJsons(add) {
    const scripts = document.querySelectorAll('script');
    scripts.forEach((script) => {
      const text = script.textContent || '';
      if (!text) return;

      // Fast pre-filter: only bother if this script mentions pinimg.
      if (!text.includes('pinimg.com')) return;

      // Strategy A: pull out every https URL string with a regex. This works
      // even if the JSON is malformed or partially embedded.
      const urlRe = /https:\/\/[^\s"'\\]{0,300}/g;
      let m;
      while ((m = urlRe.exec(text)) !== null) {
        const u = m[0].replace(/[,.}]$/, '');
        if (u.includes('pinimg.com')) {
          add(u, detectMediaType(u));
        }
      }
    });
  }

  // ---- hover-trigger: force lazy video hydration ----------------------------

  /**
   * Dispatch synthetic mouseenter / mousemove events on pin cards so
   * Pinterest hydrates the hover-to-play <video> and sets its src. Without
   * this, lazy videos stay as <div class="...video-thumbnail"> with no src.
   */
  function triggerLazyVideos() {
    const cards = document.querySelectorAll(
      '[data-test-id="pin"], [data-test-id="pinrep-pin"], div[role="button"], a[href*="/pin/"]'
    );
    if (!cards.length) return;

    // Hover ~8 cards per tick, advancing each pass so we cover the whole grid.
    const window = 8;
    const start = hoverIndex % cards.length;
    for (let i = 0; i < window; i++) {
      const card = cards[(start + i) % cards.length];
      try {
        const rect = card.getBoundingClientRect();
        if (rect.top > 0 && rect.top < window.innerHeight) {
          const opts = {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          };
          card.dispatchEvent(new MouseEvent('mouseenter', opts));
          card.dispatchEvent(new MouseEvent('mouseover', opts));
          card.dispatchEvent(new MouseEvent('mousemove', opts));
        }
      } catch (e) {
        /* ignore */
      }
    }
    hoverIndex += window;
  }

  // ---- auto-scroll ----------------------------------------------------------

  function startAutoScroll() {
    if (scrolling) return;
    scrolling = true;
    lastScrollHeight = 0;
    stableCount = 0;
    hoverIndex = 0;

    scrollTimer = setInterval(() => {
      if (!scrolling) return;

      // Step scroll.
      window.scrollBy({
        top: Math.floor(window.innerHeight * 0.8),
        behavior: 'auto',
      });

      // Force lazy video elements to hydrate before we scan.
      triggerLazyVideos();

      // Wait a tick for any lazy srcs to populate, then scan.
      setTimeout(scanForMedia, 250);

      // Idle detection — stop after 5 ticks with no height growth.
      const currentHeight = document.body.scrollHeight;
      if (currentHeight === lastScrollHeight) {
        stableCount++;
        if (stableCount >= 5) {
          stopAutoScroll();
        }
      } else {
        stableCount = 0;
        lastScrollHeight = currentHeight;
      }

      // Best-effort ping to popup — ignored if popup is closed.
      try {
        chrome.runtime.sendMessage({
          type: 'SCROLL_PROGRESS',
          count: collectedMedia.size,
        });
      } catch (e) {
        /* popup closed — ignore */
      }
    }, 1100);
  }

  function stopAutoScroll() {
    scrolling = false;
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
  }

  // ---- page info ------------------------------------------------------------

  function getPageInfo() {
    const url = window.location.href;
    const isPinDetail = /\/pin\/\d+/.test(url);
    const isSearch = /\/search\//.test(url) || /[?&]q=/.test(url);

    let searchQuery = '';

    const qMatch = url.match(/[?&]q=([^&]+)/);
    if (qMatch) {
      searchQuery = decodeURIComponent(qMatch[1]);
    } else if (isPinDetail) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.content) {
        searchQuery = og.content;
      } else {
        const h =
          document.querySelector('h1') ||
          document.querySelector('[data-test-id="pinTitle"]') ||
          document.querySelector('h2');
        if (h) searchQuery = h.textContent.trim();
      }
    } else {
      const h = document.querySelector('h1');
      if (h) searchQuery = h.textContent.trim();
    }

    searchQuery = (searchQuery || '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 50);

    return { isPinDetail, isSearch, searchQuery, url };
  }

  // ---- message router -------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message.type === 'GET_STATE') {
        sendResponse({
          media: Array.from(collectedMedia.values()),
          scrolling,
          pageInfo: getPageInfo(),
        });
      } else if (message.type === 'SCAN') {
        scanForMedia();
        sendResponse({
          media: Array.from(collectedMedia.values()),
          pageInfo: getPageInfo(),
        });
      } else if (message.type === 'START_SCROLL') {
        startAutoScroll();
        sendResponse({ ok: true });
      } else if (message.type === 'STOP_SCROLL') {
        stopAutoScroll();
        sendResponse({ ok: true, count: collectedMedia.size });
      } else if (message.type === 'CLEAR') {
        collectedMedia.clear();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown_message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true; // keep channel open for async sendResponse
  });

  // Initial scan on load.
  scanForMedia();

  // Also re-scan shortly after load — Pinterest hydrates asynchronously.
  setTimeout(scanForMedia, 1500);
  setTimeout(scanForMedia, 4000);
})();
