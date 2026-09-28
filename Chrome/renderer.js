// =====================================================================
// PlantUML for GitHub - Renderer (sandbox iframe)
// =====================================================================
// Runs inside the sandboxed iframe. Loads the TeaVM-compiled PlantUML
// engine, listens for PLANTUML_RENDER messages from the parent page,
// renders the diagram, and posts the SVG back.
// =====================================================================

import { render } from './vendor/plantuml.js';

// ====== TRACE ======
// Set DEBUG to true to get detailed traces in the iframe's console.
const DEBUG = false;
const TRACE = DEBUG
  ? (...args) => console.log('[PUML4GH][renderer]', ...args)
  : () => {};
TRACE('renderer.js module loaded, location=', location.href);
TRACE('render import =', typeof render);
// ===================

const output = document.getElementById('plantuml-output');
TRACE('output element =', output);

// We accept messages from any origin because the iframe is sandboxed
// (sandbox="allow-scripts") and the parent's origin is opaque ("null")
// from our perspective. We protect ourselves by validating the message
// shape and only ever responding to event.source / event.origin.
window.addEventListener('message', (event) => {
  const data = event.data;
  // Trace EVERY message that lands on this iframe, even ones we ignore.
  TRACE('window.message fired, origin=' + event.origin +
        ' data.type=' + (data && typeof data === 'object' ? data.type : typeof data));
  if (!data || typeof data !== 'object') {
    return;
  }
  if (data.type === 'PLANTUML_SET_MODE') {
    // Toggle modal layout mode: lets the SVG keep its intrinsic size and
    // makes the renderer body scroll in both axes when the diagram is
    // larger than the iframe. Sent once by the parent (the modal) right
    // after the iframe loads.
    const modal = data.mode === 'modal';
    document.documentElement.classList.toggle('puml-modal', modal);
    TRACE('PLANTUML_SET_MODE received, mode=' + data.mode + ' -> puml-modal=' + modal);
    return;
  }
  if (data.type === 'PLANTUML_COPY_BITMAP') {
    TRACE('PLANTUML_COPY_BITMAP received from origin=' + event.origin +
          ' requestId=' + data.requestId);
    if (typeof data.requestId !== 'string') {
      TRACE('invalid bitmap-copy message shape, ignoring');
      return;
    }
    svgToPngBlob()
      .then((blob) => {
        TRACE('svgToPngBlob resolved, blob.size=' + blob.size);
        event.source.postMessage({
          type: 'PLANTUML_BITMAP_RESULT',
          requestId: data.requestId,
          blob
        }, event.origin);
      })
      .catch((err) => {
        TRACE('svgToPngBlob rejected:', err);
        event.source.postMessage({
          type: 'PLANTUML_BITMAP_ERROR',
          requestId: data.requestId,
          error: String(err && err.message ? err.message : err)
        }, event.origin);
      });
    return;
  }

  if (data.type === 'PLANTUML_COPY_SVG') {
    // The parent (content script) asks for the SVG markup so it can
    // write it to the clipboard from a real github.com origin -- the
    // sandboxed iframe cannot reach navigator.clipboard itself.
    TRACE('PLANTUML_COPY_SVG received from origin=' + event.origin +
          ' requestId=' + data.requestId);
    if (typeof data.requestId !== 'string') {
      TRACE('invalid svg-copy message shape, ignoring');
      return;
    }
    try {
      const svgString = serializeSvg();
      TRACE('serializeSvg ok, len=' + svgString.length);
      event.source.postMessage({
        type: 'PLANTUML_SVG_RESULT',
        requestId: data.requestId,
        svg: svgString
      }, event.origin);
    } catch (err) {
      TRACE('serializeSvg failed:', err);
      event.source.postMessage({
        type: 'PLANTUML_SVG_ERROR',
        requestId: data.requestId,
        error: String(err && err.message ? err.message : err)
      }, event.origin);
    }
    return;
  }

  if (data.type !== 'PLANTUML_RENDER') {
    return;
  }
  TRACE('PLANTUML_RENDER received from origin=' + event.origin +
        ' requestId=' + data.requestId +
        ' source.len=' + (typeof data.source === 'string' ? data.source.length : 'n/a'));
  if (typeof data.source !== 'string' || typeof data.requestId !== 'string') {
    TRACE('invalid message shape, ignoring');
    return;
  }

  const { source, requestId, options } = data;
  const dark = options && options.dark === true;

  // Apply the theme to the iframe's root element so the background
  // matches GitHub's color mode. PlantUML itself draws the diagram in
  // dark/light per the same flag; this just paints the canvas behind it.
  document.documentElement.classList.toggle('puml-dark', dark);
  TRACE('theme applied: puml-dark=' + dark);

  renderDiagram(source, dark)
    .then(({ svg, height }) => {
      TRACE('renderDiagram resolved, svg.len=' + svg.length + ' height=' + height);
      event.source.postMessage({
        type: 'PLANTUML_RESULT',
        requestId,
        svg,
        height
      }, event.origin);
    })
    .catch((err) => {
      TRACE('renderDiagram rejected:', err);
      event.source.postMessage({
        type: 'PLANTUML_ERROR',
        requestId,
        error: String(err && err.message ? err.message : err)
      }, event.origin);
    });
});
TRACE('message listener attached');

// ------------------------------------------------------------------
// Context menu shown on right-click over the rendered SVG.
// Currently provides "Copy as bitmap" and "Copy as SVG". Clicks
// post a PLANTUML_CTX_MENU_ACTION message to the parent (content
// script), which performs the actual clipboard write from a real
// github.com origin.
//
// Implemented inside the renderer iframe (rather than the parent
// content script) so positioning is straightforward and the menu
// doesn't have to cross the iframe boundary. Event delegation on
// #plantuml-output keeps it working after every re-render (notably
// in the live preview of the edit-as-draft modal).
// ------------------------------------------------------------------
let ctxMenuEl = null;

function closeContextMenu() {
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
    document.removeEventListener('mousedown', onDocMouseDownForMenu, true);
    document.removeEventListener('keydown',   onDocKeyDownForMenu,   true);
    window.removeEventListener('blur',        closeContextMenu);
    window.removeEventListener('scroll',      closeContextMenu, true);
    window.removeEventListener('resize',      closeContextMenu);
    TRACE('context menu closed');
  }
}

function onDocMouseDownForMenu(e) {
  // Close on any click outside the menu. A click inside is handled
  // by the <li> click listeners (which call closeContextMenu themselves).
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) {
    closeContextMenu();
  }
}

function onDocKeyDownForMenu(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeContextMenu();
  }
}

function showContextMenu(clientX, clientY) {
  // Replace any previously-open menu first.
  closeContextMenu();

  const menu = document.createElement('ul');
  menu.className = 'puml-ctx-menu';
  menu.setAttribute('role', 'menu');

  // Menu entries. Wiring: clicking a menu item posts a message to
  // the parent (content script), which performs the actual clipboard
  // write from a real github.com origin. The user gesture from the
  // click propagates across the iframe boundary via the user-activation
  // model, so navigator.clipboard.write() succeeds in the parent.
  const ENTRIES = [
    { id: 'copy-bitmap', label: 'Copy as bitmap' },
    { id: 'copy-svg',    label: 'Copy as SVG' }
  ];
  for (const entry of ENTRIES) {
    const li = document.createElement('li');
    li.setAttribute('role', 'menuitem');
    li.dataset.action = entry.id;
    li.textContent = entry.label;
    li.addEventListener('click', () => {
      TRACE('context menu action selected:', entry.id);
      // Post the request to the parent. The parent's window is always
      // reachable via window.parent here (we live in an iframe).
      // targetOrigin '*' is safe because the message is a one-way
      // signal carrying no secret -- it only tells the parent which
      // menu entry was clicked.
      try {
        window.parent.postMessage({
          type: 'PLANTUML_CTX_MENU_ACTION',
          action: entry.id
        }, '*');
      } catch (err) {
        TRACE('failed to post ctx-menu action to parent:', err);
      }
      closeContextMenu();
    });
    menu.appendChild(li);
  }

  // Append first (offscreen) so we can measure, then clamp to viewport
  // so the menu doesn't get cut off near the right/bottom edges.
  menu.style.left = '-9999px';
  menu.style.top  = '-9999px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const vw   = document.documentElement.clientWidth;
  const vh   = document.documentElement.clientHeight;
  let   x    = clientX;
  let   y    = clientY;
  if (x + rect.width  > vw) x = Math.max(0, vw - rect.width  - 2);
  if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 2);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  ctxMenuEl = menu;

  // Use capture phase so we win against any listeners inside the menu.
  document.addEventListener('mousedown', onDocMouseDownForMenu, true);
  document.addEventListener('keydown',   onDocKeyDownForMenu,   true);
  // Anything that changes the layout under the menu invalidates it.
  window.addEventListener('blur',   closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);

  TRACE('context menu opened at (' + x + ',' + y + ')');
}

// Delegated right-click handler on the output container. Fires for
// every right-click on or inside the rendered SVG, including children
// re-created on each render.
output.addEventListener('contextmenu', (e) => {
  // Only intercept right-clicks that actually land on an SVG.
  const target = e.target;
  if (!target || (target.nodeName !== 'svg' && !target.closest('svg'))) {
    return;
  }
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY);
});
TRACE('context menu handler attached on #plantuml-output');

// Global error traps so silent failures show up.
window.addEventListener('error', (e) => {
  TRACE('window error:', e.message, 'at', e.filename + ':' + e.lineno + ':' + e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
  TRACE('unhandled promise rejection:', e.reason);
});

// ------------------------------------------------------------------
// Render one diagram. Returns a promise that resolves with the SVG
// markup and the rendered height.
// ------------------------------------------------------------------
function renderDiagram(source, dark) {
  return new Promise((resolve, reject) => {
    TRACE('renderDiagram called, lines=' + source.split(/\r\n|\r|\n/).length + ' dark=' + dark);
    // Clear previous output.
    output.innerHTML = '';

    const lines = source.split(/\r\n|\r|\n/);

    // The PlantUML JS engine renders asynchronously and inserts the
    // SVG into the target element. We watch the DOM until rendering
    // stabilises, then read the final SVG and its true height.
    //
    // Subtleties:
    //   - PlantUML may insert the <svg> element first and then keep
    //     adding children to it. Resolving on first <svg> sighting
    //     gives the height of a partial render.
    //   - The SVG carries its real size in its `width`/`height` or
    //     `viewBox` attributes; the rendered (CSS) height can differ
    //     because of scaling. We compute height from the SVG itself,
    //     not from output.scrollHeight.
    let settleTimer = null;
    const SETTLE_MS = 80; // wait this long after last DOM mutation

    function readSize(svgEl) {
      // Try, in order: getBBox (rendered geometry), width/height attrs,
      // then viewBox.
      let w = 0, h = 0;
      try {
        const b = svgEl.getBBox();
        w = b.width; h = b.height;
      } catch (e) { /* getBBox can throw if not laid out yet */ }
      if (!h) {
        const wAttr = svgEl.getAttribute('width');
        const hAttr = svgEl.getAttribute('height');
        const wNum = wAttr && parseFloat(wAttr);
        const hNum = hAttr && parseFloat(hAttr);
        if (hNum) { w = wNum || w; h = hNum; }
      }
      if (!h) {
        const vb = svgEl.getAttribute('viewBox');
        if (vb) {
          const parts = vb.split(/[\s,]+/).map(parseFloat);
          if (parts.length === 4) { w = parts[2]; h = parts[3]; }
        }
      }
      // Also peek at bounding-client for the actual rendered height
      // (useful when CSS scales the SVG down).
      const rect = svgEl.getBoundingClientRect();
      return { w, h, rectH: rect.height, scrollH: output.scrollHeight };
    }

    function finish() {
      const svgEl = output.querySelector('svg');
      if (!svgEl) return; // nothing to do
      observer.disconnect();
      const sizes = readSize(svgEl);
      // The host iframe needs to fit the entire <body>, not just the SVG
      // — there's padding on <html>/<body> that adds to the total height.
      // documentElement.scrollHeight gives the full content height of the
      // iframe document, padding included.
      const docH = document.documentElement.scrollHeight;
      const bodyH = document.body.scrollHeight;
      const measured = Math.max(
        sizes.h || 0, sizes.rectH || 0, sizes.scrollH || 0,
        docH || 0, bodyH || 0
      );
      TRACE('finish: svg sizes', sizes,
            ' docH=' + docH + ' bodyH=' + bodyH +
            ' -> chosen height=' + measured);
      resolve({ svg: output.innerHTML, height: Math.ceil(measured) });
    }

    const observer = new MutationObserver(() => {
      const svgEl = output.querySelector('svg');
      if (!svgEl) return;
      // Reset settle timer on every mutation; we only consider rendering
      // done when the DOM has been quiet for SETTLE_MS.
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        TRACE('DOM quiet for ' + SETTLE_MS + 'ms, finishing');
        finish();
      }, SETTLE_MS);
    });
    observer.observe(output, { childList: true, subtree: true, attributes: true });

    // Safety timeout: if nothing renders in 15s, give up.
    const timeout = setTimeout(() => {
      TRACE('render TIMEOUT after 15s. output.innerHTML preview=',
            output.innerHTML.slice(0, 200));
      observer.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
      showError('Rendering timed out after 15s');
      reject(new Error('Rendering timed out'));
    }, 15000);

    // Replace the resolve to also clear the timeout.
    const originalResolve = resolve;
    resolve = (value) => {
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      originalResolve(value);
    };

    try {
      TRACE('calling render(lines, "plantuml-output", { dark })');
      render(lines, 'plantuml-output', { dark });
      TRACE('render() call returned (sync part done)');
    } catch (err) {
      TRACE('render() threw synchronously:', err);
      clearTimeout(timeout);
      if (settleTimer) clearTimeout(settleTimer);
      observer.disconnect();
      showError(err.message || String(err));
      reject(err);
    }
  });
}

function showError(message) {
  output.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'puml-error';
  div.textContent = 'PlantUML error: ' + message;
  output.appendChild(div);
}

// ------------------------------------------------------------------
// Serialize the SVG currently in #plantuml-output to a standalone
// XML string. Throws if no SVG is present. The result is what the
// parent (content script) writes to the clipboard for "Copy as SVG".
// ------------------------------------------------------------------
function serializeSvg() {
  const svg = output.querySelector('svg');
  if (svg == null) {
    throw new Error('No SVG to copy');
  }
  const clone = svg.cloneNode(true);
  // xmlns is required for the string to round-trip as a standalone
  // SVG document (paste into Inkscape, save to a .svg file, etc.).
  if (clone.getAttribute('xmlns') == null) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  return new XMLSerializer().serializeToString(clone);
}

// ------------------------------------------------------------------
// Convert the SVG currently in #plantuml-output to a PNG Blob.
// Returns a promise resolving with the PNG blob. The iframe is
// sandboxed without allow-same-origin, so we can't call
// navigator.clipboard.write() from here -- we just hand the blob
// back to the parent (content script) via postMessage and let it
// do the clipboard write from a real github.com origin.
// ------------------------------------------------------------------
async function svgToPngBlob() {
  const svg = output.querySelector('svg');
  if (svg == null) {
    throw new Error('No SVG to copy');
  }

  // Serialize SVG with proper xmlns (required for standalone rendering).
  const svgString = serializeSvg();
  const svgBlob = new Blob([svgString], {type: 'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(svgBlob);

  try {
    // Determine target dimensions (account for devicePixelRatio for crisp output).
    const rect = svg.getBoundingClientRect();
    let width = rect.width;
    let height = rect.height;
    if (!width || !height) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (vb) {
        width = width || vb.width;
        height = height || vb.height;
      }
    }
    if (!width || !height) {
      throw new Error('Cannot determine SVG dimensions');
    }
    const ratio = window.devicePixelRatio || 1;

    // Load SVG into an Image.
    const img = new Image();
    img.width = width;
    img.height = height;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = url;
    });

    // Draw on canvas with theme background so the PNG looks right when pasted.
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    const ctx = canvas.getContext('2d');
    const bg = getComputedStyle(document.body).backgroundColor || 'white';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(ratio, ratio);
    ctx.drawImage(img, 0, 0, width, height);

    // Convert canvas to PNG blob.
    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b == null ? reject(new Error('toBlob failed')) : resolve(b), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
