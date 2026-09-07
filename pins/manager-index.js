/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * The PinManager's reverse indices: trait name -> Pins, capability -> Pins.
 *
 * A query like "every Pin carrying `connectable`" is asked once per frame by
 * the global SVG pass, so it cannot be a scan over every Pin. These are the two
 * buckets that make it a map lookup, plus the bookkeeping that keeps them exact:
 * a Pin's keys are recorded when it is indexed (`manager._indexKeys`) and
 * removed from that record, never re-derived, so a Pin whose traits changed
 * between index and unindex leaves nothing behind.
 *
 * Empty buckets are deleted rather than kept: a trait that no Pin carries any
 * more must not leave a key that iteration has to step over forever.
 *
 * Every function takes the manager as its first argument.
 */

/** Record a Pin under every trait name and capability it currently carries. */
export function indexPin(manager, pin) {
  const traitNames = new Set();
  const capabilities = new Set();

  for (const trait of (pin.traits ? pin.traits.values() : [])) {
    if (!trait || !trait.name) continue;
    traitNames.add(trait.name);
    for (const capability of (trait.capabilities || [])) {
      capabilities.add(capability);
    }
  }

  for (const name of traitNames) addEntry(manager.traitIndex, name, pin);
  for (const capability of capabilities) addEntry(manager.capabilityIndex, capability, pin);

  manager._indexKeys.set(pin, { traitNames, capabilities });
}

/** Drop every index entry belonging to a Pin, from its own recorded keys. */
export function unindexPin(manager, pin) {
  const keys = manager._indexKeys.get(pin);
  if (!keys) return;

  for (const name of keys.traitNames) removeEntry(manager.traitIndex, name, pin);
  for (const capability of keys.capabilities) removeEntry(manager.capabilityIndex, capability, pin);

  manager._indexKeys.delete(pin);
}

/** Add a Pin to one bucket, creating it on first use. */
function addEntry(index, key, pin) {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }
  bucket.add(pin);
}

/** Remove a Pin from one bucket, dropping the bucket when it empties. */
function removeEntry(index, key, pin) {
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(pin);
  if (bucket.size === 0) index.delete(key);
}
