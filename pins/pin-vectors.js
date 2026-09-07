/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Pin vectors: the Pin's side of the float vector list its spatial node carries.
 *
 * The list itself lives on the particle (`../particles/pin-particle.js`), which
 * knows nothing about rendering. What lives here is the half the particle cannot
 * own: a vector is *displayed* content - the vector-pointer trait draws the
 * gradient, the card template prints the magnitude - so every mutation of the
 * list is a content change and has to reach the renderer through the same
 * invalidation contract as `setContent`. Reads pass straight through.
 *
 * Mutations that did not land invalidate nothing: an out-of-range index is a
 * no-op, not a frame of work, matching `Pin.deleteContent`.
 *
 * Every function takes the Pin as its first argument.
 */

/**
 * Append a float vector to the end of the list.
 * @returns {number} the coerced value that was appended
 */
export function addVector(pin, value) {
  const added = pin.particle.addVector(value);
  pin.invalidate('content');
  return added;
}

/** Replace the entire vector list (a non-array clears it). */
export function setVectors(pin, vectorList) {
  pin.particle.setVectors(vectorList);
  pin.invalidate('content');
}

/**
 * Replace a single vector by index.
 * @returns {number|null} the written value, or null when the index is out of range
 */
export function setVector(pin, index, value) {
  const written = pin.particle.setVector(index, value);
  if (written !== null) pin.invalidate('content');
  return written;
}

/**
 * Remove a single vector by index.
 * @returns {number|null} the removed value, or null when the index is out of range
 */
export function removeVector(pin, index) {
  const removed = pin.particle.removeVector(index);
  if (removed !== null) pin.invalidate('content');
  return removed;
}

/** Drop every vector. */
export function clearVectors(pin) {
  pin.particle.clearVectors();
  pin.invalidate('content');
}
