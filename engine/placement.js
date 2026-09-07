/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Placement: where a new Pin goes when the caller does not care, only that it
 * does not land on top of something else.
 *
 * `Math.random()` is the usual answer and it is the wrong one twice over: it
 * overlaps anyway (a uniform sample knows nothing about what is already there),
 * and it makes the canvas untestable, because the same script produces a
 * different layout every run. This is the deterministic replacement: the same
 * canvas and the same request always produce the same point.
 *
 * The search is a ring spiral around an anchor. Rings, not a grid, because the
 * answer wanted is "as close to the anchor as possible" and a ring enumerates
 * candidates in exactly that order; the sample count grows with the radius so
 * angular resolution stays roughly constant as the rings get longer.
 *
 * The search itself knows nothing about where it is searching. What is occupied
 * arrives as a function, so the same ring spiral serves both scopes:
 *
 *   - no `within`: canvas space, occupancy is `session.queryBox` (the spatial
 *     index the rest of the engine uses), and the result is a *top-left* corner
 *     ready to hand straight to `createPin({ x, y })`.
 *   - `within: parent`: the parent's own scope, occupancy is its children's
 *     boxes, and the result is *parent-local* - which is the coordinate space a
 *     child Pin's particle already lives in, so it goes straight to
 *     `createPin({ parent, x, y })`.
 */

/** Rings tried before the search gives up, at radius `k * step`. */
const MAX_RINGS = 12;

/** Samples on ring `k`; more room means more places worth trying. */
const BASE_SAMPLES = 8;
const SAMPLES_PER_RING = 4;

/**
 * Ring spacing as a fraction of the box's longest side.
 *
 * Below 1 by design: consecutive rings overlap slightly, so a gap that only
 * exists between two rings is still found.
 */
const STEP_RATIO = 0.75;

/** Defaults matching the built-in card Pin, so `place(session)` alone works. */
const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 120;
const DEFAULT_MARGIN = 24;

/**
 * Find a free top-left corner for a box of `width` x `height`.
 *
 * @param {CloudCanvasSession} session
 * @param {object} [options]
 * @param {number} [options.width=200]
 * @param {number} [options.height=120]
 * @param {Pin|string} [options.within] search this Pin's scope instead of the
 *   canvas; the result is parent-local
 * @param {Pin|string} [options.near] place beside this Pin (or Pin id), read in
 *   the same space the search runs in
 * @param {{x: number, y: number}} [options.anchor] explicit centre, in the same
 *   space the search runs in
 * @param {number} [options.margin=24] clearance kept from existing Pins
 * @returns {{x: number, y: number}} top-left corner - canvas space, or
 *   parent-local when `within` was given
 */
export function place(session, options = {}) {
  const box = {
    width: positive(options.width, DEFAULT_WIDTH),
    height: positive(options.height, DEFAULT_HEIGHT),
    margin: Math.max(0, numberOr(options.margin, DEFAULT_MARGIN))
  };

  const scope = scopeFor(session, options);
  const centre = anchorFor(session, scope, options, box);
  const step = Math.max(box.width, box.height) * STEP_RATIO + box.margin;

  let candidate = corner(centre, box);
  if (isFree(scope.occupancy, candidate, box)) return candidate;

  for (let ring = 1; ring <= MAX_RINGS; ring += 1) {
    const found = searchRing(scope.occupancy, centre, ring, step, box);
    candidate = found.candidate;
    if (found.free) return candidate;
  }

  // Every ring is occupied. The last candidate is as good as any other and is
  // still a real, reachable point - refusing to place anything would be worse.
  return candidate;
}

/**
 * Walk one ring anticlockwise from angle zero.
 * @returns {{candidate: {x: number, y: number}, free: boolean}} the first free
 *          candidate, or the last one tried when the whole ring is occupied
 */
function searchRing(occupancy, centre, ring, step, box) {
  const radius = ring * step;
  const samples = BASE_SAMPLES + SAMPLES_PER_RING * ring;
  let candidate = null;

  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    candidate = corner({
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius
    }, box);

    if (isFree(occupancy, candidate, box)) return { candidate, free: true };
  }

  return { candidate, free: false };
}

/* ------------------ OCCUPANCY ------------------ */

/**
 * The space this search runs in: what is occupied, and what it is occupied by.
 *
 * Both occupancy functions answer the same question in different coordinate
 * spaces, which is the whole reason the search takes a function: a scope has no
 * entry in the canvas-wide spatial index (its children are positioned relative
 * to it), so a global query would answer about the wrong space entirely.
 *
 * The scoped boxes are snapshotted once and shared with the anchor, so the
 * search and the point it starts from can never disagree about what is there.
 *
 * @returns {{parent: Pin|null, boxes: object[]|null,
 *            occupancy: (minX: number, minY: number, maxX: number, maxY: number) => Array}}
 */
function scopeFor(session, options) {
  if (options.within === undefined || options.within === null) {
    return {
      parent: null,
      boxes: null,
      occupancy: (minX, minY, maxX, maxY) => session.queryBox(minX, minY, maxX, maxY)
    };
  }

  const parent = resolvePin(session, options.within);
  if (!parent) {
    throw new TypeError(`place: within "${idOf(options.within)}" is not a Pin in this session`);
  }

  const boxes = occupiedChildBoxes(parent);
  return {
    parent,
    boxes,
    occupancy: (minX, minY, maxX, maxY) => boxes.filter((bounds) => overlaps(bounds, minX, minY, maxX, maxY))
  };
}

/** Parent-local boxes of every child that occupies space. */
function occupiedChildBoxes(parent) {
  const boxes = [];
  for (const child of parent.children) {
    // A utility Pin is machinery, not content, exactly as `queryBox` treats it.
    if (!child || child.utility || !child.particle) continue;
    boxes.push(child.particle.getBounds());
  }
  return boxes;
}

/**
 * AABB intersection, inclusive on every edge - the same test
 * `ParticleEngine.queryBox` runs, so a scoped search and a global one agree
 * about what "touching" means.
 */
function overlaps(bounds, minX, minY, maxX, maxY) {
  return bounds.minX <= maxX && bounds.maxX >= minX && bounds.minY <= maxY && bounds.maxY >= minY;
}

/**
 * Where the search starts, in whichever space the search runs in.
 *
 * Precedence is explicit intent first, in both spaces: a caller-supplied
 * `anchor`, then the centre of the Pin the new one belongs beside. What follows
 * differs, because the two spaces have different answers to "where is the user
 * looking":
 *
 *   - canvas: the middle of the viewport, the only sensible default because a
 *     Pin placed outside it may as well not exist.
 *   - a scope: the centroid of what is already in it, so a scope fills outwards
 *     from its own contents rather than from a corner - and, for an empty scope,
 *     the top-left inset by one margin, because there is nothing to be near and
 *     a deterministic corner is what a first child wants.
 */
function anchorFor(session, scope, options, box) {
  const anchor = options.anchor;
  if (anchor && Number.isFinite(Number(anchor.x)) && Number.isFinite(Number(anchor.y))) {
    return { x: Number(anchor.x), y: Number(anchor.y) };
  }

  const near = resolvePin(session, options.near);
  if (near) return scope.parent ? localCentre(near) : globalCentre(near);
  if (!scope.parent) return viewportCentre(session);

  const centroid = centroidOf(scope.boxes);
  if (centroid) return centroid;

  // The centre whose corner is exactly (margin, margin).
  return { x: box.margin + box.width / 2, y: box.margin + box.height / 2 };
}

/** The centre of a Pin's box in its own parent's space. */
function localCentre(pin) {
  const bounds = pin.particle.getBounds();
  return { x: bounds.centerX, y: bounds.centerY };
}

/** The centre of a Pin's box in canvas space. */
function globalCentre(pin) {
  const bounds = pin.getGlobalBounds();
  return { x: bounds.centerX, y: bounds.centerY };
}

/** Mean centre of a scope's occupying children, or null when it is empty. */
function centroidOf(boxes) {
  if (!boxes || boxes.length === 0) return null;

  let x = 0;
  let y = 0;
  for (const bounds of boxes) {
    x += bounds.centerX;
    y += bounds.centerY;
  }
  return { x: x / boxes.length, y: y / boxes.length };
}

/** The canvas-space point currently at the middle of the host box. */
function viewportCentre(session) {
  const hostRect = session.getHostRect();
  const left = hostRect.left || 0;
  const top = hostRect.top || 0;
  return session.viewport.screenToCanvas(
    left + (hostRect.width || 0) / 2,
    top + (hostRect.height || 0) / 2,
    hostRect
  );
}

/** A Pin argument that may be an id, a Pin, or nothing. */
function resolvePin(session, pinOrId) {
  if (!pinOrId) return null;
  const pin = typeof pinOrId === 'string' ? session.getPin(pinOrId) : pinOrId;
  return pin && typeof pin.getGlobalBounds === 'function' ? pin : null;
}

/** How to name an unresolvable Pin argument in an error. */
function idOf(pinOrId) {
  if (typeof pinOrId === 'string') return pinOrId;
  return (pinOrId && pinOrId.id) || String(pinOrId);
}

/** The top-left corner of a box centred on `point`. */
function corner(point, box) {
  return { x: point.x - box.width / 2, y: point.y - box.height / 2 };
}

/**
 * Whether a candidate box, grown by its margin, contains nothing.
 *
 * The occupancy function is the only thing that knows what "nothing" means:
 * canvas-wide it is `session.queryBox`, the spatial index the rest of the engine
 * uses, which already drops utility Pins - a cursor has no extent and must never
 * push a real Pin out of the way. Scoped, it is the parent's children under the
 * same rule.
 */
function isFree(occupancy, topLeft, box) {
  const hits = occupancy(
    topLeft.x - box.margin,
    topLeft.y - box.margin,
    topLeft.x + box.width + box.margin,
    topLeft.y + box.height + box.margin
  );
  return hits.length === 0;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback) {
  const parsed = numberOr(value, fallback);
  return parsed > 0 ? parsed : fallback;
}
