// =====================================================================
// PlantUML for GitHub - Renderer (sandbox iframe)
// =====================================================================
// Runs inside the sandboxed iframe. Loads the TeaVM-compiled PlantUML
// engine, listens for PLANTUML_RENDER messages from the parent page,
// renders the diagram, and posts the SVG back.
// =====================================================================

import { render } from './vendor/plantuml.js';

// ====== TRACE ======
const TRACE = (...args) => console.log('[PUML4GH][renderer]', ...args);
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
