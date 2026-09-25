// =====================================================================
// PlantUML for GitHub - Content Script
// =====================================================================
// Runs on every github.com and *.ghe.com (GitHub Enterprise Cloud) page. Detects ```plantuml code blocks and
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
  // Pull out just the `@startXXX ... @endXXX` substring from a block of
  // text, based solely on PlantUML's own delimiters (@startuml,
  // @startmindmap, @startgantt, @startsalt, ...), or null if none is
  // found. Used as a fallback for code blocks GitHub renders with no
  // language marker at all -- see the sel4 comment below for why that
  // happens.
  //
  // This does NOT require @startXXX to be the first line: the untagged
  // <pre> can (and typically does) contain surrounding noise -- e.g. the
  // AsciiDoc `[plantuml]` / `----` fence lines themselves, when someone
  // pastes the whole AsciiDoc snippet (attribute list and delimiters
  // included) into a plain, languageless code block rather than an
  // actual rendered .adoc file. We deliberately extract and render only
  // the matched substring, ignoring anything before or after it, the
  // same way the PlantUML CLI/website already treats @startuml/@enduml
  // as markers inside an otherwise-arbitrary text file.
  //
  // Known limitation: only the FIRST @startXXX/@endXXX pair is extracted.
  // A block with several diagrams packed into one untagged <pre> (text
  // between two @startuml/@enduml pairs) only renders the first one; the
  // rest is silently ignored. This is an intentional scope decision, not
  // an oversight -- the idiomatic AsciiDoc way to have several diagrams
  // is one `[plantuml]` / `----` block per diagram, which already works
  // correctly since each becomes its own separate <pre>. See the sel4
  // TRACE below for a debug hint when this limitation is hit.
  // ------------------------------------------------------------------
  function extractPlantUMLSource(text) {
    const t = text || '';
    const startMatch = t.match(/^[ \t]*@start(\w+)\b.*$/m);
    if (!startMatch) return null;
    const tag = startMatch[1];
    const startIdx = startMatch.index;
    const endMatch = t.slice(startIdx).match(new RegExp('^[ \\t]*@end' + tag + '\\b.*$', 'm'));
    if (!endMatch) return null;
    const endIdx = startIdx + endMatch.index + endMatch[0].length;
    return t.slice(startIdx, endIdx).trim();
  }

  // Extracted `@startXXX ... @endXXX` source for blocks discovered by the
  // content-sniffing fallback (sel4), keyed by the <pre> element itself --
  // populated in findPlantUMLBlocks, consumed by extractSource so we
  // render only the real PlantUML source and not the surrounding noise.
  const sniffedSource = new WeakMap();

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

    // AsciiDoc fallback: `[plantuml]` delimited blocks (the syntax used by
    // the asciidoctor-diagram Ruby gem, e.g. in a README.adoc) --
    //   [plantuml]
    //   ----
    //   @startuml
    //   ...
    //   @enduml
    //   ----
    // GitHub renders .adoc files with plain Asciidoctor and does *not*
    // load the asciidoctor-diagram extension, so the `[plantuml]` style
    // is silently dropped and the block comes out as a completely bare,
    // languageless
    //   <div class="listingblock"><div class="content"><pre>...</pre></div></div>
    // -- no class, no `lang`, no `data-lang`, nothing to select on
    // (verified empirically with @asciidoctor/core, the same engine
    // GitHub's Ruby `asciidoctor` gem is transpiled from). The only way
    // to recognize it is to look at the text itself: PlantUML sources
    // are self-delimited by `@startXXX` / `@endXXX` markers, so any
    // untagged <pre> whose content matches that pattern is treated as
    // PlantUML. This also means a languageless Markdown ``` fence (no
    // `plantuml` after the backticks) works the same way, which is a
    // reasonable bonus rather than a problem.
    //
    // Writing `[source,plantuml]` instead of `[plantuml]` already works
    // without this fallback: Asciidoctor's "source" style keeps the
    // language as `<code class="language-plantuml">`, which sel3 above
    // already matches.
    const anyLangCodeSelector = 'code[class*="language-"]';
    const sel4 = [];
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.classList.contains(PROCESSED_CLASS)) return;
      if (pre.matches(preLangSelector)) return;
      if (pre.closest(wrapperSelector)) return;
      if (pre.querySelector(anyLangCodeSelector)) return; // already labeled with some language
      const extracted = extractPlantUMLSource(pre.textContent);
      if (extracted === null) return;
      // Debug hint for the known "only the first pair" limitation (see the
      // extractPlantUMLSource comment above): a second @startXXX marker
      // anywhere in the block means part of it is being silently dropped.
      if ((pre.textContent.match(/^[ \t]*@start\w+\b/gm) || []).length > 1) {
        TRACE('sel4: multiple @startXXX markers found in one untagged block; ' +
              'only the first @start.../@end... pair is rendered', pre);
      }
      sniffedSource.set(pre, extracted);
      sel4.push(pre);
      blocks.push(pre);
    });

    TRACE('findPlantUMLBlocks: sel1(' + wrapperSelector + ')=' + sel1.length +
          ' sel2(' + preLangSelector + ')=' + sel2.length +
          ' sel3(' + codeLangSelector + ')=' + sel3.length +
          ' sel4(untagged @startXXX/@endXXX)=' + sel4.length +
          ' -> total new blocks=' + blocks.length);
    return blocks;
  }

  // ------------------------------------------------------------------
  // Extract the PlantUML source text from a code block element.
  // We use textContent to get the raw text without any syntax-highlight
  // markup that GitHub may have injected.
  // ------------------------------------------------------------------
  function extractSource(blockEl) {
    // Blocks found by the content-sniffing fallback (sel4) may have extra
    // noise around the actual PlantUML source (see extractPlantUMLSource);
    // use the pre-extracted substring for those instead of the raw text.
    if (sniffedSource.has(blockEl)) return sniffedSource.get(blockEl);
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
    // Picture / image icon — used by the "copy as bitmap" button.
    // 24x24 viewBox matching the source patch's icon style, rendered
    // at 14x14 to fit the existing 22x22 header-button slot.
    const ICON_IMAGE =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<circle cx="8.5" cy="8.5" r="1.5"/>' +
      '<polyline points="21,15 16,10 5,21"/>' +
      '</svg>';
    // Pencil icon -- used by the "Edit as draft" button.
    // Octicons-style pencil rendered at 14x14 to match the other header buttons.
    const ICON_PENCIL =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/>' +
      '</svg>';
    toggleBtn.innerHTML = ICON_CODE;

    // Second header button: copy the rendered diagram to the clipboard
    // as a PNG bitmap. The actual SVG-to-PNG conversion happens inside
    // the iframe (it owns the SVG); we just kick it off and write the
    // resulting blob to the clipboard from this content-script context.
    const bitmapBtn = document.createElement('button');
    bitmapBtn.type = 'button';
    bitmapBtn.className = 'plantuml-for-github-copy-bitmap';
    bitmapBtn.setAttribute('aria-label', 'Copy diagram as bitmap');
    bitmapBtn.title = 'Copy diagram as bitmap';
    bitmapBtn.style.cssText =
      'display: inline-flex; align-items: center; justify-content: center; ' +
      'width: 22px; height: 22px; padding: 0; margin: 0 4px 0 0; ' +
      'background: transparent; border: 1px solid transparent; ' +
      'border-radius: 4px; cursor: pointer; ' +
      'color: ' + t.wrapperFg + ';';
    bitmapBtn.addEventListener('mouseenter', () => {
      bitmapBtn.style.background = t.borderCol;
    });
    bitmapBtn.addEventListener('mouseleave', () => {
      bitmapBtn.style.background = 'transparent';
    });
    bitmapBtn.innerHTML = ICON_IMAGE;

    // Third header button: open the diagram source in a large modal
    // iframe for editing as a draft. For now this just shows a stub
    // modal; the actual editor will be wired up later.
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'plantuml-for-github-edit-draft';
    editBtn.setAttribute('aria-label', 'Edit as draft');
    editBtn.title = 'Edit as draft';
    editBtn.style.cssText =
      'display: inline-flex; align-items: center; justify-content: center; ' +
      'width: 22px; height: 22px; padding: 0; margin: 0 4px 0 0; ' +
      'background: transparent; border: 1px solid transparent; ' +
      'border-radius: 4px; cursor: pointer; ' +
      'color: ' + t.wrapperFg + ';';
    editBtn.addEventListener('mouseenter', () => {
      editBtn.style.background = t.borderCol;
    });
    editBtn.addEventListener('mouseleave', () => {
      editBtn.style.background = 'transparent';
    });
    editBtn.innerHTML = ICON_PENCIL;

    // Toggle on the LEFT, then bitmap-copy, then edit-as-draft, then badge on the RIGHT.
    header.appendChild(toggleBtn);
    header.appendChild(bitmapBtn);
    header.appendChild(editBtn);
    header.appendChild(badge);
    // With both children left-aligned, switch the header from
    // space-between to flex-start so they sit next to each other.
    header.style.justifyContent = 'flex-start';
    wrapper.appendChild(header);

    const iframe = document.createElement('iframe');
    iframe.src = RENDERER_URL;
    // No sandbox attribute: Firefox treats sandboxed iframes loading
    // moz-extension:// pages with a nullprincipal origin, which prevents
    // ES module loading. The iframe is already isolated from github.com
    // because it lives on a different origin (moz-extension:// or
    // chrome-extension://).
    iframe.dataset.requestId = requestId;
    iframe.style.cssText =
      'border: none; width: 100%; min-height: 60px; display: block; background: transparent;';
    iframe.setAttribute('title', 'PlantUML diagram');

    wrapper.appendChild(iframe);
    return { wrapper, iframe, toggleBtn, bitmapBtn, editBtn, theme: t, icons: { code: ICON_CODE, eye: ICON_EYE, image: ICON_IMAGE, pencil: ICON_PENCIL } };
  }

  // ------------------------------------------------------------------
  // Process a single block: replace it with an iframe and post the
  // source to the renderer once the iframe is loaded.
  // ------------------------------------------------------------------
  let blockCounter = 0;

  // ------------------------------------------------------------------
  // Pending bitmap-copy requests, keyed by requestId. The clipboard API
  // requires write() to be called synchronously in a user-gesture handler
  // to preserve transient activation, but the PNG blob comes back later
  // from the iframe. We bridge that gap by passing a Promise<Blob> to
  // ClipboardItem (Chrome supports that) and resolving the Promise here
  // when the iframe responds.
  // ------------------------------------------------------------------
  const pendingBitmapRequests = new Map();
  let bitmapCounter = 0;

  // ------------------------------------------------------------------
  // Pending SVG-copy requests, keyed by requestId. Same mechanism as
  // pendingBitmapRequests but for "Copy as SVG" (text/plain payload).
  // ------------------------------------------------------------------
  const pendingSvgRequests = new Map();
  let svgCounter = 0;

  // ------------------------------------------------------------------
  // Resolve the right postMessage targetOrigin for a renderer iframe.
  // Same probe used everywhere: sandbox="allow-scripts" without
  // allow-same-origin gives the iframe an opaque "null" origin, and
  // chrome-extension://... messages get dropped unless we use '*'.
  // ------------------------------------------------------------------
  function targetOriginFor(iframe) {
    try {
      const sb = iframe.getAttribute('sandbox') || '';
      const opaque = sb.includes('allow-scripts') && !sb.includes('allow-same-origin');
      if (opaque) return '*';
    } catch (e) { /* ignore */ }
    return RENDERER_ORIGIN;
  }

  // ------------------------------------------------------------------
  // "Copy as SVG" -- request the SVG string from the given iframe and
  // write it to the clipboard as text/plain. Silent on success/failure;
  // errors are only logged. Used by the renderer's context menu.
  // ------------------------------------------------------------------
  async function copySvgFromIframe(iframe) {
    const svgReqId = `svg-${++svgCounter}-${Date.now()}`;
    TRACE('copySvgFromIframe, requestId=' + svgReqId);

    // Promise resolved/rejected when the iframe responds.
    let resolveBlob, rejectBlob;
    const blobPromise = new Promise((resolve, reject) => {
      resolveBlob = resolve;
      rejectBlob  = reject;
    });
    const timeoutId = setTimeout(() => {
      if (pendingSvgRequests.has(svgReqId)) {
        pendingSvgRequests.delete(svgReqId);
        rejectBlob(new Error('SVG copy timed out after 10s'));
      }
    }, 10000);
    pendingSvgRequests.set(svgReqId, {
      resolve: (svg) => {
        clearTimeout(timeoutId);
        // Wrap the string in a Blob so the same Promise<Blob>+ClipboardItem
        // dance as for bitmap works here too. text/plain is the safest,
        // most-supported MIME for clipboard interop.
        resolveBlob(new Blob([svg], { type: 'text/plain' }));
      },
      reject: (err) => { clearTimeout(timeoutId); rejectBlob(err); }
    });

    iframe.contentWindow.postMessage({
      type: 'PLANTUML_COPY_SVG',
      requestId: svgReqId
    }, targetOriginFor(iframe));
    TRACE('PLANTUML_COPY_SVG posted, requestId=' + svgReqId);

    try {
      const item = new ClipboardItem({ 'text/plain': blobPromise });
      await navigator.clipboard.write([item]);
      TRACE('SVG clipboard write succeeded for requestId=' + svgReqId);
    } catch (err) {
      TRACE('SVG clipboard write failed for requestId=' + svgReqId + ':', err);
      pendingSvgRequests.delete(svgReqId);
    }
  }

  // ------------------------------------------------------------------
  // "Copy as bitmap" -- request the PNG blob from the given iframe and
  // write it to the clipboard as image/png. Silent on success/failure;
  // errors are only logged. Used by the renderer's context menu. The
  // header bitmap buttons keep their own logic with visual feedback;
  // this helper exists solely for the context-menu code path.
  // ------------------------------------------------------------------
  async function copyBitmapFromIframe(iframe) {
    const bitmapReqId = `bitmap-ctx-${++bitmapCounter}-${Date.now()}`;
    TRACE('copyBitmapFromIframe, requestId=' + bitmapReqId);

    let resolveBlob, rejectBlob;
    const blobPromise = new Promise((resolve, reject) => {
      resolveBlob = resolve;
      rejectBlob  = reject;
    });
    const timeoutId = setTimeout(() => {
      if (pendingBitmapRequests.has(bitmapReqId)) {
        pendingBitmapRequests.delete(bitmapReqId);
        rejectBlob(new Error('Bitmap copy timed out after 10s'));
      }
    }, 10000);
    pendingBitmapRequests.set(bitmapReqId, {
      resolve: (blob) => { clearTimeout(timeoutId); resolveBlob(blob); },
      reject:  (err)  => { clearTimeout(timeoutId); rejectBlob(err); }
    });

    iframe.contentWindow.postMessage({
      type: 'PLANTUML_COPY_BITMAP',
      requestId: bitmapReqId
    }, targetOriginFor(iframe));
    TRACE('PLANTUML_COPY_BITMAP posted from ctx menu, requestId=' + bitmapReqId);

    try {
      const item = new ClipboardItem({ 'image/png': blobPromise });
      await navigator.clipboard.write([item]);
      TRACE('bitmap clipboard write succeeded for requestId=' + bitmapReqId);
    } catch (err) {
      TRACE('bitmap clipboard write failed for requestId=' + bitmapReqId + ':', err);
      pendingBitmapRequests.delete(bitmapReqId);
    }
  }

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
    const { wrapper, iframe, toggleBtn, bitmapBtn, editBtn, theme: t, icons } = buildIframe(requestId, dark);

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

    // ------------------------------------------------------------------
    // Bitmap-copy button: ask the iframe to render the SVG to a PNG
    // blob, then copy it to the clipboard from this content-script
    // context (the iframe is sandboxed and cannot reach the clipboard
    // itself).
    // ------------------------------------------------------------------
    bitmapBtn.addEventListener('click', async () => {
      // Don't bother if there's nothing to copy yet (still loading or
      // currently showing source -- the iframe's #plantuml-output may
      // still hold the SVG, so we let the request go through; the
      // iframe will reject with "No SVG to copy" if it's truly empty).
      const bitmapReqId = `bitmap-${++bitmapCounter}-${Date.now()}`;
      TRACE('bitmap clicked, requestId=' + bitmapReqId);

      // Create the promise that will be resolved when the iframe sends
      // back the PNG blob (or rejected on error/timeout).
      let resolveBlob;
      let rejectBlob;
      const blobPromise = new Promise((resolve, reject) => {
        resolveBlob = resolve;
        rejectBlob = reject;
      });
      const timeoutId = setTimeout(() => {
        if (pendingBitmapRequests.has(bitmapReqId)) {
          pendingBitmapRequests.delete(bitmapReqId);
          rejectBlob(new Error('Bitmap copy timed out after 10s'));
        }
      }, 10000);
      pendingBitmapRequests.set(bitmapReqId, {
        resolve: (blob) => { clearTimeout(timeoutId); resolveBlob(blob); },
        reject:  (err)  => { clearTimeout(timeoutId); rejectBlob(err); }
      });

      // Pick the target origin the same way we do for PLANTUML_RENDER.
      let targetOrigin = RENDERER_ORIGIN;
      try {
        const sb = iframe.getAttribute('sandbox') || '';
        const opaque = sb.includes('allow-scripts') && !sb.includes('allow-same-origin');
        if (opaque) targetOrigin = '*';
      } catch (e) { /* ignore */ }

      // Kick off the SVG -> PNG conversion inside the iframe.
      iframe.contentWindow.postMessage({
        type: 'PLANTUML_COPY_BITMAP',
        requestId: bitmapReqId
      }, targetOrigin);
      TRACE('PLANTUML_COPY_BITMAP posted to iframe, requestId=' + bitmapReqId);

      // Write to clipboard synchronously here. Passing a Promise<Blob>
      // to ClipboardItem (Chrome-supported) preserves the transient
      // user activation from the click; the actual blob can arrive
      // asynchronously without losing the gesture.
      try {
        const item = new ClipboardItem({ 'image/png': blobPromise });
        await navigator.clipboard.write([item]);
        TRACE('clipboard write succeeded for requestId=' + bitmapReqId);
        // Brief green flash on success.
        const prevBg = bitmapBtn.style.background;
        bitmapBtn.style.background = '#2da44e';
        bitmapBtn.style.color = '#ffffff';
        setTimeout(() => {
          bitmapBtn.style.background = prevBg;
          bitmapBtn.style.color = t.wrapperFg;
        }, 600);
      } catch (err) {
        TRACE('clipboard write failed for requestId=' + bitmapReqId + ':', err);
        pendingBitmapRequests.delete(bitmapReqId);
        // Brief red flash + tooltip-only feedback on failure.
        const prevBg = bitmapBtn.style.background;
        const prevTitle = bitmapBtn.title;
        bitmapBtn.style.background = '#cf222e';
        bitmapBtn.style.color = '#ffffff';
        bitmapBtn.title = 'Copy failed: ' + (err && err.message ? err.message : err);
        setTimeout(() => {
          bitmapBtn.style.background = prevBg;
          bitmapBtn.style.color = t.wrapperFg;
          bitmapBtn.title = prevTitle;
        }, 2000);
      }
    });

    // ------------------------------------------------------------------
    // Edit-as-draft button: open a large modal with a textarea on the
    // left and a live preview iframe on the right. The preview iframe
    // reuses renderer.html and is re-rendered on every keystroke.
    // ------------------------------------------------------------------
    editBtn.addEventListener('click', () => {
      TRACE('edit-as-draft clicked, requestId=' + requestId);

      // Backdrop covers the whole viewport and dims the page behind.
      const backdrop = document.createElement('div');
      backdrop.className = 'plantuml-for-github-edit-backdrop';
      backdrop.style.cssText =
        'position: fixed; inset: 0; z-index: 2147483647; ' +
        'background: rgba(0, 0, 0, 0.5); ' +
        'display: flex; align-items: center; justify-content: center;';

      // Modal container.
      const modal = document.createElement('div');
      modal.style.cssText =
        'width: 90vw; height: 85vh; ' +
        'background: ' + t.iframeBg + '; ' +
        'color: ' + t.wrapperFg + '; ' +
        'border: 1px solid ' + t.borderCol + '; ' +
        'border-radius: 8px; ' +
        'box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3); ' +
        'display: flex; flex-direction: column; overflow: hidden;';

      // Modal header with title + close button.
      const modalHeader = document.createElement('div');
      modalHeader.style.cssText =
        'display: flex; align-items: center; justify-content: space-between; ' +
        'padding: 10px 16px; border-bottom: 1px solid ' + t.borderCol + '; ' +
        'background: ' + t.wrapperBg + ';';

      // Left side of the header: bitmap-copy button + title.
      const headerLeft = document.createElement('div');
      headerLeft.style.cssText = 'display: flex; align-items: center; gap: 10px;';

      // Bitmap-copy button -- same look & behaviour as the inline header
      // button, but it asks the draft renderer for the PNG instead of the
      // main wrapper's iframe.
      const modalBitmapBtn = document.createElement('button');
      modalBitmapBtn.type = 'button';
      modalBitmapBtn.className = 'plantuml-for-github-modal-copy-bitmap';
      modalBitmapBtn.setAttribute('aria-label', 'Copy diagram as bitmap');
      modalBitmapBtn.title = 'Copy diagram as bitmap';
      modalBitmapBtn.style.cssText =
        'display: inline-flex; align-items: center; justify-content: center; ' +
        'width: 28px; height: 28px; padding: 0; ' +
        'background: transparent; border: 1px solid transparent; ' +
        'border-radius: 4px; cursor: pointer; ' +
        'color: ' + t.wrapperFg + ';';
      modalBitmapBtn.addEventListener('mouseenter', () => {
        modalBitmapBtn.style.background = t.borderCol;
      });
      modalBitmapBtn.addEventListener('mouseleave', () => {
        modalBitmapBtn.style.background = 'transparent';
      });
      modalBitmapBtn.innerHTML = icons.image;

      const modalTitle = document.createElement('div');
      modalTitle.textContent = '⚠️ Draft — Your changes disappear on close —  Please copy/paste if you want to save';
      modalTitle.style.cssText =
        'font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; ' +
        'color: ' + t.wrapperFg + ';';

      headerLeft.appendChild(modalBitmapBtn);
      headerLeft.appendChild(modalTitle);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.title = 'Close';
      closeBtn.style.cssText =
        'display: inline-flex; align-items: center; justify-content: center; ' +
        'width: 28px; height: 28px; padding: 0; ' +
        'background: transparent; border: 1px solid transparent; ' +
        'border-radius: 4px; cursor: pointer; ' +
        'color: ' + t.wrapperFg + ';';
      closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = t.borderCol;
      });
      closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'transparent';
      });
      // Cross / X icon (Octicons-style).
      closeBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
        '<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>' +
        '</svg>';

      modalHeader.appendChild(headerLeft);
      modalHeader.appendChild(closeBtn);

      // Modal body: two columns -- textarea on the left, live SVG preview
      // on the right. The preview is driven by a dedicated renderer iframe
      // (same renderer.html as the inline diagrams) that we re-render on
      // every textarea change.
      const modalBody = document.createElement('div');
      modalBody.style.cssText =
        'flex: 1; display: flex; flex-direction: row; min-height: 0; ' +
        'background: ' + t.iframeBg + ';';

      // Left column: editor.
      const leftCol = document.createElement('div');
      leftCol.style.cssText =
        'flex: 1 1 50%; min-width: 0; display: flex; ' +
        'border-right: 1px solid ' + t.borderCol + ';';

      const textarea = document.createElement('textarea');
      textarea.value = source;
      textarea.spellcheck = false;
      textarea.setAttribute('autocapitalize', 'none');
      textarea.setAttribute('autocorrect', 'off');
      textarea.style.cssText =
        'flex: 1; width: 100%; height: 100%; box-sizing: border-box; ' +
        'padding: 12px; margin: 0; resize: none; ' +
        'border: none; outline: none; ' +
        'background: ' + t.iframeBg + '; ' +
        'color: ' + (dark ? '#e6edf3' : '#1f2328') + '; ' +
        'font: 13px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; ' +
        'tab-size: 4;';
      leftCol.appendChild(textarea);

      // Right column: preview area. We host the renderer directly as a
      // visible iframe (same renderer.html as the inline diagrams). The
      // renderer's own <html>/<body> already provides correct padding
      // around the SVG, so we don't need any extra CSS gymnastics here
      // -- just let it fill the column and scroll if the diagram is big.
      const rightCol = document.createElement('div');
      rightCol.style.cssText =
        'flex: 1 1 50%; min-width: 0; display: flex; ' +
        'background: ' + t.iframeBg + ';';

      const draftRenderer = document.createElement('iframe');
      draftRenderer.src = RENDERER_URL;
      // No sandbox attribute: same rationale as the inline iframe above.
      draftRenderer.style.cssText =
        'flex: 1; width: 100%; height: 100%; ' +
        'border: none; display: block; background: ' + t.iframeBg + ';';
      draftRenderer.setAttribute('title', 'PlantUML draft preview');
      rightCol.appendChild(draftRenderer);

      modalBody.appendChild(leftCol);
      modalBody.appendChild(rightCol);

      modal.appendChild(modalHeader);
      modal.appendChild(modalBody);
      backdrop.appendChild(modal);

      // ----------------------------------------------------------------
      // Live rendering: post the textarea content to the draft renderer
      // iframe on every keystroke (no debounce -- the TeaVM engine is
      // fast enough to keep up, and stale results are filtered out by
      // requestId comparison below).
      // ----------------------------------------------------------------
      const draftIdPrefix = 'puml-draft-' + requestId + '-';
      let draftCounter = 0;
      let latestDraftId = null;
      let draftReady = false;
      let pendingSource = null;

      function postRender(src) {
        if (!draftReady) {
          pendingSource = src;
          return;
        }
        const id = draftIdPrefix + (++draftCounter);
        latestDraftId = id;
        let targetOrigin = RENDERER_ORIGIN;
        try {
          const sb = draftRenderer.getAttribute('sandbox') || '';
          const opaque = sb.includes('allow-scripts') && !sb.includes('allow-same-origin');
          if (opaque) targetOrigin = '*';
        } catch (e) { /* ignore */ }
        draftRenderer.contentWindow.postMessage({
          type: 'PLANTUML_RENDER',
          source: src,
          requestId: id,
          options: { dark }
        }, targetOrigin);
        TRACE('draft render posted, id=' + id + ' src.len=' + src.length);
      }

      function onDraftMessage(event) {
        if (event.source !== draftRenderer.contentWindow) return;
        const d = event.data;
        if (!d || typeof d !== 'object') return;
        if (d.type !== 'PLANTUML_RESULT' && d.type !== 'PLANTUML_ERROR') return;
        if (typeof d.requestId !== 'string' || d.requestId.indexOf(draftIdPrefix) !== 0) return;
        // The renderer iframe displays the SVG itself; we don't need to
        // do anything with the result other than swallow stale-message
        // logging. The error case is already shown inline by renderer.js.
        if (d.requestId !== latestDraftId) {
          TRACE('draft stale result ignored, id=' + d.requestId);
        }
      }
      window.addEventListener('message', onDraftMessage);

      draftRenderer.addEventListener('load', () => {
        draftReady = true;
        // Tell the renderer to switch to modal layout mode so the SVG
        // keeps its intrinsic size and the body scrolls in both axes
        // when the diagram overflows.
        let targetOrigin = RENDERER_ORIGIN;
        try {
          const sb = draftRenderer.getAttribute('sandbox') || '';
          const opaque = sb.includes('allow-scripts') && !sb.includes('allow-same-origin');
          if (opaque) targetOrigin = '*';
        } catch (e) { /* ignore */ }
        draftRenderer.contentWindow.postMessage({
          type: 'PLANTUML_SET_MODE',
          mode: 'modal'
        }, targetOrigin);
        // Send the initial render (or anything queued while the iframe loaded).
        postRender(pendingSource != null ? pendingSource : textarea.value);
        pendingSource = null;
      });

      textarea.addEventListener('input', () => postRender(textarea.value));

      // ----------------------------------------------------------------
      // Modal bitmap-copy button: same Promise<Blob>+ClipboardItem dance
      // as the inline button, but targeting the draft renderer iframe.
      // ----------------------------------------------------------------
      const modalPendingBitmap = new Map();
      let modalBitmapCounter = 0;

      function onModalBitmapMessage(event) {
        if (event.source !== draftRenderer.contentWindow) return;
        const d = event.data;
        if (!d || typeof d !== 'object') return;
        if (d.type !== 'PLANTUML_BITMAP_RESULT' && d.type !== 'PLANTUML_BITMAP_ERROR') return;
        const pending = modalPendingBitmap.get(d.requestId);
        if (!pending) return;
        modalPendingBitmap.delete(d.requestId);
        if (d.type === 'PLANTUML_BITMAP_RESULT' && d.blob instanceof Blob) {
          pending.resolve(d.blob);
        } else {
          pending.reject(new Error(d.error || 'Unknown bitmap copy error'));
        }
      }
      window.addEventListener('message', onModalBitmapMessage);

      modalBitmapBtn.addEventListener('click', async () => {
        const reqId = 'modal-bitmap-' + requestId + '-' + (++modalBitmapCounter) + '-' + Date.now();
        TRACE('modal bitmap clicked, requestId=' + reqId);

        let resolveBlob, rejectBlob;
        const blobPromise = new Promise((resolve, reject) => {
          resolveBlob = resolve;
          rejectBlob = reject;
        });
        const timeoutId = setTimeout(() => {
          if (modalPendingBitmap.has(reqId)) {
            modalPendingBitmap.delete(reqId);
            rejectBlob(new Error('Bitmap copy timed out after 10s'));
          }
        }, 10000);
        modalPendingBitmap.set(reqId, {
          resolve: (b) => { clearTimeout(timeoutId); resolveBlob(b); },
          reject:  (e) => { clearTimeout(timeoutId); rejectBlob(e); }
        });

        let targetOrigin = RENDERER_ORIGIN;
        try {
          const sb = draftRenderer.getAttribute('sandbox') || '';
          const opaque = sb.includes('allow-scripts') && !sb.includes('allow-same-origin');
          if (opaque) targetOrigin = '*';
        } catch (e) { /* ignore */ }

        draftRenderer.contentWindow.postMessage({
          type: 'PLANTUML_COPY_BITMAP',
          requestId: reqId
        }, targetOrigin);

        try {
          const item = new ClipboardItem({ 'image/png': blobPromise });
          await navigator.clipboard.write([item]);
          TRACE('modal clipboard write succeeded for requestId=' + reqId);
          const prevBg = modalBitmapBtn.style.background;
          modalBitmapBtn.style.background = '#2da44e';
          modalBitmapBtn.style.color = '#ffffff';
          setTimeout(() => {
            modalBitmapBtn.style.background = prevBg;
            modalBitmapBtn.style.color = t.wrapperFg;
          }, 600);
        } catch (err) {
          TRACE('modal clipboard write failed for requestId=' + reqId + ':', err);
          modalPendingBitmap.delete(reqId);
          const prevBg = modalBitmapBtn.style.background;
          const prevTitle = modalBitmapBtn.title;
          modalBitmapBtn.style.background = '#cf222e';
          modalBitmapBtn.style.color = '#ffffff';
          modalBitmapBtn.title = 'Copy failed: ' + (err && err.message ? err.message : err);
          setTimeout(() => {
            modalBitmapBtn.style.background = prevBg;
            modalBitmapBtn.style.color = t.wrapperFg;
            modalBitmapBtn.title = prevTitle;
          }, 2000);
        }
      });

      // Closing logic: button, backdrop click outside the modal, or Escape key.
      const close = () => {
        TRACE('edit-as-draft modal closing, requestId=' + requestId);
        window.removeEventListener('message', onDraftMessage);
        window.removeEventListener('message', onModalBitmapMessage);
        document.removeEventListener('keydown', onKeyDown);
        backdrop.remove();
      };
      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      };
      closeBtn.addEventListener('click', close);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
      });
      document.addEventListener('keydown', onKeyDown);

      document.body.appendChild(backdrop);
      // Move keyboard focus into the editor for immediate typing.
      textarea.focus();
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
        (data.type === 'PLANTUML_RESULT' || data.type === 'PLANTUML_ERROR' ||
         data.type === 'PLANTUML_BITMAP_RESULT' || data.type === 'PLANTUML_BITMAP_ERROR' ||
         data.type === 'PLANTUML_SVG_RESULT' || data.type === 'PLANTUML_SVG_ERROR' ||
         data.type === 'PLANTUML_CTX_MENU_ACTION')) {
      TRACE('message received from origin=' + event.origin + ' type=' + data.type +
            ' requestId=' + data.requestId +
            (data.type === 'PLANTUML_ERROR' ? ' error=' + data.error : '') +
            (data.type === 'PLANTUML_BITMAP_ERROR' ? ' error=' + data.error : '') +
            (data.type === 'PLANTUML_SVG_ERROR' ? ' error=' + data.error : '') +
            (data.type === 'PLANTUML_RESULT' ? ' height=' + data.height : '') +
            (data.type === 'PLANTUML_BITMAP_RESULT' ? ' blob.size=' + (data.blob && data.blob.size) : '') +
            (data.type === 'PLANTUML_SVG_RESULT' ? ' svg.len=' + (data.svg && data.svg.length) : '') +
            (data.type === 'PLANTUML_CTX_MENU_ACTION' ? ' action=' + data.action : ''));
    }

    // Only accept messages from our own renderer origin.
    if (event.origin !== RENDERER_ORIGIN && event.origin !== 'null') return;

    if (!data || typeof data !== 'object') return;

    // Handle context-menu actions: the renderer iframe asks us to perform
    // a clipboard operation on its behalf (because the sandboxed iframe
    // can't reach navigator.clipboard, and the user gesture must originate
    // from a real github.com origin). The click in the menu propagates a
    // user activation here, so navigator.clipboard.write() will succeed.
    if (data.type === 'PLANTUML_CTX_MENU_ACTION') {
      // Find the iframe that posted this message. Both inline and modal
      // (draft) renderer iframes are matched -- we look up by
      // contentWindow identity, not by data-request-id, so the draft
      // iframe (which has no request id) works too.
      let sourceIframe = null;
      const iframes = document.querySelectorAll('iframe');
      for (const fr of iframes) {
        if (fr.contentWindow === event.source) {
          sourceIframe = fr;
          break;
        }
      }
      if (!sourceIframe) {
        TRACE('PLANTUML_CTX_MENU_ACTION: source iframe not found, ignoring');
        return;
      }
      if (data.action === 'copy-svg') {
        copySvgFromIframe(sourceIframe);
      } else if (data.action === 'copy-bitmap') {
        copyBitmapFromIframe(sourceIframe);
      } else {
        TRACE('PLANTUML_CTX_MENU_ACTION: unknown action ' + data.action);
      }
      return;
    }

    // Handle bitmap-copy responses: forward the blob (or error) to the
    // matching pending request created by the bitmap-button click.
    if (data.type === 'PLANTUML_BITMAP_RESULT' || data.type === 'PLANTUML_BITMAP_ERROR') {
      const pending = pendingBitmapRequests.get(data.requestId);
      if (!pending) {
        TRACE('no pending bitmap request for requestId=' + data.requestId);
        return;
      }
      pendingBitmapRequests.delete(data.requestId);
      if (data.type === 'PLANTUML_BITMAP_RESULT' && data.blob instanceof Blob) {
        pending.resolve(data.blob);
      } else {
        pending.reject(new Error(data.error || 'Unknown bitmap copy error'));
      }
      return;
    }

    // Handle SVG-copy responses: forward the SVG string (or error) to the
    // matching pending request created by copySvgFromIframe().
    if (data.type === 'PLANTUML_SVG_RESULT' || data.type === 'PLANTUML_SVG_ERROR') {
      const pending = pendingSvgRequests.get(data.requestId);
      if (!pending) {
        TRACE('no pending svg request for requestId=' + data.requestId);
        return;
      }
      pendingSvgRequests.delete(data.requestId);
      if (data.type === 'PLANTUML_SVG_RESULT' && typeof data.svg === 'string') {
        pending.resolve(data.svg);
      } else {
        pending.reject(new Error(data.error || 'Unknown svg copy error'));
      }
      return;
    }

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
