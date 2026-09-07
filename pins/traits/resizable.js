/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * ResizableTrait: the pointer gesture that changes a Pin's box.
 *
 * Structurally the twin of `DraggableTrait` (`./interaction.js`) - the same
 * press/threshold/release shape, the same announce-at-the-threshold discipline -
 * over a different quantity. Its own module because it carries what a drag does
 * not: eight handle elements, their visibility, and the arithmetic turning one
 * pointer delta into a box.
 *
 * Three contracts with layers that already exist:
 *
 *   - **the pointer router.** Every handle carries `data-cc-control`, so
 *     `startsOnControl` declines the deferred capture and `DraggableTrait` stands
 *     down - a handle that also dragged its own card is a handle nobody can use.
 *     The window listeners `src/engine/host.js` binds deliver the gesture, which
 *     is what carries every gesture leaving the host box anyway.
 *   - **the render pipeline.** The DOM is the size authority - see
 *     {@link resizePin}, which is the whole of that propagation.
 *   - **the signal bus.** `resize:start` / `resize:end` are declared in
 *     `PIN_SIGNAL_TYPES` (`./base.js`), so `PinManager` relays them exactly like
 *     `drag:start` / `drag:end`.
 */

import { PinTrait, emitPinSignal } from './base.js';
import { CONTROL_ATTR } from '../pin-element.js';
import { DRAG_THRESHOLD_PX } from './interaction.js';

/** Every edge and corner a Pin can be resized from. */
export const RESIZE_DIRECTIONS = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/**
 * Attribute naming a handle's direction - and how the trait recognises its *own*
 * handles: a child Pin's handle is inside this Pin's element too.
 */
export const RESIZE_HANDLE_ATTR = 'data-cc-resize-handle';

/** Class every handle element carries; the stylesheet's only hook. */
export const RESIZE_HANDLE_CLASS = 'cloudcanvas-resize-handle';

/** Class the Pin's root carries while a resize is actually changing its box. */
export const RESIZING_CLASS = 'is-resizing';

/** Smallest box a resize may leave a Pin in, unless the caller says otherwise. */
export const MIN_RESIZE = Object.freeze({ width: 40, height: 24 });

/**
 * Which edges each direction moves, as a unit step per axis: `+1` the far edge
 * follows the pointer, `-1` the *near* edge does (so the extent grows against
 * the delta and the origin moves to hold the far edge still), `0` not in play.
 *
 * One table drives handle creation, the arithmetic, and the cursor the
 * stylesheet picks - there is no eight-way branch anywhere in this file.
 */
const DIRECTION_AXES = Object.freeze({
  n: Object.freeze({ x: 0, y: -1 }),
  s: Object.freeze({ x: 0, y: 1 }),
  e: Object.freeze({ x: 1, y: 0 }),
  w: Object.freeze({ x: -1, y: 0 }),
  ne: Object.freeze({ x: 1, y: -1 }),
  nw: Object.freeze({ x: -1, y: -1 }),
  se: Object.freeze({ x: 1, y: 1 }),
  sw: Object.freeze({ x: -1, y: 1 })
});

/**
 * ResizableTrait: pointer-driven resizing from edge and corner handles.
 *
 * Opt-in, and *that is the toggle*: a Pin is resizable exactly while it holds
 * this trait. `pin.addTrait('resizable', options)` grants it,
 * `pin.removeTrait('resizable')` takes it away and its handles with it.
 *
 * Options: `directions` (subset of {@link RESIZE_DIRECTIONS}, all eight by
 * default; an unknown one throws), `minWidth`/`minHeight` ({@link MIN_RESIZE}),
 * `maxWidth`/`maxHeight` (unbounded, never below the matching floor), and
 * `alwaysVisibleHandles` (default false - see {@link handlesVisible}).
 *
 * Signals, both keyed on the drag threshold so a click on a handle is silent and
 * both mirroring their drag counterparts: `resize:start` carries
 * `{width, height, direction}`, the box being left *from*; `resize:end` carries
 * `{width, height, cancelled}`.
 */
export class ResizableTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'resizable',
      capabilities: ['interactive', 'resizable']
    });

    this.directions = normalizeDirections(options.directions);
    this.minWidth = lowerBound(options.minWidth, MIN_RESIZE.width);
    this.minHeight = lowerBound(options.minHeight, MIN_RESIZE.height);
    this.maxWidth = upperBound(options.maxWidth, this.minWidth);
    this.maxHeight = upperBound(options.maxHeight, this.minHeight);
    this.alwaysVisibleHandles = Boolean(options.alwaysVisibleHandles);

    /** @type {Map<string, Element>} direction -> handle, built on attach. */
    this.handles = new Map();

    /** Whether a press on a handle is currently live (mirrors `dragging`). */
    this.resizing = false;

    // Where the press landed, and whether it has since travelled far enough to
    // be a resize rather than a click. Both are cleared on every pointer up.
    this._downX = null;
    this._downY = null;
    this._sizing = false;

    /** The box and the canvas point the gesture started from. */
    this._origin = null;
    this._downCanvas = null;
    this._direction = null;

    /** Selection listener, kept so `onDetach` can take it back off. */
    this._onSelect = null;
  }

  /* ------------------ LIFECYCLE ------------------ */

  /**
   * Build the handles and start following the Pin's selection through the
   * `select` signal (`SelectableTrait._apply` announces it on the Pin, which is
   * an EventTarget) - so nothing here polls.
   */
  onAttach(pin) {
    this._buildHandles(pin);
    this.syncHandles(pin);

    if (typeof pin.addEventListener !== 'function') return;
    this._onSelect = () => this.syncHandles(pin);
    pin.addEventListener('select', this._onSelect);
  }

  /**
   * End any live gesture, drop the listener, and take the handles back out of
   * the DOM. `removeTrait('resizable')` must leave no residue at all.
   */
  onDetach(pin) {
    this.onPointerUp(pin);

    if (this._onSelect && typeof pin.removeEventListener === 'function') {
      pin.removeEventListener('select', this._onSelect);
    }
    this._onSelect = null;

    for (const handle of this.handles.values()) {
      if (handle.parentNode) handle.parentNode.removeChild(handle);
    }
    this.handles.clear();
  }

  /**
   * Append one handle per direction, as a direct child of the Pin's *root*.
   *
   * Deliberately not the content node, whose subtree a display trait rebuilds -
   * a handle in there vanishes on the first display-type swap - and not the
   * scope container, which holds child Pins and is measured as a well.
   *
   * @returns {number} how many handles this Pin now has
   */
  _buildHandles(pin) {
    if (!pin.element || typeof document === 'undefined') return 0;

    for (const direction of this.directions) {
      if (this.handles.has(direction)) continue;

      const handle = document.createElement('div');
      handle.className = RESIZE_HANDLE_CLASS;
      handle.setAttribute(RESIZE_HANDLE_ATTR, direction);
      handle.setAttribute(CONTROL_ATTR, 'resize');
      // Chrome, not content: a Pin is announced by its label and its contents,
      // and eight unlabelled divs in the accessibility tree are noise.
      handle.setAttribute('aria-hidden', 'true');
      handle.hidden = true;

      pin.element.appendChild(handle);
      this.handles.set(direction, handle);
    }

    return this.handles.size;
  }

  /* ------------------ HANDLE VISIBILITY ------------------ */

  /**
   * Whether the handles should currently be showing: selected-only by default,
   * which is the convention every canvas editor teaches and what keeps an idle
   * canvas clean.
   *
   * A Pin built with `selectable: false` has no selection to follow and needs
   * `alwaysVisibleHandles: true` - a stated requirement rather than a special
   * case, because a trait that guessed here would flip its own answer the moment
   * a SelectableTrait was added after it.
   */
  handlesVisible(pin) {
    if (this.alwaysVisibleHandles || this.resizing) return true;
    return Boolean(pin && pin.selected);
  }

  /**
   * Mirror {@link handlesVisible} onto every handle, through the `hidden`
   * property rather than a class: `[hidden]` is a user-agent rule and the handle
   * declares no `display`, so this holds on a page with no framework CSS at all.
   *
   * @returns {boolean} whether the handles are now visible
   */
  syncHandles(pin) {
    const visible = this.handlesVisible(pin);
    for (const handle of this.handles.values()) {
      handle.hidden = !visible;
    }
    return visible;
  }

  /* ------------------ GESTURE ------------------ */

  /**
   * Arm a resize, if the press landed on one of *this* trait's handles.
   *
   * The origin box is taken at the press, not at the threshold crossing, for the
   * same reason `DraggableTrait` measures its drag offset there: a box that
   * starts growing from the crossing point lags the pointer by the travel
   * already spent getting there, forever.
   */
  onPointerDown(pin, event, session) {
    const direction = this._directionFor(event);
    if (!direction) return;

    this.resizing = true;
    this._sizing = false;
    this._direction = direction;
    this._downX = Number.isFinite(event?.clientX) ? event.clientX : null;
    this._downY = Number.isFinite(event?.clientY) ? event.clientY : null;
    this._downCanvas = canvasPointOf(session, event);
    this._origin = {
      x: pin.particle.x,
      y: pin.particle.y,
      width: pin.particle.width,
      height: pin.particle.height
    };

    if (pin.element && pin.element.classList) {
      pin.element.classList.add(RESIZING_CLASS);
    }
  }

  /**
   * Follow the pointer, once it has actually gone somewhere. Same threshold and
   * same one-way gate as a drag: nothing changes size until the press travels
   * more than {@link DRAG_THRESHOLD_PX}, and the gate then stays open for the
   * rest of the gesture so a slow resize does not stutter back through it.
   */
  onPointerMove(pin, event, session) {
    if (!this.resizing) return;
    if (!this._sizing && !this._passedThreshold(event)) return;

    // The flip is the resize: announced once, before the first size change, so a
    // listener reads the box the Pin is being resized *from*.
    if (!this._sizing) {
      this._sizing = true;
      emitPinSignal(pin, 'resize:start', {
        width: this._origin.width,
        height: this._origin.height,
        direction: this._direction
      });
    }

    const delta = this._deltaFor(session, event);
    if (!delta) return;
    this._applyBox(pin, this._boxFor(delta));
  }

  /**
   * End the gesture, and announce the resize if there was one.
   *
   * A missing event is `DraggableTrait`'s cancellation convention: a gesture the
   * platform took away is not one the user finished.
   *
   * @param {Pin} pin
   * @param {PointerEvent} [event] absent when the resize was cancelled
   * @returns {boolean} true when `resize:end` was announced
   */
  onPointerUp(pin, event) {
    const resized = this._sizing;
    this._downX = null;
    this._downY = null;
    this._downCanvas = null;
    this._sizing = false;

    if (this.resizing) {
      this.resizing = false;
      this._direction = null;
      if (pin.element && pin.element.classList) {
        pin.element.classList.remove(RESIZING_CLASS);
      }
      this.syncHandles(pin);
    }
    this._origin = null;

    // A press that never crossed the threshold was a click: it announced no
    // `resize:start`, so it announces no end either.
    if (!resized) return false;
    return emitPinSignal(pin, 'resize:end', {
      width: pin.particle.width,
      height: pin.particle.height,
      cancelled: event === undefined
    });
  }

  /* ------------------ GEOMETRY ------------------ */

  /**
   * The direction of the handle this event landed on, or null. Identity-checked
   * against this trait's own map, so a press on a *child* Pin's handle - a
   * descendant of this element too - resizes only the child it belongs to.
   */
  _directionFor(event) {
    const target = event ? event.target : null;
    if (!target || typeof target.closest !== 'function') return null;

    const handle = target.closest(`[${RESIZE_HANDLE_ATTR}]`);
    if (!handle) return null;

    const direction = handle.getAttribute(RESIZE_HANDLE_ATTR);
    return this.handles.get(direction) === handle ? direction : null;
  }

  /**
   * Whether this move is far enough from the press to be a resize. A press with
   * no recorded origin (a synthetic event with no coordinates) is treated as
   * having passed, exactly as in `DraggableTrait`: the threshold absorbs wobble,
   * it is not a second way for a gesture to be dropped.
   */
  _passedThreshold(event) {
    if (this._downX === null || this._downY === null) return true;
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return true;
    return Math.hypot(event.clientX - this._downX, event.clientY - this._downY)
      > DRAG_THRESHOLD_PX;
  }

  /** Pointer travel since the press, in canvas units. */
  _deltaFor(session, event) {
    const point = canvasPointOf(session, event);
    if (!point || !this._downCanvas) return null;
    return { dx: point.x - this._downCanvas.x, dy: point.y - this._downCanvas.y };
  }

  /** The box this delta asks for, clamped, with the far edges held still. */
  _boxFor({ dx, dy }) {
    const axes = DIRECTION_AXES[this._direction];
    const origin = this._origin;

    const horizontal = resolveAxis(axes.x, origin.width, dx, this.minWidth, this.maxWidth, origin.x);
    const vertical = resolveAxis(axes.y, origin.height, dy, this.minHeight, this.maxHeight, origin.y);

    return {
      x: horizontal.origin,
      y: vertical.origin,
      width: horizontal.size,
      height: vertical.size
    };
  }

  /** Move and size the Pin, skipping the move when the origin did not change. */
  _applyBox(pin, box) {
    if (box.x !== pin.particle.x || box.y !== pin.particle.y) {
      pin.setPosition(box.x, box.y);
    }
    resizePin(pin, box.width, box.height);
    return box;
  }
}

/* ------------------ SIZE APPLICATION ------------------ */

/**
 * Resize a Pin: make a new box true, in the model and in the DOM.
 *
 * A free function for the same reason `rotatePin` is one - resizing is an
 * operation *on* a Pin carrying no per-Pin state, and a caller resizing
 * programmatically should not have to attach an interaction trait to do it.
 *
 * Three writes, all load-bearing; this is the whole of the
 * particle-size-to-rendered-size propagation:
 *
 *   1. **the inline size.** The renderer never *writes* a Pin's box - its read
 *      phase *reads* `offsetWidth/offsetHeight` into the particle
 *      (`measureLayout`), so `particle.setSize` alone resizes nothing on screen
 *      and is overwritten by the very next measurement. `style.width/height` is
 *      the only thing that moves layout, and `maxWidth: none` goes with it or
 *      the card's readable-measure clamp (`--cc-card-max-width`) silently caps a
 *      width the user just dragged out - the same reasoning
 *      `createDefaultElement` applies to a declared construction width.
 *   2. **the particle.** Canvas geometry has to be right *now*: the gesture's
 *      next move reads it, and a layout-less environment measures nothing back.
 *   3. **the invalidation.** `invalidate('content')` is the documented way to
 *      say "something changed that you cannot see from here". It queues the next
 *      read phase (so the DOM gets the last word on what the Pin became) *and*
 *      puts it in the frame's dirty set - which is what redraws connectors
 *      anchored to its centre and re-sizes the scope well it sits in. A geometry
 *      change the renderer is not told about is a Pin that resizes with a stale
 *      connector hanging off it.
 *
 * @returns {{width: number, height: number}} the box that was applied
 */
export function resizePin(pin, width, height) {
  writeElementSize(pin, width, height);
  pin.particle.setSize(width, height);
  pin.invalidate('content');
  return { width, height };
}

/** Write the box onto the element, clearing the card's max-width clamp with it. */
function writeElementSize(pin, width, height) {
  const style = pin.element ? pin.element.style : null;
  if (!style) return false;

  style.width = `${width}px`;
  style.height = `${height}px`;
  style.maxWidth = 'none';
  return true;
}

/* ------------------ PURE HELPERS ------------------ */

/**
 * The gesture point in canvas space. Screen pixels are the wrong unit: the plane
 * carries the camera transform, so 100px of travel is 50 canvas px at 2x. Both
 * ends go through the same `screenToCanvas` `DraggableTrait` uses, which also
 * makes the delta survive a pan mid-gesture.
 *
 * @returns {{x: number, y: number}|null}
 */
function canvasPointOf(session, event) {
  if (!session || !session.hostElement || !session.viewport) return null;
  if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return null;

  const hostRect = session.hostElement.getBoundingClientRect();
  return session.viewport.screenToCanvas(event.clientX, event.clientY, hostRect);
}

/**
 * One axis of a resize: the new extent, and where the box now starts. A negative
 * axis is a near-edge drag, so the origin absorbs whatever the extent gained or
 * lost - computed from the *clamped* size, which is what keeps the far edge
 * nailed down even while the box is pinned against its minimum.
 *
 * @returns {{size: number, origin: number}}
 */
function resolveAxis(axis, start, delta, min, max, origin) {
  if (axis === 0) return { size: start, origin };

  const size = clamp(start + axis * delta, min, max);
  return { size, origin: axis < 0 ? origin + (start - size) : origin };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * The declared directions, or all eight. An unknown one throws: a typo must
 * never silently produce a Pin that cannot be resized the way its author wrote.
 *
 * @returns {string[]}
 */
function normalizeDirections(value) {
  if (value === undefined || value === null) return [...RESIZE_DIRECTIONS];
  if (!Array.isArray(value)) {
    throw new TypeError('ResizableTrait: `directions` must be an array of direction strings');
  }

  const chosen = [];
  for (const direction of value) {
    if (DIRECTION_AXES[direction] === undefined) {
      throw new Error(`ResizableTrait: unknown resize direction "${direction}"`);
    }
    if (!chosen.includes(direction)) chosen.push(direction);
  }

  if (chosen.length === 0) {
    throw new Error('ResizableTrait: `directions` cannot be empty');
  }
  return chosen;
}

/** A positive finite floor, or the stated default. */
function lowerBound(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** A ceiling, never below the floor it has to hold above; unbounded by default. */
function upperBound(value, lower) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Infinity;
  return Math.max(number, lower);
}
