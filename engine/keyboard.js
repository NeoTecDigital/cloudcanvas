/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Keyboard navigation: one tab stop for the canvas, roving focus inside it.
 *
 * The session owns the state and the public surface; this module owns the
 * transitions, exactly as `./navigation.js` and `./pointer.js` do. Every
 * function takes the session as its first argument, and the state the handler
 * needs (`_keyboard`) is created by `bindKeyboard` and taken away again by
 * `unbindKeyboard`, so nothing survives a `destroy()`.
 *
 * The model is the standard composite-widget one, because `role="application"`
 * hands every key to us and must therefore return every key we take:
 *
 *   - The host is a single tab stop (`tabindex="0"`). Tab reaches the canvas,
 *     never the Pins inside it, so a keyboard user never has to tab through
 *     hundreds of cards to get past the canvas.
 *   - A Pin is `tabindex="-1"` (see `../pins/pin-element.js`): focusable
 *     programmatically, invisible to Tab. Arrow keys rove between them.
 *   - The two stages are separated by Enter (into the Pins) and Escape (back
 *     out to the host), so Escape always means "one level out" and never
 *     traps focus.
 *   - Enter enters, Space acts: Enter is navigation - on a Pin it is
 *     `session.focus(pin)`, which zooms *into* that Pin and makes it the render
 *     root, so Enter descends one scope at a time and Escape at the host stage
 *     walks the same steps back out. Space is activation (it runs the Pin's own
 *     `onAction` traits). Splitting them is what lets a Pin carry an affordance
 *     a keyboard user can trigger without leaving the roving order, and it
 *     matches the platform convention every composite widget follows.
 *
 * Roving order is *reading order* - top to bottom, then left to right - not 2D
 * spatial navigation. Spatial nav is ambiguous the moment two Pins overlap or a
 * row is ragged, and its failure mode is a Pin that can never be reached.
 * Reading order is total, stable and cheap to explain.
 */

/** Class marking a Pin's root element in the document. */
const PIN_SELECTOR = '.cloudcanvas-pin';

/** Camera pan per arrow press, in screen pixels. */
export const PAN_STEP_PX = 40;

/** Shift multiplies the pan step: coarse travel without a second binding. */
export const PAN_SHIFT_MULTIPLIER = 4;

/** Zoom ratio per `+` / `-`; matches one mouse-wheel notch (see `./pointer.js`). */
export const ZOOM_STEP = 1.2;

/** Clearance kept around a Pin brought into view by `ensureVisible`. */
export const VISIBILITY_MARGIN_PX = 24;

/** Length of the corrective pan `ensureVisible` performs, in milliseconds. */
export const ENSURE_VISIBLE_MS = 200;

/**
 * The key table, as data.
 *
 * Both maps are keyed by `KeyboardEvent.key`. `host` applies while the host
 * element itself holds focus (camera control); `pin` applies while a Pin holds
 * it (roving). A key absent from the applicable map is not handled here and
 * keeps its default behaviour - `preventDefault` is called for handled keys
 * only, so Tab, browser shortcuts and screen-reader keys still work.
 *
 * Arrow panning is content-following: ArrowRight pushes the content right, the
 * same direction convention the wheel handler uses for a two-axis scroll.
 */
export const KEY_BINDINGS = Object.freeze({
  host: Object.freeze({
    ArrowLeft: Object.freeze({ action: 'pan', dx: -1, dy: 0 }),
    ArrowRight: Object.freeze({ action: 'pan', dx: 1, dy: 0 }),
    ArrowUp: Object.freeze({ action: 'pan', dx: 0, dy: -1 }),
    ArrowDown: Object.freeze({ action: 'pan', dx: 0, dy: 1 }),
    '+': Object.freeze({ action: 'zoom', direction: 1 }),
    '=': Object.freeze({ action: 'zoom', direction: 1 }),
    '-': Object.freeze({ action: 'zoom', direction: -1 }),
    _: Object.freeze({ action: 'zoom', direction: -1 }),
    0: Object.freeze({ action: 'reset' }),
    Enter: Object.freeze({ action: 'enter-pins' }),
    Escape: Object.freeze({ action: 'back' }),
    Home: Object.freeze({ action: 'unfocus' })
  }),
  pin: Object.freeze({
    ArrowDown: Object.freeze({ action: 'step', delta: 1 }),
    ArrowRight: Object.freeze({ action: 'step', delta: 1 }),
    ArrowUp: Object.freeze({ action: 'step', delta: -1 }),
    ArrowLeft: Object.freeze({ action: 'step', delta: -1 }),
    Enter: Object.freeze({ action: 'focus' }),
    ' ': Object.freeze({ action: 'act' }),
    Escape: Object.freeze({ action: 'exit' })
  })
});

/**
 * Elements that own their own keys: text entry, native controls, and anything
 * `contenteditable`. The canvas never takes a key away from one of these.
 */
const KEY_OWNING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON']);

/* ------------------ BINDING ------------------ */

/**
 * Make the host focusable, start listening, and create the roving state.
 *
 * An author-supplied `tabindex` is left exactly as it is: a host deliberately
 * placed later in the tab order, or deliberately removed from it, is a decision
 * this module has no business overruling.
 *
 * @returns {boolean} true when a listener was registered
 */
export function bindKeyboard(session) {
  const host = session.hostElement;
  if (!host || typeof host.addEventListener !== 'function') return false;
  if (session._keyboard) unbindKeyboard(session);

  const tabindexAdded = typeof host.hasAttribute === 'function'
    && !host.hasAttribute('tabindex');
  if (tabindexAdded) host.setAttribute('tabindex', '0');

  const state = {
    /** Whether this binding is the one that made the host focusable. */
    tabindexAdded,
    /** The Pin currently holding DOM focus, or null while the host holds it. */
    pin: null,
    /** Reading order, recomputed whenever pin navigation is entered. */
    order: [],
    onKeyDown: (event) => onKeyDown(session, event)
  };

  session._keyboard = state;
  host.addEventListener('keydown', state.onKeyDown);
  return true;
}

/**
 * Stop listening, drop the roving state, and give the host its tab order back.
 *
 * The `tabindex` is removed only when this binding is what put it there - the
 * same author-values-win rule that governs writing it, read from the other end.
 */
export function unbindKeyboard(session) {
  const state = session._keyboard;
  if (!state) return false;

  const host = session.hostElement;
  if (host && typeof host.removeEventListener === 'function') {
    host.removeEventListener('keydown', state.onKeyDown);
  }
  if (host && state.tabindexAdded && typeof host.removeAttribute === 'function') {
    host.removeAttribute('tabindex');
  }
  session._keyboard = null;
  return true;
}

/* ------------------ DISPATCH ------------------ */

/**
 * Route one keydown to the camera or to the roving order.
 *
 * @returns {boolean} true when the event was handled (and defaulted away)
 */
export function onKeyDown(session, event) {
  if (!event || ownsItsKeys(event.target)) return false;

  const pin = pinForEvent(session, event);
  const binding = pin
    ? KEY_BINDINGS.pin[event.key]
    : KEY_BINDINGS.host[event.key];
  if (!binding) return false;

  const handled = pin
    ? applyPinBinding(session, binding, pin, event)
    : applyHostBinding(session, binding, event);

  if (handled && typeof event.preventDefault === 'function') event.preventDefault();
  return handled;
}

/** Camera and stage transitions, while the host itself has focus. */
function applyHostBinding(session, binding, event) {
  switch (binding.action) {
    case 'pan':
      return panByStep(session, binding, event.shiftKey === true);
    case 'zoom':
      return zoomAtCenter(session, binding.direction);
    case 'reset':
      session.unfocus();
      return true;
    case 'enter-pins':
      return enterPinNavigation(session);
    case 'back':
      if (session.focusStack.length > 0) session.popFocus();
      else session.unfocus();
      return true;
    case 'unfocus':
      session.unfocus();
      return true;
    default:
      return false;
  }
}

/** Roving and activation, while a Pin has focus. */
function applyPinBinding(session, binding, pin, event) {
  switch (binding.action) {
    case 'step':
      return stepTo(session, pin, binding.delta);
    case 'focus':
      session.focus(pin);
      return true;
    case 'act':
      return runTraitAction(session, pin, event);
    case 'exit':
      return exitPinNavigation(session);
    default:
      return false;
  }
}

/**
 * Offer Space to the Pin's traits, in attachment order, and stop at the first
 * one that takes it.
 *
 * A trait declares an affordance by implementing `onAction(pin, event, session)`
 * and returning something truthy when it consumed the press. Returning nothing
 * is how a trait says "not mine", so a Pin whose traits all decline leaves Space
 * to the page - scrolling a host that wants to scroll, rather than swallowing
 * the key to no effect.
 *
 * Consumption stops propagation as well as the default: the press was for this
 * Pin, and letting it continue to a scope ancestor's own handler would run two
 * affordances from one key.
 *
 * @returns {boolean} true when a trait consumed the press
 */
function runTraitAction(session, pin, event) {
  if (!pin || !(pin.traits instanceof Map)) return false;

  for (const trait of pin.traits.values()) {
    if (!trait || typeof trait.onAction !== 'function') continue;
    if (!trait.onAction(pin, event, session)) continue;

    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    return true;
  }

  return false;
}

/* ------------------ CAMERA ------------------ */

/** Pan one arrow step, four steps with Shift held. */
function panByStep(session, binding, shift) {
  const step = PAN_STEP_PX * (shift ? PAN_SHIFT_MULTIPLIER : 1);
  session.viewport.panBy(binding.dx * step, binding.dy * step);
  return true;
}

/**
 * Zoom about the middle of the host box.
 *
 * The pointer has a focal point of its own; the keyboard does not, and the
 * centre is the only choice that keeps what the user is looking at on screen.
 */
function zoomAtCenter(session, direction) {
  const hostRect = session.getHostRect();
  const factor = direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  session.viewport.zoomAt(factor, hostRect.width / 2, hostRect.height / 2);
  return true;
}

/* ------------------ ROVING ------------------ */

/**
 * Enter pin navigation: focus the focused Pin if there is one, otherwise the
 * first Pin in reading order.
 *
 * The order is recomputed here rather than cached across the session, because
 * Pins are created, moved, promoted and put to sleep between one entry and the
 * next; a stale order is a Pin that cannot be reached.
 *
 * @returns {boolean} true when a Pin took focus
 */
export function enterPinNavigation(session) {
  const order = refreshOrder(session);
  if (order.length === 0) return false;

  const current = session.focusedPin;
  const target = current && order.includes(current) ? current : order[0];
  return focusPinElement(session, target);
}

/** Hand focus back to the host, ending the roving stage. */
export function exitPinNavigation(session) {
  const state = session._keyboard;
  if (state) state.pin = null;

  const host = session.hostElement;
  if (!host || typeof host.focus !== 'function') return false;
  host.focus({ preventScroll: true });
  return true;
}

/** Move `delta` places through the reading order, wrapping at both ends. */
function stepTo(session, pin, delta) {
  const order = currentOrder(session, pin);
  if (order.length === 0) return false;

  const index = order.indexOf(pin);
  const next = index < 0
    ? order[0]
    : order[(index + delta + order.length) % order.length];
  return focusPinElement(session, next);
}

/**
 * The order to rove through, refreshed when the focused Pin is not in it -
 * which is what a Pin focused by a click, or a graph that changed underneath
 * the roving stage, looks like from here.
 */
function currentOrder(session, pin) {
  const state = session._keyboard;
  const order = state ? state.order : [];
  if (order.length > 0 && order.includes(pin)) return order;
  return refreshOrder(session);
}

/** Recompute the roving order and remember it on the session's keyboard state. */
function refreshOrder(session) {
  const order = readingOrder(session);
  const state = session._keyboard;
  if (state) state.order = order;
  return order;
}

/**
 * Every Pin a keyboard user can reach right now, in reading order.
 *
 * Participation is the renderer's own test, so a promoted render root narrows
 * the roving order to exactly what is on screen; sleeping Pins are excluded
 * because they are either unmounted or hidden, and a focus ring on an invisible
 * element is the worst outcome of the whole feature. Utility Pins are already
 * filtered out by the manager.
 *
 * @returns {Pin[]}
 */
export function readingOrder(session) {
  const entries = [];
  for (const pin of session.pinManager.getAllPins()) {
    if (!pin.active || !pin.element) continue;
    if (session.renderer && !session.renderer.participates(pin)) continue;
    entries.push({ pin, bounds: pin.getGlobalBounds() });
  }

  entries.sort(byReadingOrder);
  return entries.map((entry) => entry.pin);
}

/** Top to bottom, then left to right; ids break exact ties so sorts are total. */
function byReadingOrder(a, b) {
  if (a.bounds.minY !== b.bounds.minY) return a.bounds.minY - b.bounds.minY;
  if (a.bounds.minX !== b.bounds.minX) return a.bounds.minX - b.bounds.minX;
  return a.pin.id < b.pin.id ? -1 : 1;
}

/**
 * Give a Pin's element DOM focus and bring it on screen.
 *
 * `preventScroll` matters: the browser's own scroll-into-view would scroll the
 * *page*, moving the host box out from under a canvas that is perfectly capable
 * of moving its own camera instead.
 */
function focusPinElement(session, pin) {
  if (!pin || !pin.element || typeof pin.element.focus !== 'function') return false;

  pin.element.focus({ preventScroll: true });
  const state = session._keyboard;
  if (state) state.pin = pin;

  ensureVisible(session, pin);
  return true;
}

/* ------------------ VISIBILITY ------------------ */

/**
 * Pan the minimum distance that puts a Pin (plus its margin) inside the host
 * box, preserving scale.
 *
 * Scale is deliberately untouched: roving is not framing. `focus()` is what
 * zooms, and a rove that silently changed magnification would make the camera
 * impossible to reason about. A Pin larger than the host has its top-left
 * corner aligned, which is where its title is.
 *
 * Reduced motion is inherited rather than re-implemented: `animateTo` is the
 * single choke point that jumps instead of animating when the user asked for
 * less movement.
 *
 * @returns {boolean} true when a corrective pan was started
 */
export function ensureVisible(session, pin) {
  if (!pin || !session.viewport || typeof pin.getGlobalBounds !== 'function') return false;

  const hostRect = session.getHostRect();
  const viewport = session.viewport;
  const bounds = pin.getGlobalBounds();
  const topLeft = viewport.canvasToScreen(bounds.minX, bounds.minY, hostRect);
  const bottomRight = viewport.canvasToScreen(bounds.maxX, bounds.maxY, hostRect);

  const left = hostRect.left || 0;
  const top = hostRect.top || 0;
  const dx = axisCorrection(
    topLeft.x - VISIBILITY_MARGIN_PX,
    bottomRight.x + VISIBILITY_MARGIN_PX,
    left,
    left + (hostRect.width || 0)
  );
  const dy = axisCorrection(
    topLeft.y - VISIBILITY_MARGIN_PX,
    bottomRight.y + VISIBILITY_MARGIN_PX,
    top,
    top + (hostRect.height || 0)
  );

  if (dx === 0 && dy === 0) return false;

  viewport.animateTo(viewport.x + dx, viewport.y + dy, viewport.scale, {
    duration: ENSURE_VISIBLE_MS
  });
  return true;
}

/**
 * How far one axis has to move for `[min, max]` to sit inside `[lo, hi]`.
 * Zero when it already does; the leading edge wins when it cannot fit at all.
 */
function axisCorrection(min, max, lo, hi) {
  if (min >= lo && max <= hi) return 0;
  if (max - min > hi - lo) return lo - min;
  if (min < lo) return lo - min;
  return hi - max;
}

/* ------------------ TARGETS ------------------ */

/** The Pin an event came from, or null when the host itself is focused. */
function pinForEvent(session, event) {
  const element = event.target && typeof event.target.closest === 'function'
    ? event.target.closest(PIN_SELECTOR)
    : null;
  const id = element ? element.getAttribute('data-pin-id') : null;
  return id ? session.pinManager.getPin(id) || null : null;
}

/**
 * Whether the event came from something that handles its own keys.
 *
 * A text field inside a Pin owns its arrows, its Home and its Escape, and a
 * button owns its Enter; taking those for camera control would make the canvas
 * unusable as a host for real controls.
 */
function ownsItsKeys(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  return KEY_OWNING_TAGS.has(target.tagName);
}
