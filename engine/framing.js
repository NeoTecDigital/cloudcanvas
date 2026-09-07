/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Framing: turning "these Pins" into "this camera".
 *
 * `Viewport.zoomToFit(bounds, hostRect, options)` does the arithmetic; this
 * module answers the question that comes before it - *which box* - and it is a
 * Pin-graph question, not a camera one. A Pin's own bounds are local to its
 * parent's scope well, so the union has to be taken over `getGlobalBounds()`,
 * and utility Pins (the cursor Pin and anything else that is machinery rather
 * than content) must not drag the frame out to wherever they happen to sit.
 *
 * Free functions taking the session first, like every other engine transition.
 */

/**
 * Whether a value is already a bounding box rather than a list of Pins.
 * `minX`/`minY` are the pair every box in the codebase carries, and the pair no
 * Pin or array has.
 */
export function isBounds(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value[Symbol.iterator] !== 'function'
    && Number.isFinite(Number(value.minX))
    && Number.isFinite(Number(value.minY));
}

/**
 * Union of the global bounds of every Pin given, or null when there are none.
 *
 * @param {Iterable<Pin>} pins
 * @returns {{minX: number, minY: number, maxX: number, maxY: number,
 *            width: number, height: number, centerX: number, centerY: number}|null}
 */
export function unionBounds(pins) {
  let box = null;

  for (const pin of pins) {
    if (!pin || typeof pin.getGlobalBounds !== 'function') continue;
    const bounds = pin.getGlobalBounds();

    if (!box) {
      box = { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY };
      continue;
    }
    box.minX = Math.min(box.minX, bounds.minX);
    box.minY = Math.min(box.minY, bounds.minY);
    box.maxX = Math.max(box.maxX, bounds.maxX);
    box.maxY = Math.max(box.maxY, bounds.maxY);
  }
  if (!box) return null;

  return {
    ...box,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
    centerX: (box.minX + box.maxX) / 2,
    centerY: (box.minY + box.maxY) / 2
  };
}

/**
 * The box a `zoomToFit` call is asking for.
 *
 * Three shapes, one answer: a bounding box is taken as given, an iterable of
 * Pins is unioned, and nothing at all means every content Pin on the canvas.
 *
 * @param {CloudCanvasSession} session
 * @param {Iterable<Pin>|object} [pinsOrBounds]
 * @returns {object|null} null when there is nothing to frame
 */
export function fitBounds(session, pinsOrBounds) {
  if (isBounds(pinsOrBounds)) return pinsOrBounds;
  if (pinsOrBounds) return unionBounds(pinsOrBounds);

  return unionBounds(contentPins(session));
}

/** Every Pin that is content rather than machinery. */
function* contentPins(session) {
  for (const pin of session.pinManager.pins.values()) {
    if (!pin.utility) yield pin;
  }
}

/**
 * Frame a set of Pins (or a box) in the host.
 *
 * Delegates the camera maths to the viewport, which owns clamping, easing and
 * reduced motion. Guarded on the method's existence rather than assuming it:
 * this call site landed with the contract and the viewport half may be one
 * commit behind, and a session that throws on `zoomToFit` is worse than one
 * that has not learned the move yet.
 *
 * @returns {object|null} the framed bounds, or null when nothing was framed
 */
export function zoomToFit(session, pinsOrBounds, options = {}) {
  const bounds = fitBounds(session, pinsOrBounds);
  if (!bounds) return null;
  if (typeof session.viewport.zoomToFit !== 'function') return null;

  session.viewport.zoomToFit(bounds, session.getHostRect(), options);
  return bounds;
}
