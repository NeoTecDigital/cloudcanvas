/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * The session's accessibility surface: static ARIA identity, and the live
 * region everything transient is announced through.
 *
 * Two halves, one concern - what the canvas tells assistive technology:
 *
 *   1. `applyHostAria` writes the host's role and name once, at mount, and
 *      hides the purely decorative layers from the accessibility tree. Author
 *      values are never overwritten: a page that already said what its canvas
 *      is knows better than a default does.
 *   2. `mountAnnouncer` / `announce` own one polite live region. Camera moves,
 *      focus changes and provisioning results are invisible without it - the
 *      DOM changed, but nothing was *said*.
 *
 * `role="application"` is the reason the keyboard module exists: it takes every
 * key away from the screen reader, so it may only ship on a host that gives
 * every key back (`./keyboard.js`).
 *
 * State lives on the session, created here and removed here: `_liveRegion` is
 * the region element, and it is absent until `mountAnnouncer` runs.
 */

/** Class of the live region; styled visually-hidden by the canvas stylesheet. */
export const LIVE_REGION_CLASS = 'cloudcanvas-live-region';

/** Accessible role of the host element. */
export const HOST_ROLE = 'application';

/** What the host calls itself, over the role's generic name. */
export const HOST_ROLEDESCRIPTION = 'canvas';

/** Name used when the page supplies neither `aria-label` nor `options.label`. */
export const DEFAULT_HOST_LABEL = 'Interactive canvas';

/**
 * The same rules as `.cloudcanvas-live-region`, inline.
 *
 * The stylesheet is optional (`autoInjectStyles: false`) and a consumer's CSS
 * reset can flatten a class; a region that is merely off-screen is still read,
 * but one that is `display: none` is not read at all. The inline copy is the
 * floor under both failures.
 */
const HIDDEN_STYLE = 'position:absolute;width:1px;height:1px;padding:0;'
  + 'overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;';

/**
 * Appended to a repeated message so the region's text genuinely changes.
 *
 * A live region announces *changes*. Focusing two Pins with the same title
 * writes the same string twice, which is not a change, and the second one is
 * silently dropped. A trailing no-break space is a change that reads as
 * nothing, and toggling it means the next repeat differs again.
 */
const NBSP = '\u00a0';

/* ------------------ STATIC ARIA ------------------ */

/** Set an attribute only when the author has not already set one. */
function setIfAbsent(element, name, value) {
  if (!element || typeof element.setAttribute !== 'function') return false;
  if (typeof element.hasAttribute === 'function' && element.hasAttribute(name)) return false;
  element.setAttribute(name, value);
  return true;
}

/** Take a decorative layer out of the accessibility tree entirely. */
function hideFromAssistiveTech(element) {
  if (!element || typeof element.setAttribute !== 'function') return false;
  element.setAttribute('aria-hidden', 'true');
  return true;
}

/**
 * Write the host's ARIA identity and hide the drawing layers.
 *
 * The SVG connector layer, the focus veil and the cursor overlay are hidden:
 * the first and last are projections of Pins that are already in the tree, and
 * announcing them again would double every Pin; the veil is a dimming surface
 * with no content at all.
 *
 * Which attributes were actually written is recorded on the session, because
 * `destroy()` must reverse exactly what this session added and nothing the
 * author had already set (see `removeHostAria`).
 *
 * @param {CloudCanvasSession} session mounted session
 * @returns {boolean} true when the host was labelled
 */
export function applyHostAria(session) {
  const host = session ? session.hostElement : null;
  if (!host) return false;

  const label = session.options && session.options.label
    ? session.options.label
    : DEFAULT_HOST_LABEL;

  const written = [];
  if (setIfAbsent(host, 'role', HOST_ROLE)) written.push('role');
  if (setIfAbsent(host, 'aria-roledescription', HOST_ROLEDESCRIPTION)) {
    written.push('aria-roledescription');
  }
  if (setIfAbsent(host, 'aria-label', label)) written.push('aria-label');
  session._hostAriaAttributes = written;

  hideFromAssistiveTech(session.svgLayerElement);
  hideFromAssistiveTech(session.focusVeilElement);
  hideFromAssistiveTech(cursorLayerOf(session));
  return true;
}

/**
 * Take the host's ARIA identity back off, and only the part this session put on.
 *
 * The layers carry their own `aria-hidden`, and the layers leave with
 * `unmountLayers`, so there is nothing to reverse there. The host is the one
 * element the session does not own, which is the whole reason the write was
 * recorded rather than replayed from the defaults.
 *
 * @returns {boolean} true when at least one attribute was removed
 */
export function removeHostAria(session) {
  if (!session) return false;

  const host = session.hostElement;
  const written = session._hostAriaAttributes;
  session._hostAriaAttributes = null;

  if (!host || !written || written.length === 0) return false;
  if (typeof host.removeAttribute !== 'function') return false;

  for (const name of written) host.removeAttribute(name);
  return true;
}

/** The cursor overlay `<svg>`, which the cursor system creates inside the overlay. */
function cursorLayerOf(session) {
  const overlay = session.overlayElement;
  if (!overlay || typeof overlay.querySelector !== 'function') return null;
  return overlay.querySelector('svg.cloudcanvas-cursor-layer');
}

/* ------------------ LIVE REGION ------------------ */

/**
 * Create the session's polite live region inside the host.
 *
 * Idempotent: a re-mounted session drops the old region first, so a host is
 * never left with two of them competing to describe the same canvas.
 *
 * @returns {Element|null} the region, or null in a headless environment
 */
export function mountAnnouncer(session) {
  if (typeof document === 'undefined' || !session || !session.hostElement) return null;
  unmountAnnouncer(session);

  const region = document.createElement('div');
  region.className = LIVE_REGION_CLASS;
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.setAttribute('style', HIDDEN_STYLE);

  session.hostElement.appendChild(region);
  session._liveRegion = region;
  return region;
}

/** Remove the live region; the session keeps working without one. */
export function unmountAnnouncer(session) {
  const region = session ? session._liveRegion : null;
  if (!region) return false;

  if (region.parentNode) region.parentNode.removeChild(region);
  session._liveRegion = null;
  return true;
}

/**
 * Say something, politely.
 *
 * Empty messages are dropped rather than clearing the region: a live region
 * emptied and refilled announces twice.
 *
 * @returns {boolean} true when the region's text changed
 */
export function announce(session, text) {
  const region = session ? session._liveRegion : null;
  if (!region) return false;

  const message = text === null || text === undefined ? '' : String(text).trim();
  if (message === '') return false;

  region.textContent = region.textContent === message ? message + NBSP : message;
  return true;
}

/* ------------------ MESSAGES ------------------ */

/** A Pin's spoken name: its title, falling back to the id that always exists. */
export function titleOf(pin) {
  if (!pin) return '';
  const title = pin.contents ? pin.contents.get('title') : null;
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  if (typeof title === 'number' && Number.isFinite(title)) return String(title);
  return pin.id;
}

/**
 * Announce a focus transition, including the one back to nothing.
 * Called from the session's focus wrappers, so every route to a focus change -
 * pointer, keyboard, or API - is announced exactly once.
 */
export function announceFocus(session, pin) {
  return announce(session, pin ? `Focused ${titleOf(pin)}` : 'Focus cleared');
}

/**
 * Announce a Pin entering or leaving its edit lock.
 *
 * The edit lock is invisible: the Pin looks the same, and the only change is
 * that its content has stopped being rewritten under the caret. Both ends are
 * announced, because "finished editing" is what tells a reader the Pin is live
 * again.
 *
 * @param {CloudCanvasSession} session
 * @param {Pin|null} pin the Pin the `edit` signal came from
 * @param {boolean} editing the signal's payload: true on entry, false on exit
 * @returns {boolean} true when the region's text changed
 */
export function announceEdit(session, pin, editing) {
  if (!session || !pin) return false;
  const label = titleOf(pin);
  return announce(session, editing ? `Editing ${label}` : `Finished editing ${label}`);
}

/**
 * Announce the outcome of a lazy scope's provider run.
 *
 * The loader never rejects - it reports failure by transmitting
 * `CHILDREN_ERROR_EVENT` and leaving the Pin un-provisioned - so the flag it
 * sets is what distinguishes "loaded nothing" from "failed". A rejected
 * provider stays armed for a retry, which is why the message says what
 * happened rather than that the scope is empty.
 */
export function announceProvision(session, pin, created) {
  if (!session || !pin) return false;
  if (!pin._childrenLoaded) return announce(session, 'Failed to load items');
  return announce(session, `${created.length} items loaded`);
}
