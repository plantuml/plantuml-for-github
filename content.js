// =====================================================================
// PlantUML for GitHub - Content Script
// =====================================================================
// Runs on every github.com page. Detects ```plantuml code blocks and
// replaces them with a sandboxed iframe that renders the diagram
// client-side using the TeaVM-compiled PlantUML engine.
// =====================================================================

(function () {
  'use strict';

  // ====== TRACE ======
  const TRACE = (...args) => console.log('[PUML4GH][content]', ...args);
  TRACE('content script loaded on', location.href);
  // ===================

  // URL of the renderer page (packaged inside the extension).
  // chrome.runtime.getURL() produces a chrome-extension://<id>/renderer.html URL.
  const RENDERER_URL = chrome.runtime.getURL('renderer.html');
  const RENDERER_ORIGIN = new URL(RENDERER_URL).origin;
  TRACE('RENDERER_URL =', RENDERER_URL, '| RENDERER_ORIGIN =', RENDERER_ORIGIN);

  // Marker class so we don't re-process the same block twice.
  const PROCESSED_CLASS = 'plantuml-for-github-processed';

  // ------------------------------------------------------------------
  // Detect dark mode from GitHub's <html data-color-mode> attribute.
  // ------------------------------------------------------------------
  function isDarkMode() {
    const mode = document.documentElement.dataset.colorMode;
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    // 'auto' or unset: fall back to the user's OS preference.
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ------------------------------------------------------------------
  // Find all ```plantuml code blocks on the current page.
  //
  // GitHub renders fenced code blocks as either:
  //   <div class="highlight highlight-source-plantuml">...</div>
  //   <pre lang="plantuml">...</pre>
  // depending on the context (README, issue, PR, discussion).
  // We handle both, plus a generic fallback.
  // ------------------------------------------------------------------
  function findPlantUMLBlocks(root) {
    const blocks = [];

    // GitHub uses Linguist to classify code-block languages. PlantUML is
    // classified under several aliases:
    //   - 'wsd' (Web Sequence Diagrams) -- the canonical Linguist name
    //   - 'plantuml'
    //   - 'puml'
    // The wrapper class is therefore one of:
    //   highlight-source-wsd / highlight-source-plantuml / highlight-source-puml
    const LANG_ALIASES = ['wsd', 'plantuml', 'puml'];
    const wrapperSelector = LANG_ALIASES
      .map((l) => 'div.highlight-source-' + l)
      .join(', ');
    const preLangSelector = LANG_ALIASES
      .map((l) => 'pre[lang="' + l + '"]')
      .join(', ');
    const codeLangSelector = LANG_ALIASES
      .map((l) => 'code.language-' + l)
      .join(', ');

    // README rendering: <div class="highlight highlight-source-wsd"><pre>...</pre></div>
    const sel1 = root.querySelectorAll(wrapperSelector);
    sel1.forEach((el) => {
      if (!el.classList.contains(PROCESSED_CLASS)) blocks.push(el);
    });

    // Issue / PR / discussion comment rendering: <pre lang="wsd">...</pre>
    const sel2 = root.querySelectorAll(preLangSelector);
    sel2.forEach((el) => {
      if (!el.classList.contains(PROCESSED_CLASS)) blocks.push(el);
    });

    // Some markdown renderers wrap code blocks differently.
    // Catch <code class="language-wsd"> that aren't already covered above.
    const sel3 = root.querySelectorAll(codeLangSelector);
    sel3.forEach((codeEl) => {
      const pre = codeEl.closest('pre');
      if (pre && !pre.classList.contains(PROCESSED_CLASS) &&
          !pre.matches(preLangSelector) &&
          !pre.closest(wrapperSelector)) {
        blocks.push(pre);
      }
    });

    TRACE('findPlantUMLBlocks: sel1(' + wrapperSelector + ')=' + sel1.length +
          ' sel2(' + preLangSelector + ')=' + sel2.length +
          ' sel3(' + codeLangSelector + ')=' + sel3.length +
          ' -> total new blocks=' + blocks.length);
    return blocks;
  }

  // ------------------------------------------------------------------
  // Extract the PlantUML source text from a code block element.
  // We use textContent to get the raw text without any syntax-highlight
  // markup that GitHub may have injected.
  // ------------------------------------------------------------------
  function extractSource(blockEl) {
    // For <div class="highlight-source-plantuml"><pre>, get inner <pre> text.
    const pre = blockEl.matches('pre') ? blockEl : blockEl.querySelector('pre');
    if (!pre) return blockEl.textContent.trim();
    return pre.textContent.trim();
  }

  // ------------------------------------------------------------------
  // Build the iframe wrapper that will hold the rendered diagram.
  // We use sandbox="allow-scripts" — no allow-same-origin — so the
  // iframe is treated as a unique opaque origin (defense in depth).
  // ------------------------------------------------------------------
  // Theme palettes — hard-coded so they don't depend on GitHub's CSS
  // variables being defined on the current page.
  const THEME = {
    light: {
      wrapperBg:  '#f6f8fa',
      wrapperFg:  '#656d76',
      borderCol:  '#d0d7de',
      iframeBg:   '#ffffff'
    },
    dark: {
      wrapperBg:  '#161b22',
      wrapperFg:  '#8b949e',
      borderCol:  '#30363d',
      iframeBg:   '#0d1117'
    }
  };

  function buildIframe(requestId, dark) {
    const t = dark ? THEME.dark : THEME.light;

    const wrapper = document.createElement('div');
    wrapper.className = 'plantuml-for-github-wrapper';
    wrapper.style.cssText =
      'margin: 16px 0; padding: 0; ' +
      'border: 1px solid ' + t.borderCol + '; ' +
      'border-radius: 6px; overflow: hidden; background: ' + t.wrapperBg + ';';

    // Header bar: badge on the left, view-toggle button on the right.
    const header = document.createElement('div');
    header.style.cssText =
      'display: flex; align-items: center; justify-content: space-between; ' +
      'padding: 4px 8px; border-bottom: 1px solid ' + t.borderCol + ';';

    const badge = document.createElement('div');
    badge.textContent = '🌱 PlantUML (client-side render)';
    badge.style.cssText =
      'font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
      'color: ' + t.wrapperFg + ';';

    // View-toggle button. Starts in "viewing diagram" mode, so the icon
    // shows the action the user can take next ("view source" = code icon).
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'plantuml-for-github-toggle';
    toggleBtn.setAttribute('aria-label', 'Show source');
    toggleBtn.title = 'Show source';
    toggleBtn.style.cssText =
      'display: inline-flex; align-items: center; justify-content: center; ' +
      'width: 22px; height: 22px; padding: 0; margin: 0 8px 0 0; ' +
      'background: transparent; border: 1px solid transparent; ' +
      'border-radius: 4px; cursor: pointer; ' +
      'color: ' + t.wrapperFg + ';';
    toggleBtn.addEventListener('mouseenter', () => {
      toggleBtn.style.background = t.borderCol;
    });
    toggleBtn.addEventListener('mouseleave', () => {
      toggleBtn.style.background = 'transparent';
    });
    // Two inline SVG icons — Octicons-style, 16x16.
    // <> code icon (shown when diagram is visible: "click to show source")
    // eye icon       (shown when source is visible:   "click to show diagram")
    const ICON_CODE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M4.72 3.22a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06Zm6.56 0a.75.75 0 1 0-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06Z"/>' +
      '</svg>';
    const ICON_EYE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>' +
      '</svg>';
    toggleBtn.innerHTML = ICON_CODE;
    // Toggle on the LEFT, badge on the RIGHT of it.
    header.appendChild(toggleBtn);
    header.appendChild(badge);
    // With both children left-aligned, switch the header from
    // space-between to flex-start so they sit next to each other.
    header.style.justifyContent = 'flex-start';
    wrapper.appendChild(header);

    const iframe = document.createElement('iframe');
    iframe.src = RENDERER_URL;
    iframe.sandbox = 'allow-scripts';
    iframe.dataset.requestId = requestId;
    iframe.style.cssText =
      'border: none; width: 100%; min-height: 60px; display: block; background: transparent;';
    iframe.setAttribute('title', 'PlantUML diagram');

    wrapper.appendChild(iframe);
    return { wrapper, iframe, toggleBtn, icons: { code: ICON_CODE, eye: ICON_EYE } };
  }

  // ------------------------------------------------------------------
  // Process a single block: replace it with an iframe and post the
  // source to the renderer once the iframe is loaded.
  // ------------------------------------------------------------------
  let blockCounter = 0;

  function processBlock(blockEl) {
    blockEl.classList.add(PROCESSED_CLASS);

    const source = extractSource(blockEl);
    TRACE('processBlock: tag=' + blockEl.tagName +
          ' class="' + blockEl.className + '"' +
          ' source.len=' + (source ? source.length : 0) +
          ' source.preview=' + JSON.stringify((source || '').slice(0, 60)));
    if (!source) {
      TRACE('processBlock: empty source, skipping');
      return;
    }

    const requestId = `puml-${++blockCounter}-${Date.now()}`;
    const dark = isDarkMode();
    const { wrapper, iframe, toggleBtn, icons } = buildIframe(requestId, dark);

    // Insert the wrapper *before* the original block, then move the
    // original block INSIDE the wrapper (after the iframe). This keeps
    // GitHub's syntax-highlighting intact and lets us toggle visibility
    // between the rendered diagram and the original source.
    blockEl.parentNode.insertBefore(wrapper, blockEl);
    wrapper.appendChild(blockEl);
    // The original block already has padding/background from GitHub.
    // Strip its outer margin and rounded corners so it sits flush inside
    // our wrapper, and hide it by default (diagram view is the default).
    blockEl.style.margin = '0';
    blockEl.style.borderRadius = '0';
    blockEl.style.border = 'none';
    blockEl.style.display = 'none';
    TRACE('processBlock: iframe inserted, requestId=' + requestId + ' dark=' + dark);

    // Wire the view-toggle: SVG diagram <-> GitHub-coloured source.
    let showingSource = false;
    toggleBtn.addEventListener('click', () => {
      showingSource = !showingSource;
      if (showingSource) {
        iframe.style.display = 'none';
        blockEl.style.display = '';
        toggleBtn.innerHTML = icons.eye;
        toggleBtn.setAttribute('aria-label', 'Show diagram');
        toggleBtn.title = 'Show diagram';
      } else {
        iframe.style.display = '';
        blockEl.style.display = 'none';
        toggleBtn.innerHTML = icons.code;
        toggleBtn.setAttribute('aria-label', 'Show source');
        toggleBtn.title = 'Show source';
      }
      TRACE('toggle clicked, showingSource=' + showingSource);
    });

    iframe.addEventListener('load', () => {
      let targetOrigin = RENDERER_ORIGIN;
      try {
        // When sandbox="allow-scripts" is set WITHOUT allow-same-origin,
        // the iframe's effective origin is the opaque string "null", and
        // postMessage targeted at chrome-extension://... is silently
        // dropped. We detect that case and fall back to '*'.
        // We can't read contentWindow.origin (cross-origin), but we can
        // probe the iframe element's sandbox attribute.
        const sb = iframe.getAttribute('sandbox') || '';
        const opaque = sb.includes('allow-scripts') && !sb.includes('allow-same-origin');
        if (opaque) targetOrigin = '*';
        TRACE('iframe load fired, sandbox="' + sb + '" opaque=' + opaque +
              ' -> targetOrigin=' + targetOrigin + ', posting PLANTUML_RENDER requestId=' + requestId);
      } catch (e) {
        TRACE('targetOrigin probe failed:', e);
      }
      iframe.contentWindow.postMessage({
        type: 'PLANTUML_RENDER',
        source,
        requestId,
        options: { dark }
      }, targetOrigin);
      TRACE('postMessage call returned (no throw) for requestId=' + requestId);
    });
    iframe.addEventListener('error', (e) => {
      TRACE('iframe ERROR event', e);
    });
  }

  // ------------------------------------------------------------------
  // Listen for results coming back from the renderer iframes.
  // ------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    const data = event.data;
    // Trace every message of interest (filter out noise)
    if (data && typeof data === 'object' &&
        (data.type === 'PLANTUML_RESULT' || data.type === 'PLANTUML_ERROR')) {
      TRACE('message received from origin=' + event.origin + ' type=' + data.type +
            ' requestId=' + data.requestId +
            (data.type === 'PLANTUML_ERROR' ? ' error=' + data.error : ' height=' + data.height));
    }

    // Only accept messages from our own renderer origin.
    if (event.origin !== RENDERER_ORIGIN && event.origin !== 'null') return;

    if (!data || typeof data !== 'object') return;
    if (data.type !== 'PLANTUML_RESULT' && data.type !== 'PLANTUML_ERROR') return;

    const iframe = document.querySelector(
      `iframe[data-request-id="${CSS.escape(data.requestId)}"]`
    );
    if (!iframe) {
      TRACE('no iframe found for requestId=' + data.requestId);
      return;
    }

    if (data.type === 'PLANTUML_RESULT' && typeof data.height === 'number') {
      // Add a small buffer to avoid scrollbars on rounding errors.
      iframe.style.height = (data.height + 8) + 'px';
      TRACE('iframe height set to ' + (data.height + 8) + 'px');
    }
    // For PLANTUML_ERROR we leave the iframe as-is; the renderer page
    // already displays the error inline.
  });

  // ------------------------------------------------------------------
  // Initial scan + observe DOM mutations.
  //
  // GitHub is a SPA: it navigates between pages and injects new content
  // (e.g. loading more comments) without a full page reload. A
  // MutationObserver lets us catch blocks added after initial load.
  // ------------------------------------------------------------------
  function scanAndProcess(root) {
    const blocks = findPlantUMLBlocks(root);
    blocks.forEach(processBlock);
  }

  // Initial scan.
  TRACE('starting initial scan');
  scanAndProcess(document.body);
  TRACE('initial scan done');

  // ====== DIAGNOSTIC: dump every <pre> / <code> that could be a plantuml block ======
  setTimeout(() => {
    TRACE('=== DIAGNOSTIC DUMP ===');
    const allPre = document.querySelectorAll('pre');
    TRACE('total <pre> elements on page: ' + allPre.length);
    allPre.forEach((pre, i) => {
      const text = pre.textContent || '';
      const looksPuml = text.includes('@startuml') || text.includes('@enduml');
      if (looksPuml) {
        TRACE('  <pre> #' + i + ' LOOKS LIKE PLANTUML:');
        TRACE('    tag=' + pre.tagName +
              ' class="' + pre.className + '"' +
              ' lang="' + (pre.getAttribute('lang') || '') + '"' +
              ' data-lang="' + (pre.getAttribute('data-lang') || '') + '"');
        TRACE('    parent tag=' + (pre.parentElement && pre.parentElement.tagName) +
              ' parent.class="' + (pre.parentElement && pre.parentElement.className) + '"');
        const code = pre.querySelector('code');
        if (code) {
          TRACE('    inner <code> class="' + code.className + '"');
        }
        TRACE('    outerHTML (first 300 chars): ' + pre.outerHTML.slice(0, 300));
      }
    });
    // Also dump every element with a class containing "plantuml" or "puml"
    const fuzzy = document.querySelectorAll('[class*="plantuml"], [class*="puml"], [lang*="plantuml"]');
    TRACE('elements with class/lang matching plantuml|puml: ' + fuzzy.length);
    fuzzy.forEach((el, i) => {
      TRACE('  fuzzy #' + i + ' tag=' + el.tagName + ' class="' + el.className + '" lang="' + (el.getAttribute('lang') || '') + '"');
    });
    TRACE('=== END DIAGNOSTIC ===');
  }, 1500);
  // ===================================================================================

  // Watch for dynamically added content.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scanAndProcess(node);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  TRACE('MutationObserver attached');
})();
