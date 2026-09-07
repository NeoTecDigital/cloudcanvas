/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Elevation: raising a Pin *and the scope chain above it* out of the stack.
 *
 * A z-index on a nested Pin does nothing useful on its own. Every ancestor that
 * carries a z-index opens a stacking context, and a descendant can never paint
 * outside the context it is in - so a focused child three scopes deep still
 * loses to any later root Pin unless each scope between them is raised too.
 * Elevation is therefore a property of the chain, and this is the whole of it:
 * walk `pin.parent` to the root, writing one class at every step.
 *
 * The classes themselves (`cc-elevated`, `cc-dragging`) carry the z tokens in
 * `CANVAS_DEFAULT_CSS`; nothing here knows a number.
 */
import { MAX_DEPTH } from './mounting.js';

/** Focus elevation: `--cc-z-elevated`. */
export const ELEVATED_CLASS = 'cc-elevated';

/** Drag elevation: `--cc-z-drag`, above focus so a dragged Pin clears the veil. */
export const DRAG_CHAIN_CLASS = 'cc-dragging';

/**
 * Add or remove one class across a Pin and every scope above it.
 *
 * Depth-capped like every other parent walk in the engine: a malformed cycle
 * must not hang a transition. Headless Pins (no element) are stepped over
 * rather than skipping the rest of the chain - a null-element scope between two
 * real ones is legal.
 *
 * @param {Pin|null} pin the Pin at the bottom of the chain
 * @param {string} className
 * @param {boolean} on
 * @returns {number} how many elements were written
 */
export function setElevationChain(pin, className, on) {
  if (!pin || !className) return 0;

  let written = 0;
  let node = pin;

  for (let depth = 0; node && depth < MAX_DEPTH; depth += 1) {
    const classList = node.element ? node.element.classList : null;
    if (classList) {
      if (on) classList.add(className);
      else classList.remove(className);
      written += 1;
    }
    node = node.parent;
  }

  return written;
}
