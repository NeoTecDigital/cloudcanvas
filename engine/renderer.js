/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * ConjugateRenderer: the single authority over DOM membership and per-frame work.
 *
 * One frame runs three ordered phases, never interleaving reads with writes:
 *   1. structure flush - mount/unmount Pins, replay pre-attach invalidations
 *   2. read phase      - batched `offsetWidth/offsetHeight` measurement
 *   3. write phase     - content updates for dirty Pins only, a position diff
 *                        across every mounted Pin, the plane transform when the
 *                        viewport version moved, and the global SVG groups
 *
 * Nothing here rewrites a Pin's root element: display work targets the Pin's
 * content node, so mounted child Pins are structurally safe from content churn.
 *
 * The structure flush is where reload strategies are executed: each dirty Pin
 * resolves to `mounted`, `dormant`, or `unmounted` (see `src/pins/reload.js` for
 * the policy and `./mounting.js` for the mechanics).
 *
 * `activeSet` is *ownership* (which Pins this renderer is responsible for);
 * `liveSet` is *participation* (which of them get per-frame work). A dormant Pin
 * leaves `liveSet` but keeps its renderer, so it can be invalidated and woken.
 *
 * A *render root* narrows participation further: with one set, only the promoted
 * Pin's subtree and its full ancestor chain (the navigable breadcrumb) resolve to
 * their own reload mode; everything else demotes exactly as if it had gone
 * inactive. That is the whole of root promotion - no bespoke DOM path.
 */
import { SvgGroupLayer } from './svg-groups.js';
import { MotionHintSet } from './motion-hint.js';
import { ScopeWellPass, isFlowParent } from './scope-well.js';
import { OffloadPass, DEFAULT_OFFLOAD_MARGIN, runOffloadSweep } from './offload.js';
import {
  MAX_DEPTH,
  RenderRootScope,
  applyMode,
  flushStructure,
  isDormant
} from './mounting.js';

export { MOVING_CLASS, MOVING_IDLE_FRAMES } from './motion-hint.js';

export class ConjugateRenderer {
  constructor(options = {}) {
    this.session = options.session || null;
    this.planeElement = options.planeElement || null;

    /** Trait index source for the global SVG pass; falls back to the session's. */
    this.pinManager = options.pinManager || null;

    /** Persistent `<g data-trait>` groups in the session's SVG layer. */
    this.svgLayer = new SvgGroupLayer({ element: options.svgLayerElement || null });

    /** Promoted render root (empty = the whole canvas). */
    this.rootScope = new RenderRootScope();

    /**
     * Pins whose geometry or contents changed during the current frame. Rebuilt
     * every frame and consumed by the global SVG pass, which is the only
     * consumer that needs to know *what* moved rather than just *that* it did.
     */
    this._frameDirty = new Set();
    this._isGlobalDirty = this.isGlobalDirty.bind(this);

    /** @type {Set<Pin>} every Pin this renderer owns */
    this.activeSet = new Set();
    /** @type {Set<Pin>} owned Pins that take part in per-frame work */
    this.liveSet = new Set();
    /** @type {Set<Pin>} Pins whose contents changed since the last frame */
    this.dirtyContent = new Set();
    /** @type {Set<Pin>} Pins needing (re)mounting or a structural rebuild */
    this.dirtyStructure = new Set();
    /** @type {Set<Pin>} Pins to measure in the next read phase */
    this.measureQueue = new Set();

    /** Incremented by the session whenever the camera moved. */
    this.viewportVersion = 0;
    this._appliedViewportVersion = -1;

    /** pin -> Float64Array(3) of the last transform written for it */
    this._appliedPos = new WeakMap();

    /** Measured `min-height` + `cc-populated` for every scope container. */
    this.scopeWells = new ScopeWellPass();

    /** `cc-moving`: the compositor hint, granted while a Pin is in motion. */
    this.motionHints = new MotionHintSet();

    /** Viewport-driven DOM virtualization for `offload` Pins (`./offload.js`). */
    this.offloadPass = new OffloadPass();
    /** @type {Set<Pin>} owned Pins that opted into offload; the sweep's whole input. */
    this._offloadPins = new Set();
    /** Session-level offload margin; a per-Pin `offloadMargin` overrides it. */
    this._offloadMargin = typeof options.offloadMargin === 'number'
      ? options.offloadMargin
      : DEFAULT_OFFLOAD_MARGIN;
    /** A newly adopted offload Pin forces one sweep even under a still camera. */
    this._offloadPending = false;

    /** Stable per-frame closures, so the write phase allocates no functions. */
    this._isLive = (pin) => this.liveSet.has(pin);
    this._onWellWritten = (parent) => this._afterWellWritten(parent);

    this.frameCount = 0;
  }

  /* ------------------ MEMBERSHIP ------------------ */

  /**
   * Adopt a Pin: it is mounted, measured, and rendered on the next frame, and
   * any invalidation it recorded before the renderer existed is replayed.
   */
  attach(pin) {
    if (!pin || this.activeSet.has(pin)) return false;

    this.activeSet.add(pin);
    pin._renderer = this;

    // An offload Pin joins the sweep and forces one evaluation next frame, so a
    // Pin created off-screen is torn down without waiting for the first pan.
    if (pin.offload) {
      this._offloadPins.add(pin);
      this._offloadPending = true;
    }

    this.dirtyStructure.add(pin);
    this.dirtyContent.add(pin);
    if (pin.element) this.measureQueue.add(pin);

    if (typeof pin.takePendingInvalidations === 'function') {
      for (const kind of pin.takePendingInvalidations()) {
        this.invalidate(pin, kind);
      }
    }
    return true;
  }

  /** Drop a Pin from every set. Idempotent; leaves the DOM untouched. */
  forget(pin) {
    if (!pin) return false;

    const owned = this.activeSet.delete(pin);
    this.liveSet.delete(pin);
    this.dirtyContent.delete(pin);
    this.dirtyStructure.delete(pin);
    this.measureQueue.delete(pin);
    this._offloadPins.delete(pin);
    this._appliedPos.delete(pin);
    this.motionHints.delete(pin);
    // A vanished child still changes the well it was sitting in.
    this.scopeWells.invalidate(pin.parent);
    if (pin._renderer === this) pin._renderer = null;

    return owned;
  }

  isAttached(pin) {
    return this.activeSet.has(pin);
  }

  /** True when a Pin takes part in per-frame work (mounted and awake). */
  isLive(pin) {
    return this.liveSet.has(pin);
  }

  /**
   * Point the renderer at the canvas plane. Every owned Pin is re-mounted on the
   * next frame and the plane transform is rewritten.
   */
  setPlaneElement(element) {
    this.planeElement = element || null;
    this._appliedViewportVersion = -1;
    this._reconcileAll();
    return this.planeElement;
  }

  /** Point the global SVG pass at the session's `.cloudcanvas-svg-layer`. */
  setSvgLayerElement(element) {
    // A fresh layer has no camera transform on it yet.
    this._appliedViewportVersion = -1;
    return this.svgLayer.setElement(element);
  }

  /* ------------------ RENDER ROOT ------------------ */

  /** The promoted render root, or null when the whole canvas renders. */
  get renderRoot() {
    return this.rootScope.pin;
  }

  /**
   * Promote a Pin to render root, or restore the whole canvas with `null`.
   *
   * Everything outside the promoted subtree and its breadcrumb demotes per its
   * own reload strategy on the next structure flush - the same flush, the same
   * policy, and the same three DOM states as every other membership change.
   *
   * @returns {Pin|null} the new render root
   */
  setRenderRoot(pin = null) {
    if (this.rootScope.set(pin)) this._reconcileAll();
    return this.rootScope.pin;
  }

  /** Whether the current render root lets a Pin take part at all. */
  participates(pin) {
    return this.rootScope.allows(pin);
  }

  /** Queue every owned Pin for re-evaluation by the next structure flush. */
  _reconcileAll() {
    for (const pin of this.activeSet) {
      this.dirtyStructure.add(pin);
    }
    return this.dirtyStructure.size;
  }

  /* ------------------ INVALIDATION ------------------ */

  /**
   * Queue work for an owned Pin.
   * @param {'content'|'structure'} kind
   */
  invalidate(pin, kind = 'content') {
    if (kind !== 'content' && kind !== 'structure') {
      throw new TypeError(`ConjugateRenderer.invalidate: unknown kind "${kind}"`);
    }
    if (!pin || !this.activeSet.has(pin)) return false;

    if (kind === 'content') this.dirtyContent.add(pin);
    else this.dirtyStructure.add(pin);

    return true;
  }

  /**
   * Queue a Pin whose reload state changed (activation, deactivation, focus,
   * re-parenting). The strategy is executed by the next structure flush, so a
   * burst of activations costs exactly one DOM pass.
   */
  reconcile(pin) {
    return this.invalidate(pin, 'structure');
  }

  /** Queue a Pin for the next batched read phase. */
  enqueueMeasure(pin) {
    if (!pin || !pin.element) return false;
    this.measureQueue.add(pin);
    return true;
  }

  /**
   * Forget a Pin's last-applied transform, so the next write phase re-applies it
   * unconditionally. Called by `syncFlowChild` (`../pins/pin-element.js`) on every
   * crossing of the flow-child boundary: entering flow the cached value must not
   * suppress a later re-write, and leaving flow the transform the Pin now needs
   * would otherwise be skipped as unchanged against a stale cache entry.
   *
   * @returns {boolean} whether a cached position was actually dropped
   */
  clearAppliedPosition(pin) {
    return this._appliedPos.delete(pin);
  }

  /** Signal that the camera moved; the plane transform is rewritten next frame. */
  bumpViewportVersion() {
    this.viewportVersion += 1;
    return this.viewportVersion;
  }

  /* ------------------ FRAME ------------------ */

  /**
   * Execute one render frame.
   * @returns {number} the number of frames rendered so far
   */
  frame(context = {}) {
    this._frameDirty.clear();
    // Phase 0: the camera-gated offload sweep raises/lowers dormant flags via
    // structure invalidation, so this frame's flush carries the change (`./offload.js`).
    runOffloadSweep(this, context);
    this._flushStructure();
    this._readPhase();
    this._writePhase(context);
    this.frameCount += 1;
    return this.frameCount;
  }

  /**
   * Phase 1: DOM membership, in `./mounting.js` - the module that owns every
   * move of a Pin's root element.
   */
  _flushStructure() {
    return flushStructure(this);
  }

  /** Put one Pin into the DOM state a mode asks for (`./mounting.js`). */
  _applyMode(pin, mode) {
    return applyMode(this, pin, mode);
  }

  /** Phase 2: every layout read of the frame happens here, before any write. */
  _readPhase() {
    if (this.measureQueue.size === 0) return 0;

    const queued = Array.from(this.measureQueue);
    this.measureQueue.clear();

    let measured = 0;
    for (const pin of queued) {
      if (!pin.element) continue;
      // A hidden Pin has no layout box; its cached size stays authoritative.
      if (isDormant(pin)) continue;
      if (this._measure(pin)) measured += 1;
    }
    return measured;
  }

  /**
   * Measure one Pin, recording a geometry change for the global SVG pass.
   * A resize moves a Pin's bounds just as much as a translation does, so
   * connectors anchored to its centre have to be redrawn - and so does a flow
   * child whose flex/grid origin shifted without its particle moving at all.
   */
  _measure(pin) {
    const { width, height } = pin.particle;
    const offset = pin._scopeOffset;
    const scopeX = offset ? offset.x : 0;
    const scopeY = offset ? offset.y : 0;
    const flow = pin._flowOrigin;
    const wasFlow = Boolean(flow);
    const flowX = flow ? flow.x : 0;
    const flowY = flow ? flow.y : 0;

    if (!pin.measureLayout()) return false;

    const sizeChanged = pin.particle.width !== width || pin.particle.height !== height;
    const scopeChanged = Boolean(pin._scopeOffset
      && (pin._scopeOffset.x !== scopeX || pin._scopeOffset.y !== scopeY));
    const flowNow = pin._flowOrigin;
    const flowChanged = Boolean(flowNow) !== wasFlow
      || Boolean(flowNow && (flowNow.x !== flowX || flowNow.y !== flowY));

    if (sizeChanged || scopeChanged || flowChanged) this._frameDirty.add(pin);

    // A size change the write phase did not originate - a physics-driven resize, or
    // a container whose box grew as a downstream effect - also reflows the flow
    // neighbours, so re-queue them here too (the resize-via-content case is caught
    // in `_writeContents`). Bounded to one container's children and gated by this
    // compare, so it settles rather than looping (see `_reflowFlowNeighbours`).
    if (sizeChanged) this._reflowFlowNeighbours(pin);

    return true;
  }

  /**
   * Re-queue the flow children whose live origin a measured size change moved.
   *
   * `pin` resized this frame. If it is a flow container, every child it holds may
   * have been re-laid; if it is itself a flow child, its later siblings were
   * pushed along the flow axis. Either way the affected set is one container's
   * live children, so they rejoin the next read phase - which is what refreshes
   * their `_flowOrigin` (and, for a resized child, its container's own box).
   *
   * This is the flow analogue of the scope-well pass's one-level-per-frame
   * convergence: a flow subtree's measurement writes no layout (no transform for a
   * flow child, no min-height for a flow well), so re-reading it cannot change it,
   * and the upstream size-change gate stops the cascade the moment a size repeats.
   *
   * @returns {number} how many Pins were queued
   */
  _reflowFlowNeighbours(pin) {
    let container = null;
    if (isFlowParent(pin)) container = pin;
    else if (pin.parent && isFlowParent(pin.parent)) container = pin.parent;
    if (!container) return 0;

    let queued = 0;
    // A resized child grew its container's box; refresh that measurement too, so a
    // flow parent whose own size moved re-lays the rest of its children in turn.
    if (container !== pin && container.element) {
      this.measureQueue.add(container);
      queued += 1;
    }
    for (const child of container.children) {
      if (!this.liveSet.has(child) || !child.element) continue;
      this.measureQueue.add(child);
      queued += 1;
    }
    return queued;
  }

  /**
   * Phase 3: content for dirty Pins, transforms for moved Pins, plane transform
   * for a moved camera.
   */
  _writePhase(context) {
    this._writeContents(context);

    for (const pin of this.liveSet) {
      this._applyPosition(pin);
    }
    this.motionHints.sweep(this.frameCount);

    // Wells are sized from the positions written just above, and before the
    // camera transform so a scope that grew this frame is already the right
    // shape when the plane it lives on is redrawn. Nothing in the pass reads
    // layout, so the write phase stays a write phase (see ./scope-well.js).
    this.scopeWells.update({
      frameDirty: this._frameDirty,
      isLive: this._isLive,
      onWrite: this._onWellWritten
    });

    this._applyPlaneTransform(context);
    this._renderSvgGroups(context);
  }

  /**
   * A rewritten well changed its parent's box and its scope offset, so the
   * parent is measured again next frame - which is what carries the new size one
   * level further up the chain.
   */
  _afterWellWritten(parent) {
    this.measureQueue.add(parent);
    this._frameDirty.add(parent);
  }

  /**
   * Phase 3c: the global SVG pass, gated per trait group.
   * Runs last, so every group sees this frame's final geometry.
   */
  _renderSvgGroups(context) {
    const session = this.session;

    return this.svgLayer.render({
      manager: this.pinManager || (session ? session.pinManager : null),
      context,
      viewportVersion: this.viewportVersion,
      isDirty: this._isGlobalDirty
    });
  }

  /**
   * Whether a Pin's *global* geometry or contents changed this frame.
   *
   * Global bounds are cumulative over the scope chain, so an ancestor that moved
   * drags every descendant with it even though no descendant particle changed.
   *
   * Public because the frame's dirt outlives `frame()`: the session's cursor pass
   * runs immediately afterwards and gates itself on exactly this answer.
   */
  isGlobalDirty(pin) {
    let node = pin;
    for (let depth = 0; node && depth < MAX_DEPTH; depth += 1) {
      if (this._frameDirty.has(node)) return true;
      node = node.parent;
    }
    return false;
  }

  /**
   * Render contents for live, dirty Pins.
   *
   * A dirty Pin that is asleep keeps its flag rather than losing the update: it
   * renders once, on the frame it wakes up.
   */
  _writeContents(context) {
    if (this.dirtyContent.size === 0) return 0;

    const dirty = Array.from(this.dirtyContent);
    this.dirtyContent.clear();

    let rendered = 0;
    for (const pin of dirty) {
      if (!this.activeSet.has(pin) || !pin.element) continue;
      if (!this.liveSet.has(pin)) {
        this.dirtyContent.add(pin);
        continue;
      }

      pin.renderContent(context);
      // New content means a new box: measure it in the next read phase.
      this.measureQueue.add(pin);
      this._frameDirty.add(pin);
      // A re-rendered box reflows a flow container's children. This is the
      // authoritative reflow trigger for a resize: `resizePin` pre-sets the
      // particle to the new size, so `_measure`'s size-delta check below sees no
      // change and cannot fire it - but the content pass always runs for the
      // changed Pin, so the neighbours are re-queued from here.
      this._reflowFlowNeighbours(pin);
      rendered += 1;
    }
    return rendered;
  }

  /**
   * Write a Pin's transform only when its particle actually moved.
   * The comparison is three floats, so physics motion is caught without any
   * per-frame DOM read or string build for stationary Pins.
   */
  _applyPosition(pin) {
    if (!pin.element || !pin.element.style) return false;

    // A flow child (parent in a non-`free` layout) is placed entirely by its
    // parent's flex/grid flow. Writing a transform on top of its `position: relative`
    // would mis-place it, and its particle x/y are irrelevant while it flows, so
    // skip the write outright and leave `_appliedPos` untouched - `syncFlowChild`
    // clears both that cache and the stale transform on the transition, so a return
    // to free layout re-writes cleanly. The literal `'free'` (not an import) keeps
    // the engine from depending on the pins layer's module.
    const parent = pin.parent;
    if (parent && parent.layout && parent.layout !== 'free') return false;

    const particle = pin.particle;
    let applied = this._appliedPos.get(pin);

    if (applied
      && applied[0] === particle.x
      && applied[1] === particle.y
      && applied[2] === particle.z) {
      return false;
    }

    if (!applied) {
      applied = new Float64Array(3);
      this._appliedPos.set(pin, applied);
    }
    applied[0] = particle.x;
    applied[1] = particle.y;
    applied[2] = particle.z;

    pin.renderPosition();
    this.motionHints.mark(pin, this.frameCount);
    this._frameDirty.add(pin);
    return true;
  }

  /**
   * Rewrite the camera transform only when the viewport version moved.
   *
   * The SVG layer gets the *same* string as the plane. That is what makes a
   * connector correct at zoom: both are drawn in canvas coordinates and both are
   * projected by one transform, instead of the layer re-deriving screen-space
   * endpoints and drifting from the boxes it is joining.
   */
  _applyPlaneTransform(context) {
    if (this._appliedViewportVersion === this.viewportVersion) return false;

    const viewport = context.viewport || (this.session ? this.session.viewport : null);
    if (!viewport || !this.planeElement || !this.planeElement.style) return false;

    const transform = viewport.getTransformString();
    this.planeElement.style.transform = transform;

    const svgElement = this.svgLayer.element;
    if (svgElement && svgElement.style) svgElement.style.transform = transform;

    this._appliedViewportVersion = this.viewportVersion;
    return true;
  }

  /* ------------------ HELPERS ------------------ */

  /** Release every Pin. The DOM is left as-is; callers own teardown. */
  clear() {
    for (const pin of Array.from(this.activeSet)) {
      this.forget(pin);
    }
    this.dirtyContent.clear();
    this.dirtyStructure.clear();
    this.measureQueue.clear();
    this.liveSet.clear();
    this._frameDirty.clear();
    this._offloadPins.clear();
    this._offloadPending = false;
    this.offloadPass.reset();
    this.scopeWells.clear();
    this.motionHints.clear();
    this.rootScope.clear();
    this.svgLayer.clear();
  }
}
