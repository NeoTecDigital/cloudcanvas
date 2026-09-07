/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Everything the session does *to its host element*: the four layers it builds
 * inside it, the listeners it binds to it, and taking both away again.
 *
 * Split out of `./session.js` for the reason every other engine module was: the
 * session is the state and the public surface, and each transition it performs
 * lives beside it as free functions taking the session first. This one is the
 * DOM-membership transition - the only place a layer element is created or
 * removed, and the only place `addEventListener` is called on the host.
 *
 * The layers are found before they are built, so a re-`mount()` onto a host that
 * already carries them adopts what is there instead of stacking a second set.
 */
import { bindKeyboard, unbindKeyboard } from './keyboard.js';

/** SVG namespace for the vector layer. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Layer classes, in paint order; each is also the selector it is found by. */
export const LAYER_CLASSES = Object.freeze({
  SVG: 'cloudcanvas-svg-layer',
  PLANE: 'cloudcanvas-plane',
  VEIL: 'cloudcanvas-focus-veil',
  OVERLAY: 'cloudcanvas-overlay-layer'
});

/** Class the session puts on its host element while it is mounted. */
export const HOST_CLASS = 'cloudcanvas-host';

/** The existing child with this class, or a fresh element appended to `host`. */
function adoptOrCreate(host, className, create) {
  const existing = host.querySelector(`:scope > .${className}`);
  if (existing) return existing;

  const element = create();
  host.appendChild(element);
  return element;
}

/**
 * Build (or adopt) the session's four layers inside its host element.
 *
 * Order is paint order, and each layer's z-index is a token, so a consumer can
 * reorder them without the elements moving:
 *
 *   1/2. `.cloudcanvas-svg-layer`     connectors and vector geometry, in canvas
 *        coordinates - it carries the same camera transform as the plane.
 *   3.   `.cloudcanvas-plane`         every Pin element, and the focus veil as
 *        its first child so the veil sits under the Pins in document order and
 *        is lifted over them by `--cc-z-veil` alone.
 *   4.   `.cloudcanvas-overlay-layer` cursors and HUD, untransformed: the one
 *        layer that draws in screen space.
 *
 * @returns {boolean} true when the layers are in place
 */
export function mountLayers(session) {
  const host = session.hostElement;
  if (!host || typeof document === 'undefined') return false;

  // Recorded, not assumed: a page that already marks its own canvas host keeps
  // the class through `destroy()`, and one that does not gets it taken back off.
  session._hostClassAdded = !host.classList.contains(HOST_CLASS);
  host.classList.add(HOST_CLASS);

  session.svgLayerElement = adoptOrCreate(host, LAYER_CLASSES.SVG, () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', LAYER_CLASSES.SVG);
    return svg;
  });
  // Persistent per-trait `<g>` groups live here, owned by the renderer.
  session.renderer.setSvgLayerElement(session.svgLayerElement);

  const plane = adoptOrCreate(host, LAYER_CLASSES.PLANE, () => {
    const element = document.createElement('div');
    element.className = LAYER_CLASSES.PLANE;
    return element;
  });
  session.planeElement = plane;
  session.pinManager.setContainer(plane);
  session.renderer.setPlaneElement(plane);

  let veil = plane.querySelector(`:scope > .${LAYER_CLASSES.VEIL}`);
  if (!veil) {
    veil = document.createElement('div');
    veil.className = LAYER_CLASSES.VEIL;
    plane.insertBefore(veil, plane.firstChild);
  }
  session.focusVeilElement = veil;

  session.overlayElement = adoptOrCreate(host, LAYER_CLASSES.OVERLAY, () => {
    const element = document.createElement('div');
    element.className = LAYER_CLASSES.OVERLAY;
    return element;
  });

  return true;
}

/**
 * Detach every layer this session built, forget them, and hand the host back.
 *
 * The host is the one element the session does not own, so the reversal is
 * exact rather than wholesale: the class goes only if `mountLayers` was the one
 * that added it, and the `class` attribute itself is removed when taking it
 * away leaves the attribute empty - an empty `class=""` is residue too.
 */
export function unmountLayers(session) {
  for (const key of ['focusVeilElement', 'planeElement', 'svgLayerElement', 'overlayElement']) {
    const element = session[key];
    if (element && element.parentNode) element.parentNode.removeChild(element);
    session[key] = null;
  }

  const host = session.hostElement;
  if (host && host.classList && session._hostClassAdded) {
    host.classList.remove(HOST_CLASS);
    if (host.getAttribute('class') === '') host.removeAttribute('class');
  }
  session._hostClassAdded = false;
  return true;
}

/**
 * Register the session's input listeners.
 *
 * Pointer *down* is the host's, because a gesture starts inside the canvas;
 * move and up are the window's, because a gesture that leaves the box is still
 * that gesture. Resize is what keeps the cached host rect honest. The wheel
 * listener is explicitly `passive: false`: the handler owns the wheel inside
 * the box and calls `preventDefault` unconditionally.
 *
 * @returns {boolean} true when the listeners were registered
 */
export function bindSessionEvents(session) {
  const host = session.hostElement;
  if (!host) return false;

  host.addEventListener('pointerdown', session._onPointerDown);
  window.addEventListener('pointermove', session._onPointerMove);
  window.addEventListener('pointerup', session._onPointerUp);
  window.addEventListener('pointercancel', session._onPointerUp);
  window.addEventListener('resize', session._onResize);
  host.addEventListener('wheel', session._onWheel, { passive: false });
  host.addEventListener('contextmenu', session._onContextMenu);

  // Keyboard control keeps its own listener and its own roving state, both
  // created here and taken away by `unbindKeyboard` (see `./keyboard.js`).
  bindKeyboard(session);
  return true;
}

/** Remove every listener `bindSessionEvents` registered. */
export function unbindSessionEvents(session) {
  unbindKeyboard(session);

  const host = session.hostElement;
  if (host) {
    host.removeEventListener('pointerdown', session._onPointerDown);
    host.removeEventListener('wheel', session._onWheel);
    host.removeEventListener('contextmenu', session._onContextMenu);
  }

  if (typeof window !== 'undefined') {
    window.removeEventListener('pointermove', session._onPointerMove);
    window.removeEventListener('pointerup', session._onPointerUp);
    window.removeEventListener('pointercancel', session._onPointerUp);
    window.removeEventListener('resize', session._onResize);
  }
  return true;
}
