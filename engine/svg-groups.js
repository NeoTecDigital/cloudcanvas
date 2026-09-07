/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * SvgGroupLayer: one persistent `<g data-trait="NAME">` per global-render trait,
 * living inside the session's `.cloudcanvas-svg-layer`.
 *
 * The layer used to be rebuilt from a concatenated string every single frame,
 * which meant every connector and reticle node in the document was destroyed and
 * re-parsed 60 times a second whether or not anything had moved. Here each trait
 * owns a group element that is created once and rewritten only when its own
 * inputs changed:
 *
 *   - the camera moved (`viewportVersion`) *and* the trait draws in screen space
 *     (`trait.screenSpace === true`); a canvas-space trait is carried by the
 *     layer's own transform and needs no rewrite for a camera move, or
 *   - a Pin carrying the trait moved, was re-measured, or was re-rendered
 *     (`isDirty`, which also reports a Pin whose *ancestor* moved, since global
 *     bounds are cumulative), or
 *   - a Pin the trait *draws to* without carrying it moved - a connector is
 *     anchored at both ends, and the far end is only knowable from inside the
 *     trait (`collectRenderDependencies`, below), or
 *   - the trait's Pin set changed size, or
 *   - a trait instance mutated its own state and said so, by bumping the
 *     `revision` counter this layer sums across the participating Pins. Nothing
 *     else can see inside a trait: a connector added between two Pins that were
 *     both already carrying `connectable` changes no geometry and no count.
 *
 * An idle frame therefore performs zero `innerHTML` assignments.
 *
 * The trait contract is untouched: `trait.onGlobalRender(pins, context)` still
 * returns an SVG string. Only the destination changed.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Capability a trait must declare to earn a group. */
export const GLOBAL_RENDER_CAPABILITY = 'global-render';

/** Never applied to a Pin; a sentinel that no real version can equal. */
const NO_VERSION = -1;

/** With no render root promoted, every Pin takes part. */
const ALLOW_ALL = () => true;

/**
 * Every trait in the manager's index that renders into the global SVG layer.
 *
 * The index is the lookup - one entry per trait name, not one per Pin - so this
 * costs O(distinct trait names) instead of the old O(pins x traits) scan.
 *
 * `allows` is the render root's participation test: a demoted Pin is dropped
 * from the list its trait is handed, so a promoted subtree draws only its own
 * geometry. The trait entry itself survives an empty list, which is what makes
 * the group render empty rather than being retired and rebuilt on the way back.
 *
 * @returns {Array<{name: string, trait: PinTrait, pins: Pin[]}>}
 */
export function globalRenderTraits(manager, allows = ALLOW_ALL) {
  const found = [];
  if (!manager || !manager.traitIndex) return found;

  for (const [name, bucket] of manager.traitIndex) {
    if (!bucket || bucket.size === 0) continue;

    const carriers = Array.from(bucket);
    const trait = carriers[0].traits.get(name);
    if (!trait || typeof trait.onGlobalRender !== 'function') continue;
    if (typeof trait.hasCapability !== 'function') continue;
    if (!trait.hasCapability(GLOBAL_RENDER_CAPABILITY)) continue;

    found.push({ name, trait, pins: carriers.filter(allows) });
  }
  return found;
}

/** The frame context's participation test, or allow-all when it carries none. */
function participationOf(context) {
  return context && typeof context.participates === 'function' ? context.participates : ALLOW_ALL;
}

/**
 * A trait entry's self-reported change signature: the sum of every participating
 * Pin's own trait-instance `revision`.
 *
 * Each instance is resolved per Pin rather than reusing `entry.trait`, because
 * carriers hold *distinct* instances of the same trait name - the entry's is
 * only the one the hook is invoked on. A trait that keeps no counter reads as 0
 * and the signature never moves, which is exactly the old behaviour.
 */
function revisionOf(entry) {
  let sum = 0;
  for (const pin of entry.pins) {
    const trait = pin.traits instanceof Map ? pin.traits.get(entry.name) : null;
    if (trait && typeof trait.revision === 'number') sum += trait.revision;
  }
  return sum;
}

/**
 * Whether any Pin a trait *draws to* changed this frame.
 *
 * A global-render trait is not confined to the Pins that carry it: a connector
 * is anchored at a carrier and at a target, and the target is nothing this layer
 * can see - it is an id inside the trait, resolved against the frame's pin map.
 * Gating on carriers alone therefore leaves a connector stale for as long as
 * only its far end moves, which is exactly what happens when a scope well grows
 * around a target after the first paint.
 *
 * The optional hook `trait.collectRenderDependencies(pin, context)` closes that:
 * a trait returns the Pins its output depends on but does not carry. It is only
 * ever called from here, after every cheaper gate has already declined, and
 * implementations are expected to refill one owned array rather than allocate -
 * so an idle frame stays allocation-free (see `ConnectableTrait`).
 */
function dependencyChanged(entry, frame) {
  for (const pin of entry.pins) {
    const trait = pin.traits instanceof Map ? pin.traits.get(entry.name) : null;
    if (!trait || typeof trait.collectRenderDependencies !== 'function') continue;

    const dependencies = trait.collectRenderDependencies(pin, frame.context);
    if (!dependencies) continue;

    for (const dependency of dependencies) {
      if (frame.isDirty(dependency)) return true;
    }
  }
  return false;
}

export class SvgGroupLayer {
  constructor(options = {}) {
    /** @type {Element|null} the `<svg>` host every group lives in */
    this.element = options.element || null;

    /** @type {Map<string, {element: Element|null, viewportVersion: number, pinCount: number}>} */
    this.groups = new Map();
  }

  /**
   * Point the layer at an `<svg>` host. Group records are dropped with the old
   * host: the elements belonged to it, so they must be rebuilt in the new one.
   */
  setElement(element) {
    const next = element || null;
    if (next === this.element) return this.element;

    this.element = next;
    this.groups.clear();
    return this.element;
  }

  /** The `<g>` for a trait name, or null when it has never been rendered. */
  getGroup(traitName) {
    const record = this.groups.get(traitName);
    return record ? record.element : null;
  }

  /**
   * Render every global trait group.
   *
   * @param {object} frame
   * @param {PinManager} frame.manager      - source of the trait index
   * @param {object}     frame.context      - the frame context handed to traits
   * @param {number}     frame.viewportVersion
   * @param {(pin: Pin) => boolean} frame.isDirty
   * @returns {number} how many groups were rewritten
   */
  render(frame) {
    if (!this.element) return 0;

    let written = 0;
    const live = new Set();

    for (const entry of globalRenderTraits(frame.manager, participationOf(frame.context))) {
      live.add(entry.name);
      if (this._renderTrait(entry, frame)) written += 1;
    }

    this._dropGroups(live);
    return written;
  }

  /** Rewrite one trait's group when - and only when - its inputs moved. */
  _renderTrait(entry, frame) {
    const record = this._record(entry.name);
    const revision = revisionOf(entry);
    if (!this._traitChanged(record, entry, revision, frame)) return false;

    record.viewportVersion = frame.viewportVersion;
    record.pinCount = entry.pins.length;
    record.revision = revision;

    const svg = entry.trait.onGlobalRender(entry.pins, frame.context) || '';
    this._element(entry.name, record).innerHTML = svg;
    return true;
  }

  /**
   * True when a trait group's rendered output can no longer be trusted.
   *
   * The cheap whole-group answers are asked first, so an idle frame costs three
   * integer comparisons per group before anything is walked and nothing at all
   * is allocated.
   *
   * The camera is the *opt-in* one. This layer carries the same transform as the
   * plane, so a trait drawing in canvas coordinates - every built-in one, the
   * connectors included - is still correct after a pan or a zoom without being
   * rewritten, and rewriting it would rebuild every path in the document on
   * every frame of a camera animation. A trait that projects to screen space
   * itself declares `screenSpace = true` and gets the old behaviour.
   */
  _traitChanged(record, entry, revision, frame) {
    const cameraMoved = record.viewportVersion !== frame.viewportVersion;
    if (cameraMoved && entry.trait.screenSpace === true) return true;
    // A group that has never been written has no version *or* count to match.
    if (record.pinCount !== entry.pins.length) return true;
    if (record.revision !== revision) return true;

    for (const pin of entry.pins) {
      if (frame.isDirty(pin)) return true;
    }
    return dependencyChanged(entry, frame);
  }

  /** Per-trait render bookkeeping; the element itself stays unbuilt until used. */
  _record(traitName) {
    let record = this.groups.get(traitName);
    if (!record) {
      record = {
        element: null,
        viewportVersion: NO_VERSION,
        pinCount: NO_VERSION,
        revision: NO_VERSION
      };
      this.groups.set(traitName, record);
    }
    return record;
  }

  /** The trait's `<g>`, created and appended on first use. */
  _element(traitName, record) {
    if (record.element) return record.element;

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-trait', traitName);
    this.element.appendChild(group);

    record.element = group;
    return group;
  }

  /** Retire groups whose trait left the index (last carrier Pin removed). */
  _dropGroups(live) {
    for (const [name, record] of Array.from(this.groups)) {
      if (live.has(name)) continue;
      if (record.element && record.element.parentNode) {
        record.element.parentNode.removeChild(record.element);
      }
      this.groups.delete(name);
    }
  }

  /** Detach every group from the layer and forget them. */
  clear() {
    for (const record of this.groups.values()) {
      if (record.element && record.element.parentNode) {
        record.element.parentNode.removeChild(record.element);
      }
    }
    this.groups.clear();
  }
}
