/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Pin contents: coercing the many accepted shapes of `contents` into the Pin's
 * `Map`, enforcing the display trait's `allowedKeys` contract on a merge, and
 * the writes themselves.
 *
 * The Map itself stays on the Pin - these are the rules for writing into it.
 * Every write ends in `pin.invalidate('content')`: contents are what a display
 * trait renders, so changing them is, by definition, a frame of work owed.
 *
 * Every function takes the Pin as its first argument.
 */

/**
 * Merge a contents argument into the Pin's Map.
 *
 * Accepted shapes: a `Map`, an array of `[key, value]` pairs, a plain object,
 * or a bare string (stored under `html`). Anything else is ignored.
 */
export function initContents(pin, contentsInput) {
  if (!contentsInput) return;

  if (contentsInput instanceof Map) {
    for (const [key, value] of contentsInput.entries()) {
      pin.contents.set(key, value);
    }
    return;
  }

  if (Array.isArray(contentsInput)) {
    for (const item of contentsInput) {
      if (Array.isArray(item) && item.length === 2) {
        pin.contents.set(item[0], item[1]);
      }
    }
    return;
  }

  if (typeof contentsInput === 'object') {
    for (const [key, value] of Object.entries(contentsInput)) {
      pin.contents.set(key, value);
    }
    return;
  }

  if (typeof contentsInput === 'string') {
    pin.contents.set('html', contentsInput);
  }
}

/** Write one content entry. */
export function setContent(pin, key, objectOrValue) {
  pin.contents.set(key, objectOrValue);
  pin.invalidate('content');
}

/**
 * Delete one content entry.
 * @returns {boolean} whether the key was there to delete
 */
export function deleteContent(pin, key) {
  const deleted = pin.contents.delete(key);
  if (deleted) pin.invalidate('content');
  return deleted;
}

/** Drop every content entry. */
export function clearContents(pin) {
  pin.contents.clear();
  pin.invalidate('content');
}

/**
 * Merge contents in, enforcing the display trait's `allowedKeys` contract.
 * A rejected merge is rolled back, so the Pin is never left half-updated.
 */
export function setContents(pin, contentsMapOrObject) {
  const previous = new Map(pin.contents);
  pin._initContents(contentsMapOrObject);

  const error = validateContents(pin);
  if (error) {
    pin.contents = previous;
    throw new Error(error);
  }

  pin.invalidate('content');
}

/** Error message from the display trait's schema, or null when contents are valid. */
export function validateContents(pin) {
  const displayTrait = pin.getDisplayTrait();
  if (!displayTrait || !displayTrait.allowedKeys || typeof displayTrait.validate !== 'function') {
    return null;
  }

  const result = displayTrait.validate(pin.contents);
  if (result && result.valid) return null;
  return (result && result.error) || `Contents rejected by trait "${displayTrait.name}"`;
}
