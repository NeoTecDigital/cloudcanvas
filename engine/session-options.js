/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * The session's option surface, stated once and enforced.
 *
 * A constructor that spreads whatever it is handed and reads the four keys it
 * recognises is a constructor that cannot be wrong out loud: `hostElement` for
 * `container` was accepted in silence for a whole release, and the session it
 * produced mounted nothing, rendered nothing, and reported nothing. The list
 * below is the honest API - closed, alphabetical, and the thing the error
 * message quotes back.
 *
 * Kept beside `./session.js` rather than inside it for the reason every other
 * engine module is: the session is the state and the public surface, and each
 * rule it enforces lives next to it.
 */

/**
 * Every option `CloudCanvasSession` reads, and the whole of it.
 *
 *   autoInjectStyles `false` keeps the shared canvas stylesheet out of the page.
 *   container        Element or selector to mount into; omit to mount later.
 *   customCSS        Per-session author CSS, removed again by `destroy()`.
 *   defaultReload    Default reload strategy for every Pin.
 *   label            Accessible name for the host element.
 *   loadChildren     Session-level lazy child provider.
 *   offloadMargin    Screen-pixel clearance before an `offload` Pin is detached.
 *   viewport         Initial camera (`{x, y, scale, minScale, maxScale}`).
 *
 * @type {readonly string[]}
 */
export const SESSION_OPTION_KEYS = Object.freeze([
  'autoInjectStyles',
  'container',
  'customCSS',
  'defaultReload',
  'label',
  'loadChildren',
  'offloadMargin',
  'viewport'
]);

/**
 * Wrong names the session has a right one for.
 *
 * Every entry is a mistake that has actually been made against this API, which
 * is the only reason a hint is worth carrying: a guess dressed as guidance is
 * worse than the plain list.
 */
const OPTION_HINTS = Object.freeze({
  css: 'customCSS',
  element: 'container',
  host: 'container',
  hostElement: 'container',
  styles: 'customCSS',
  target: 'container'
});

/**
 * Reject an option the session would otherwise ignore.
 *
 * @param {object} options
 * @returns {true}
 * @throws {TypeError} naming the offending key, and its real name when there is one
 */
export function assertKnownOptions(options = {}) {
  for (const key of Object.keys(options)) {
    if (SESSION_OPTION_KEYS.includes(key)) continue;

    const hint = OPTION_HINTS[key] ? ` - did you mean "${OPTION_HINTS[key]}"?` : '';
    throw new TypeError(
      `CloudCanvasSession: unknown option "${key}"${hint}`
      + ` (known options: ${SESSION_OPTION_KEYS.join(', ')})`
    );
  }
  return true;
}

/** `Node.ELEMENT_NODE`, named rather than assumed present on a bare object. */
const ELEMENT_NODE = 1;

/** A supplied value described by its kind, for an error message to quote back. */
function describeContainer(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'an empty string';
  return typeof value;
}

/**
 * Reject a `container` the session cannot mount into.
 *
 * `container` is optional - omit it entirely to mount later with `session.mount()`.
 * But a container that is *present and wrong* - `null` from a `getElementById`
 * that missed, a plain object, an empty selector - is exactly the silent no-op
 * this option surface exists to end: it built a session that mounted nothing,
 * rendered nothing, and reported nothing. The value is therefore checked only
 * when the key is supplied, against the same rule `mount()` resolves against: a
 * non-empty selector string, or a DOM element. Defaulting to `document.body`
 * instead would hide the same bug one level down, so it does not.
 *
 * @param {*} container the supplied option value
 * @returns {true}
 * @throws {TypeError} when `container` is neither a non-empty selector nor an element
 */
export function assertValidContainer(container) {
  if (typeof container === 'string' && container.length > 0) return true;
  if (container && container.nodeType === ELEMENT_NODE) return true;

  throw new TypeError(
    'CloudCanvasSession: option "container" must be a non-empty selector string'
    + ` or a DOM element, received ${describeContainer(container)}`
    + ' - omit it entirely to mount later with session.mount()'
  );
}
