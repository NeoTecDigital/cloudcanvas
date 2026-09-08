/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Interaction traits: dragging, selection, focus/zoom targeting, and physics drift.
 */

import { PinTrait, emitPinSignal } from './base.js';
import { CONTROL_SELECTOR, isControlTarget } from '../pin-element.js';
import { reparentPin, reorderChild, insertionSiblingFor } from '../reparent.js';
import { droppablePinAt } from '../../engine/hit-test.js';

/** Largest pointer travel (px) that still counts as a click rather than a drag. */
const CLICK_TRAVEL_PX = 5;

/**
 * Pointer travel (px) a press must exceed before the Pin starts translating.
 *
 * Strictly below `CLICK_TRAVEL_PX`, and deliberately so: the band between them
 * is the wobble a real click carries, and both guards have to agree that it is
 * still a click. A press that never leaves it leaves the Pin exactly where it
 * was *and* still focuses it through `FocussableTrait`.
 */
export const DRAG_THRESHOLD_PX = 3;

/**
 * FocussableTrait: Enables zooming into the scope of a Pin as the active/parent view.
 *
 * The reticle this trait used to draw for itself is now the session's
 * `cursor-focus` cursor (`src/pins/cursor.js`): one reticle for one focus,
 * reskinnable by re-registering the definition rather than by configuring every
 * focussable Pin.
 *
 * Options:
 *   - `padding`, `maxZoom` - how the camera frames the Pin when it is focused.
 *   - `focusOnClick` - whether a click that barely moved focuses it at all.
 *   - `promote` (default `true`) - whether that click *zooms into* the Pin,
 *     making it the render root with a breadcrumb back out, or merely points the
 *     camera at it. Promotion is the default because it is what "zoom into this
 *     Pin" has always meant here; `{promote: false}` is the camera-only look.
 */
export class FocussableTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'focussable',
      capabilities: ['focussable', 'zoom-target']
    });
    this.padding = options.padding !== undefined ? Number(options.padding) : 50;
    this.maxZoom = options.maxZoom !== undefined ? Number(options.maxZoom) : 3.0;
    this.focusOnClick = Boolean(options.focusOnClick);
    this.promote = options.promote !== false;

    // Pointer-down origin, used to tell a click apart from a drag.
    this._downX = null;
    this._downY = null;
  }

  /**
   * Record where the gesture started. The session routes pointer events to
   * traits, so focus-on-click needs no DOM listener of its own.
   */
  onPointerDown(pin, event) {
    this._downX = Number.isFinite(event?.clientX) ? event.clientX : null;
    this._downY = Number.isFinite(event?.clientY) ? event.clientY : null;
  }

  /** Focus the Pin when the pointer barely moved between down and up. */
  onPointerUp(pin, event, session) {
    const downX = this._downX;
    const downY = this._downY;
    this._downX = null;
    this._downY = null;

    if (!this.focusOnClick || !session) return;
    if (downX === null || downY === null) return;
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return;

    const dx = event.clientX - downX;
    const dy = event.clientY - downY;
    if (Math.hypot(dx, dy) < CLICK_TRAVEL_PX) {
      session.focus(pin, { promote: this.promote });
    }
  }

  onFocus(pin, session) {
    pin.activate(session ? session.getContext() : {});
  }

  onUnfocus(pin, session) {}
}

/**
 * Class the chromeless grab handle carries; the stylesheet's only hook.
 *
 * The mirror image of `RESIZE_HANDLE_CLASS`: that handle *is* `data-cc-control`
 * so the drag stands down on it, and this one is deliberately not, because
 * initiating a drag is its entire job (`./pin-element.js`, `CONTROL_SELECTOR`).
 */
export const GRAB_HANDLE_CLASS = 'cloudcanvas-grab-handle';

/**
 * DraggableTrait: Adds pointer drag interaction to a Pin.
 *
 * Announces two Pin signals (`PIN_SIGNAL_TYPES` in `./base.js`), both keyed on
 * the drag *threshold* rather than on the press, so a click is silent:
 *
 *   - `drag:start` - payload `{x, y}`, the canvas position the Pin left from,
 *   - `drag:end`   - payload `{x, y, cancelled}`, its final canvas position.
 *
 * It also owns the *chromeless grab handle*. With `chrome: false` a Pin's own
 * surface is often a real control (`<button>`, `<input>`) that this trait
 * correctly refuses to drag - so there would be nothing left to grab. The handle
 * is a small drag-initiating overlay at a corner, present only while the Pin is
 * chromeless and visible only while it is also selected. Its wiring mirrors
 * `ResizableTrait`'s handles exactly: a direct child of the root (so it rides the
 * Pin's transform and a content re-render never removes it), shown through the
 * `hidden` property, and driven off the one `select` signal rather than a poll.
 *
 * Options:
 *   - `reparentOnDrop` (default `true`) - whether a drop whose release point
 *     lands inside another Pin's scope *re-parents* the Pin into it (and, in a
 *     flow container, re-orders it). `false` makes a drop purely positional: the
 *     Pin stays exactly where it was let go and keeps its parent, so nesting is
 *     never an accident of where a drag happened to end. For a graph whose edges
 *     are the only structure and where a node dropped on a node must not become
 *     its child - the seam that replaces a consumer committing the reparent and
 *     then reversing it on the next frame.
 */
export class DraggableTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'draggable',
      capabilities: ['interactive', 'movable']
    });
    this.dragging = false;
    this.dragOffset = { x: 0, y: 0 };

    // Whether a drop that lands in another scope reparents (and reorders in a
    // flow container), or is purely positional. Default true is the historical
    // behaviour; `false` is the graph-node opt-out (see the class header).
    this.reparentOnDrop = options.reparentOnDrop !== false;

    // Where the press landed, and whether it has since travelled far enough to
    // be a drag rather than a click. Both are cleared on every pointer up.
    this._downX = null;
    this._downY = null;
    this._translating = false;

    /** The chromeless grab handle, built lazily and only while chrome is off. */
    this._grabHandle = null;

    /** Selection listener, kept so `onDetach` can take it back off. */
    this._onSelect = null;
  }

  /**
   * Start following the Pin's selection through the `select` signal - the exact
   * mechanism `ResizableTrait` uses - and reconcile the grab handle to the Pin's
   * current chrome and selection at once, so a trait added to an already
   * chromeless, already selected Pin shows its handle immediately.
   */
  onAttach(pin) {
    if (typeof pin.addEventListener === 'function') {
      this._onSelect = () => this._syncGrabHandle(pin);
      pin.addEventListener('select', this._onSelect);
    }
    this._syncGrabHandle(pin);
  }

  /**
   * Re-run the grab handle's reconcile on every content render.
   *
   * This is the hook a *live* `chrome` toggle arrives through: the chrome setter
   * ends in `invalidate('content')`, so this fires afterwards and adds or removes
   * the handle to match. For a chromed Pin - almost all of them - it is a single
   * flag test and returns, building nothing.
   */
  onRender(pin) {
    this._syncGrabHandle(pin);
  }

  /**
   * Begin a drag - unless the press landed somewhere the platform owns.
   *
   * Two exemptions, drawn by the two predicates in `../pin-element.js` so the
   * pointer router and this trait can never disagree:
   *
   *   - `_ccTextRegion` is written by the pointer router (`TEXT_REGION_FLAG` in
   *     `src/engine/pointer.js`), which is the only layer that can see where in
   *     the document the press landed. Standing down leaves the press to the
   *     platform, so it places a caret and a drag across the text selects it.
   *   - a press on a real control (`isControlTarget`) is the page's: the card
   *     template ships an action button, and a button that moves the card it
   *     sits on is a button nobody can press. This is the same list the router
   *     declines to capture the pointer stream for.
   *
   * The Pin is still draggable by its chrome: the card's padding, its header
   * row, and every part of the shell outside the content node.
   */
  onPointerDown(pin, event, session) {
    if (event && event._ccTextRegion === true) return;
    if (isControlTarget(event ? event.target : null)) return;

    this.dragging = true;
    this._translating = false;
    this._downX = Number.isFinite(event?.clientX) ? event.clientX : null;
    this._downY = Number.isFinite(event?.clientY) ? event.clientY : null;

    if (pin.element && pin.element.classList) {
      pin.element.classList.add('is-dragging');
    }
    // Measured at the press, not at the first move past the threshold: the
    // offset is what makes the Pin follow the pointer *exactly* once it starts,
    // including the travel already spent crossing the threshold.
    const hostRect = session.hostElement.getBoundingClientRect();
    const canvasPos = session.viewport.screenToCanvas(event.clientX, event.clientY, hostRect);
    this.dragOffset = {
      x: canvasPos.x - pin.particle.x,
      y: canvasPos.y - pin.particle.y
    };
  }

  /**
   * Follow the pointer, once it has actually gone somewhere.
   *
   * A press is never perfectly still - a mouse click carries a pixel or two of
   * wobble, and a touch carries more - so translating from the first move makes
   * every click nudge the card. Nothing moves until the press has travelled
   * more than {@link DRAG_THRESHOLD_PX}; after that the gate stays open for the
   * rest of the gesture, so a slow drag does not stutter back through it.
   */
  onPointerMove(pin, event, session) {
    if (!this.dragging) return;
    if (!this._translating && !this._passedThreshold(event)) return;

    // The flip is the drag: announced once, before the first translation, so a
    // listener reads the position the Pin is being dragged *from*.
    if (!this._translating) {
      this._translating = true;
      emitPinSignal(pin, 'drag:start', { x: pin.particle.x, y: pin.particle.y });
    }

    const hostRect = session.hostElement.getBoundingClientRect();
    const canvasPos = session.viewport.screenToCanvas(event.clientX, event.clientY, hostRect);
    pin.setPosition(
      canvasPos.x - this.dragOffset.x,
      canvasPos.y - this.dragOffset.y
    );
  }

  /**
   * Whether this move is far enough from the press to be a drag.
   *
   * A press with no recorded origin (a synthetic event carrying no coordinates)
   * is treated as having passed: the threshold exists to absorb wobble, not to
   * become a second way for a drag to be silently dropped.
   */
  _passedThreshold(event) {
    if (this._downX === null || this._downY === null) return true;
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return true;
    return Math.hypot(event.clientX - this._downX, event.clientY - this._downY)
      > DRAG_THRESHOLD_PX;
  }

  /**
   * End the gesture, and announce the drag if there was one.
   *
   * The signal is emitted last, after the Pin's final `setPosition` has already
   * been applied by the last move, so `detail.payload` is the position the Pin
   * actually came to rest at rather than one frame behind it.
   *
   * A missing event is the cancellation convention: `cancelDrag` and `onDetach`
   * both call this as `onPointerUp(pin)`, and a drag the platform took away is
   * not a drag the user finished.
   *
   * @param {Pin} pin
   * @param {PointerEvent} [event] absent when the drag was cancelled
   * @param {CloudCanvasSession} [session] absent on the cancellation path
   * @returns {boolean} true when `drag:end` was announced
   */
  onPointerUp(pin, event, session) {
    const translated = this._translating;
    this._downX = null;
    this._downY = null;
    this._translating = false;

    if (this.dragging) {
      this.dragging = false;
      if (pin.element && pin.element.classList) {
        pin.element.classList.remove('is-dragging');
      }
    }

    // A press that never crossed the threshold was a click: it announced no
    // `drag:start`, so it announces no end - and it reparents nothing.
    if (!translated) return false;

    // A finished drag may have come to rest inside another Pin's scope, or out
    // on open canvas: promote the plain move into a reparent when the release
    // point resolves to a scope other than the one the Pin is already in.
    this._resolveDrop(pin, event, session);

    return emitPinSignal(pin, 'drag:end', {
      x: pin.particle.x,
      y: pin.particle.y,
      cancelled: event === undefined
    });
  }

  /**
   * Reparent the Pin when its release point lands in a different scope.
   *
   * The point handed to `reparentPin` is the Pin's own current canvas-space
   * top-left - the drag already moved it there - so a reparent keeps it exactly
   * where the user let go, with no visible jump. The same hit-test the Sandbox's
   * placement-time container drop uses (`droppablePinAt`) resolves the deepest
   * Pin under the release, skipping the dragged Pin's own subtree.
   *
   * `target === pin.parent` is the regression lock: an ordinary drag that ends
   * over empty root canvas (both null) or back inside its current parent does
   * nothing here, so it stays the plain move the last `onPointerMove` already
   * committed. A cancelled drag (no event) or one routed without a session -
   * `cancelDrag`, `onDetach` - never reparents: it was not a drop.
   *
   * One case intercepts the regression lock: a drop back inside a *flow* container
   * the Pin already belongs to is a reorder, not a no-op. See {@link _resolveReorder}.
   *
   * `reparentOnDrop: false` short-circuits the whole resolution: the Pin keeps
   * the parent and order it had, and the last `onPointerMove` is left as the only
   * effect of the drop - it moved, it did not nest.
   *
   * @returns {boolean} whether the Pin was reparented or reordered
   */
  _resolveDrop(pin, event, session) {
    if (event === undefined || !session) return false;
    if (!this.reparentOnDrop) return false;

    const target = droppablePinAt(session, event, { ignore: pin });

    // A drop inside the flow container the Pin already belongs to reorders it
    // among its siblings rather than reparenting (same parent) or doing nothing.
    if (this._resolveReorder(pin, target, event)) return true;

    if (target === pin.parent) return false;

    const corner = pin.getGlobalBounds();
    reparentPin(pin, target, { x: corner.minX, y: corner.minY });
    return true;
  }

  /**
   * Reorder the Pin within its own flow container when the drop landed inside it.
   *
   * The trigger is narrow and deliberate: the Pin's parent must be a flow
   * container (`layout !== 'free'`) and the drop target must resolve to that same
   * container - either the well itself (dropped on open space, appended to the
   * end) or one of its direct children (a sibling, inserted before/after by the
   * drop point against that sibling's midpoint on the layout's main axis). A drop
   * that leaves the container falls through to the reparent path; a Pin in a free
   * container never reaches here, so ordinary dragging is untouched.
   *
   * @returns {boolean} whether the Pin was reordered
   */
  _resolveReorder(pin, target, event) {
    const container = pin.parent;
    if (!container || container.layout === 'free') return false;
    if (target !== container && (!target || target.parent !== container)) return false;

    reorderChild(container, pin, insertionSiblingFor(container, pin, event));
    return true;
  }

  onDetach(pin) {
    this.onPointerUp(pin);

    if (this._onSelect && typeof pin.removeEventListener === 'function') {
      pin.removeEventListener('select', this._onSelect);
    }
    this._onSelect = null;
    this._removeGrabHandle();
  }

  /* ------------------ CHROMELESS GRAB HANDLE ------------------ */

  /**
   * Bring the grab handle into line with the Pin's chrome, its surface and its
   * selection.
   *
   * Existence is gated on {@link _needsGrabHandle}: a chromeless Pin whose own
   * surface is a real control gets a handle, everything else has it removed from
   * the DOM outright (matching how `removeTrait` fully removes resize handles,
   * never just hides them). A chromeless *non*-control - a divider, a bare adopted
   * section - is already draggable by its whole surface and needs nothing. Once it
   * exists, visibility tracks selection through the same `hidden` property the
   * resize handles use.
   *
   * @returns {boolean} whether the handle is now visible
   */
  _syncGrabHandle(pin) {
    if (!this._needsGrabHandle(pin)) {
      this._removeGrabHandle();
      return false;
    }

    const handle = this._ensureGrabHandle(pin);
    if (!handle) return false;

    const visible = Boolean(pin.selected);
    handle.hidden = !visible;
    return visible;
  }

  /**
   * Whether this Pin needs a grab handle at all: chromeless, with a control for a
   * surface.
   *
   * The feature exists for exactly one situation - `chrome: false` and the Pin's
   * content is a real control (`<button>`, `<input>`, a `data-cc-control` widget)
   * that `onPointerDown` stands down on, leaving nothing to drag by. The control
   * is read as the content node's first element child, which is where every lib
   * widget builds it (`contentEl.replaceChildren(root)`); a chromed Pin, or a
   * chromeless one whose surface is ordinary markup, is draggable already and is
   * skipped. The framework's own root children - the resize handles, this handle -
   * are never mistaken for it, because it looks *inside* the content node only.
   *
   * @returns {boolean}
   */
  _needsGrabHandle(pin) {
    if (!pin || pin.chrome !== false || !pin.element) return false;

    const content = pin.contentElement;
    const surface = content ? content.firstElementChild : null;
    return Boolean(
      surface
      && typeof surface.matches === 'function'
      && surface.matches(CONTROL_SELECTOR)
    );
  }

  /**
   * Build the handle once, as a direct child of the Pin's *root* - never the
   * content node a display trait rebuilds, and never carrying `data-cc-control`,
   * which is what leaves it a normal drag-initiating surface.
   *
   * @returns {Element|null} the handle, or null in headless mode
   */
  _ensureGrabHandle(pin) {
    if (this._grabHandle) return this._grabHandle;
    if (!pin.element || typeof document === 'undefined') return null;

    const handle = document.createElement('div');
    handle.className = GRAB_HANDLE_CLASS;
    // Chrome, not content: the Pin is announced by its control and its label, and
    // an unlabelled grip div in the accessibility tree is noise.
    handle.setAttribute('aria-hidden', 'true');
    handle.hidden = true;

    pin.element.appendChild(handle);
    this._grabHandle = handle;
    return handle;
  }

  /** Take the handle back out of the DOM; a chromed Pin carries none at all. */
  _removeGrabHandle() {
    if (!this._grabHandle) return;
    if (this._grabHandle.parentNode) {
      this._grabHandle.parentNode.removeChild(this._grabHandle);
    }
    this._grabHandle = null;
  }
}

/**
 * SelectableTrait: Adds selection toggling and outline styling to a Pin
 */
export class SelectableTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'selectable',
      capabilities: ['selectable', 'focussable']
    });
    this.selected = Boolean(options.selected);
  }

  onAttach(pin) {
    this.syncClass(pin);
  }

  /**
   * Deselect on the way out, so `removeTrait('selectable')` leaves no residue.
   *
   * Routed through `_apply` rather than clearing the class by hand, for the same
   * reason `DraggableTrait`/`ResizableTrait` route their detach cleanup through
   * `onPointerUp`: the change is announced only when there is genuine state to
   * unwind. A currently-selected Pin fires `select` false - which strips the
   * `is-selected` class *and* lets the selection cursor and any co-attached
   * `Draggable`/`Resizable` handles (which follow the same signal) stand down,
   * instead of being stranded on a Pin that is no longer selectable. An
   * already-deselected Pin is a silent no-op, exactly as `_apply` guarantees.
   */
  onDetach(pin) {
    this._apply(pin, false);
  }

  select(pin) {
    this._apply(pin, true);
  }

  deselect(pin) {
    this._apply(pin, false);
  }

  toggle(pin) {
    this._apply(pin, !this.selected);
    return this.selected;
  }

  /**
   * Set the flag, mirror it into the class list, and announce the change.
   *
   * The signal is what a session-level observer - the selection cursor - reads;
   * it carries the new state as its payload, so a deselect is as visible as a
   * select. An unchanged selection announces nothing.
   */
  _apply(pin, selected) {
    if (this.selected === selected) return false;
    this.selected = selected;
    this.syncClass(pin);
    return emitPinSignal(pin, 'select', selected);
  }

  syncClass(pin) {
    if (pin.element && pin.element.classList) {
      if (this.selected) {
        pin.element.classList.add('is-selected');
      } else {
        pin.element.classList.remove('is-selected');
      }
    }
  }
}

/**
 * PhysicsTrait: Adds velocity, harmonic drift, and unpinned physics motion
 */
export class PhysicsTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'physics',
      capabilities: ['dynamic-physics', 'floatable']
    });
    this.floatDrift = options.floatDrift !== undefined ? Boolean(options.floatDrift) : true;
    this.driftIntensity = options.driftIntensity !== undefined ? Number(options.driftIntensity) : 0.4;
  }

  onAttach(pin) {
    pin.particle.pinned = false;
  }

  onDetach(pin) {
    pin.particle.pinned = true;
  }

  onTick(pin, dt) {
    if (this.floatDrift && !pin.particle.pinned && pin.active) {
      const primaryVec = pin.particle.getPrimaryVector();
      const time = Date.now() * 0.002;
      const fx = Math.sin(time + pin.particle.x * 0.01 + primaryVec) * this.driftIntensity;
      const fy = Math.cos(time + pin.particle.y * 0.01 + primaryVec) * this.driftIntensity;

      // Scale by dt so drift is an acceleration over time, not a per-frame impulse.
      pin.particle.applyForce(fx * dt, fy * dt);
    }
  }
}

/**
 * Rotate a Pin's primary vector by `deltaDeg` and mirror the result into its
 * `angle` content. Free function rather than a trait: rotation is an operation
 * on a Pin, it carries no per-Pin state to compose.
 *
 * Both writes are content writes, so both invalidate: an attached Pin repaints
 * in the next frame's write phase and an unattached one repaints synchronously,
 * exactly as `setContent` and `setVectors` promise. Rendering here as well would
 * be a third repaint the model never asked for - and, mid-edit, one the edit
 * lock has already deferred.
 *
 * Returns the normalised angle in [0, 360).
 */
export function rotatePin(pin, deltaDeg) {
  const current = Number(pin.particle.getPrimaryVector()) || 0;
  const delta = Number(deltaDeg) || 0;
  const angle = ((current + delta) % 360 + 360) % 360;

  pin.setVectors([angle, pin.particle.getVector(1)]);
  pin.setContent('angle', angle);

  return angle;
}
