/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Wheel maths: turning a `wheel` event into pixels of intent, and pixels of
 * intent into a zoom factor.
 *
 * Pure arithmetic, no session and no DOM - which is the whole reason it lives
 * beside `./pointer.js` rather than inside it. The routing decision (zoom or
 * pan, and about which point) is plumbing and belongs there; the numbers below
 * are a specification and are tested directly.
 *
 * A `wheel` event is not a unit of anything: the same physical notch arrives as
 * pixels on one browser, lines on another, and pages on a third, and a trackpad
 * emits a stream of sub-pixel deltas that no notch ever produces. Everything
 * here converts that mess into pixels and then bounds it.
 *
 *   deltaMode 0 (pixel) x 1
 *   deltaMode 1 (line)  x LINE_HEIGHT_PX      - 16px is the CSS initial line box
 *   deltaMode 2 (page)  x host height || PAGE_HEIGHT_FALLBACK_PX
 *
 * Limits, all tunable, all documented by what they buy:
 *
 *   MAX_WHEEL_DELTA_PX   One event can never mean more than this many pixels.
 *                        Firefox page-mode and momentum spikes are the reason;
 *                        it caps a single event at exp(-0.0015*160) = 0.79x, so
 *                        a misclassified gesture is a wobble, not a teleport.
 *   WHEEL_ZOOM_K         Discrete wheel gain. The de-facto standard notch is
 *                        120px, and exp(0.0015*120) = 1.197x - the ~1.2x per
 *                        notch users expect. exp() is its own exact inverse, so
 *                        a notch out undoes a notch in bit-for-bit.
 *   PINCH_ZOOM_K         Trackpad pinch gain (ctrl/meta + wheel). ~6.7x the
 *                        wheel gain, because pinch deltas are small and
 *                        continuous and the gesture is direct manipulation.
 *   DISCRETE_WHEEL_MIN_PX
 *                        Below this a vertical delta is trackpad scrolling, not
 *                        a notch. Paired with "integer and no horizontal
 *                        component" it is the whole mouse-vs-trackpad
 *                        heuristic; when it guesses wrong the clamp above is
 *                        what keeps the mistake cheap.
 *
 * The classification is stateless: no accumulator, no timer, no per-device
 * memory.
 */

/** Pixels per line for `deltaMode === 1`. */
export const LINE_HEIGHT_PX = 16;

/** Pixels per page for `deltaMode === 2` when the host has no measured height. */
export const PAGE_HEIGHT_FALLBACK_PX = 800;

/** Largest pixel intent a single wheel event may carry, per axis. */
export const MAX_WHEEL_DELTA_PX = 160;

/** Zoom gain for a trackpad pinch (ctrl/meta + wheel), per pixel. */
export const PINCH_ZOOM_K = 0.01;

/** Zoom gain for a discrete mouse-wheel notch, per pixel. */
export const WHEEL_ZOOM_K = 0.0015;

/** Smallest vertical pixel delta that may be read as a wheel notch. */
export const DISCRETE_WHEEL_MIN_PX = 40;

/** Pixels one `delta` unit represents under a given `deltaMode`. */
export function wheelPixelsPerUnit(deltaMode, hostHeight) {
  if (deltaMode === 1) return LINE_HEIGHT_PX;
  if (deltaMode === 2) return Number(hostHeight) || PAGE_HEIGHT_FALLBACK_PX;
  return 1;
}

/** Bound one axis to +/- MAX_WHEEL_DELTA_PX. */
function clampWheelDelta(pixels) {
  return Math.min(MAX_WHEEL_DELTA_PX, Math.max(-MAX_WHEEL_DELTA_PX, pixels));
}

/**
 * A wheel event's intent in clamped pixels, on both axes.
 * @returns {{dx: number, dy: number}}
 */
export function normalizeWheelDeltas(event, hostHeight) {
  const unit = wheelPixelsPerUnit(Number(event.deltaMode) || 0, hostHeight);
  return {
    dx: clampWheelDelta((Number(event.deltaX) || 0) * unit),
    dy: clampWheelDelta((Number(event.deltaY) || 0) * unit)
  };
}

/**
 * Whether an unmodified wheel event looks like a mouse notch rather than a
 * trackpad scroll: a non-pixel deltaMode is always a notch, and in pixel mode a
 * notch is vertical-only, large, and a whole number of pixels.
 */
export function isDiscreteWheel(event) {
  if ((Number(event.deltaMode) || 0) !== 0) return true;

  const dy = Number(event.deltaY) || 0;
  return (Number(event.deltaX) || 0) === 0
    && Math.abs(dy) >= DISCRETE_WHEEL_MIN_PX
    && Number.isInteger(dy);
}

/**
 * Scale multiplier for `deltaPx` of zoom intent.
 *
 * Exponential rather than linear so that zoom is scale-invariant (a notch means
 * the same *proportion* at every scale) and exactly reversible: the product of
 * `f(d)` and `f(-d)` is 1.
 */
export function wheelZoomFactor(deltaPx, gain) {
  return Math.exp(-deltaPx * gain);
}
