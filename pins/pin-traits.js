/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Pin trait management: resolving a trait argument into an instance, and the
 * attach / replace / detach bookkeeping that keeps a Pin's trait map, its
 * `data-trait-*` attributes, and the manager index in agreement.
 *
 * The traits themselves live in `./traits/`; this is only the Pin's side of the
 * contract. Every function takes the Pin as its first argument and calls back
 * through the Pin's own methods for anything a subclass may override.
 */
import {
  traitRegistry,
  PinTrait,
  DisplayTrait,
  DraggableTrait,
  SelectableTrait
} from './traits.js';

/**
 * Attach the traits a Pin is born with: one display trait, the two interactive
 * defaults unless they were explicitly disabled, then any extras supplied.
 */
export function initTraits(pin, options) {
  // A utility Pin has no element to display or to interact with: it gets the
  // traits it was asked for and nothing else.
  if (pin.utility) {
    for (const trait of (Array.isArray(options.traits) ? options.traits : [])) {
      pin.addTrait(trait);
    }
    return;
  }

  if (options.type) {
    pin.addTrait(options.type);
  } else if (options.displayTrait) {
    pin.addTrait(options.displayTrait);
  } else {
    pin.addTrait(new DisplayTrait({ displayType: options.content ? 'raw' : 'card' }));
  }

  if (options.draggable !== false) {
    pin.addTrait(new DraggableTrait());
  }
  if (options.selectable !== false) {
    pin.addTrait(new SelectableTrait({ selected: options.selected }));
  }

  if (Array.isArray(options.traits)) {
    for (const trait of options.traits) {
      pin.addTrait(trait);
    }
  }
}

/** Short, safe description of a rejected argument for error messages. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Resolve a trait argument into an instance.
 *
 * A string is built through the registry factory, so every Pin gets its own
 * instance and an unregistered name fails loudly. Passing an already-built
 * instance as the second argument stays supported.
 */
export function resolveTrait(pin, nameOrTrait, options) {
  if (nameOrTrait instanceof PinTrait) return nameOrTrait;

  if (typeof nameOrTrait !== 'string') {
    throw new TypeError(
      `Pin "${pin.id}": expected a trait name or PinTrait instance, received ${describeValue(nameOrTrait)}`
    );
  }

  if (options instanceof PinTrait) {
    if (options.name !== nameOrTrait) {
      throw new Error(
        `Pin "${pin.id}": trait name "${nameOrTrait}" does not match the supplied instance "${options.name}"`
      );
    }
    return options;
  }

  return traitRegistry.create(nameOrTrait, options || {});
}

/**
 * Attach a trait, by name (built from the registry) or as an instance.
 * A Pin holds at most one trait per name - use `replaceTrait` to swap one out.
 */
export function addTrait(pin, nameOrTrait, options) {
  const trait = resolveTrait(pin, nameOrTrait, options);
  if (!trait) return null;

  if (pin.traits.has(trait.name)) {
    throw new Error(`Pin "${pin.id}" already has a trait named "${trait.name}"`);
  }

  pin.traits.set(trait.name, trait);
  try {
    if (typeof trait.onAttach === 'function') {
      trait.onAttach(pin);
    }
  } catch (error) {
    // A trait that fails to attach is never left half-registered.
    pin.traits.delete(trait.name);
    throw error;
  }
  if (pin.element && pin.element.setAttribute) {
    pin.element.setAttribute(`data-trait-${trait.name}`, 'true');
  }
  pin.invalidate('structure');
  if (pin._manager) pin._manager.reindexPin(pin);
  return trait;
}

/**
 * Swap a trait for a freshly resolved one of the same name.
 * The outgoing trait's `onDetach` runs before the replacement attaches.
 */
export function replaceTrait(pin, traitOrName, options) {
  const trait = resolveTrait(pin, traitOrName, options);
  if (!trait) return null;

  if (pin.traits.has(trait.name)) {
    pin.removeTrait(trait.name);
  }
  return pin.addTrait(trait);
}

export function removeTrait(pin, traitName) {
  const trait = pin.traits.get(traitName);
  if (!trait) return false;

  if (typeof trait.onDetach === 'function') {
    trait.onDetach(pin);
  }
  if (pin.element && pin.element.removeAttribute) {
    pin.element.removeAttribute(`data-trait-${traitName}`);
  }
  const removed = pin.traits.delete(traitName);
  pin.invalidate('structure');
  if (pin._manager) pin._manager.reindexPin(pin);
  return removed;
}

/** The trait responsible for this Pin's display, or the first trait it has. */
export function getDisplayTrait(pin) {
  if (pin.primaryTrait && pin.traits.has(pin.primaryTrait.name)) {
    return pin.primaryTrait;
  }
  for (const trait of pin.traits.values()) {
    if (trait instanceof DisplayTrait || trait.hasCapability('renderable')) {
      return trait;
    }
  }
  return pin.traits.values().next().value || null;
}

/** @deprecated since 0.3.0 - use {@link getDisplayTrait}. Removed in 0.4.0. */
export function getType(pin) { return getDisplayTrait(pin); }

/**
 * Swap the Pin's display trait atomically.
 *
 * The replacement is resolved and checked for name collisions *before* the
 * outgoing display traits are detached; if attaching it still fails, the
 * previous traits are restored, so a failed type switch never leaves a Pin
 * without a renderable trait.
 *
 * A held edit lock is released once the swap is certain to happen: the new
 * display trait rebuilds the content node from scratch, so the editor the lock
 * was protecting is about to stop existing, and a lock left held over new DOM
 * would silently swallow every later render. Released after validation, not
 * before, because a swap that throws changed nothing and must leave the edit in
 * progress exactly as it was.
 */
export function setDisplayTrait(pin, traitOrName, options) {
  const trait = resolveTrait(pin, traitOrName, options);
  const outgoing = displayTraits(pin);

  for (const existing of pin.traits.values()) {
    if (existing.name === trait.name && !outgoing.includes(existing)) {
      throw new Error(`Pin "${pin.id}" already has a trait named "${trait.name}"`);
    }
  }

  if (typeof pin.endEdit === 'function') pin.endEdit();

  for (const existing of outgoing) {
    pin.removeTrait(existing.name);
  }

  try {
    pin.addTrait(trait);
  } catch (error) {
    for (const existing of outgoing) {
      pin.addTrait(existing);
    }
    throw error;
  }

  pin.primaryTrait = trait;
  return trait;
}

/** @deprecated since 0.3.0 - use {@link setDisplayTrait}. Removed in 0.4.0. */
export function setType(pin, traitOrName, options) {
  return setDisplayTrait(pin, traitOrName, options);
}

/** Every trait currently responsible for this Pin's display, primary first. */
export function displayTraits(pin) {
  const found = [];
  if (pin.primaryTrait && pin.traits.get(pin.primaryTrait.name) === pin.primaryTrait) {
    found.push(pin.primaryTrait);
  }
  for (const trait of pin.traits.values()) {
    if (found.includes(trait)) continue;
    if (trait instanceof DisplayTrait || trait.hasCapability('renderable')) {
      found.push(trait);
    }
  }
  return found;
}
