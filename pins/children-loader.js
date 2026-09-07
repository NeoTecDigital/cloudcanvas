/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * LazyChildrenLoader: provisioning service for `reload: 'lazy'` Pins.
 *
 * A lazy Pin declares no children of its own; the first time it is required
 * (activation or focus) this loader asks a provider for `PinSpec`s and registers
 * them as its children through the manager, so the registries, indices and
 * renderer stay the single source of truth.
 *
 * Guarantees:
 *   - single-flight     : concurrent triggers share one in-flight promise
 *   - run-once          : a loaded Pin never re-runs its provider until `unload()`
 *   - failure-safe      : a rejection reports `childrenerror` and re-arms the trigger
 *   - removal-race-safe : specs resolved after the Pin was removed are discarded
 */

import { PinEvent } from './traits.js';

/** Event transmitted on a Pin whose lazy children provider rejected. */
export const CHILDREN_ERROR_EVENT = 'childrenerror';

/** Provider of last resort: nothing to load, pre-attached children just mount. */
function noChildren() {
  return [];
}

export class LazyChildrenLoader {
  /**
   * @param {PinManager} manager owner of the Pin registry the specs are created
   *        in, and holder of the session-level `options.loadChildren` provider
   */
  constructor(manager) {
    this.manager = manager;
  }

  /**
   * Resolve the provider for a Pin: its own, then the manager's (plumbed from
   * session options), then the empty default.
   *
   * The manager's provider is read per call rather than captured, so a session
   * can install or swap one after construction.
   *
   * @returns {(pin: Pin, context: Object) => (Array|Promise<Array>)}
   */
  providerFor(pin) {
    if (typeof pin.loadChildren === 'function') return pin.loadChildren;
    // Pins that keep their construction options (subclasses, adapters) may
    // carry the provider there instead.
    if (pin.options && typeof pin.options.loadChildren === 'function') {
      return pin.options.loadChildren;
    }

    const shared = this.manager && this.manager.options
      ? this.manager.options.loadChildren
      : null;
    return typeof shared === 'function' ? shared : noChildren;
  }

  /**
   * Provision a Pin's children exactly once.
   * @returns {Promise<Pin[]>} the Pins created by the provider
   */
  load(pin, context = {}) {
    if (!pin || !this._isRegistered(pin)) return Promise.resolve([]);
    if (pin._childrenLoaded) return Promise.resolve(Array.from(pin.children));
    if (pin._childrenLoading) return pin._childrenLoading;

    const provider = this.providerFor(pin);
    const flight = Promise.resolve()
      .then(() => provider(pin, context))
      .then((specs) => this._adopt(pin, specs))
      .catch((error) => this._fail(pin, error));

    pin._childrenLoading = flight;
    return flight;
  }

  /** Turn resolved specs into registered child Pins. */
  _adopt(pin, specs) {
    pin._childrenLoading = null;

    // The Pin may have been removed while the provider was in flight; its
    // children would have nowhere to live, so the result is discarded.
    if (!this._isRegistered(pin)) return [];

    pin._childrenLoaded = true;
    if (!Array.isArray(specs)) return [];

    const created = [];
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') continue;
      created.push(this.manager.createPin({ ...spec, parent: pin }));
    }
    return created;
  }

  /**
   * Report a failed provider on the Pin itself and re-arm the trigger.
   * The event bubbles up the scope chain, so an ancestor can handle loading
   * failures for a whole subtree.
   */
  _fail(pin, error) {
    pin._childrenLoading = null;
    if (!this._isRegistered(pin)) return [];

    pin.transmit(new PinEvent(CHILDREN_ERROR_EVENT, {
      payload: { error, pin },
      bubbles: true,
      source: pin
    }));
    return [];
  }

  _isRegistered(pin) {
    return Boolean(this.manager && this.manager.pins.has(pin.id));
  }
}
