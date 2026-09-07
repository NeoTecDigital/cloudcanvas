/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Graph traits: Pin-to-Pin connections, event transmission/relaying, and nested scope containers.
 */

import {
  createConnectorPathSVG
} from '../../graphics/primitives/primitives.js';
import { PinEvent, PinTrait } from './base.js';

/**
 * TransmitterTrait: Programmable event dispatcher, message broadcaster, and telemetry router
 */
export class TransmitterTrait extends PinTrait {
  constructor(options = {}) {
    // Name stays caller-overridable: a Pin may carry several distinct transmitters.
    super(options, {
      name: options.name || 'transmitter',
      capabilities: ['transmitter', 'event-emitter']
    });
    this.listeners = new Map();
    this.forwardToConnections = Boolean(options.forwardToConnections);
  }

  on(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  emit(pin, typeOrEvent, payload) {
    const evt = typeOrEvent instanceof PinEvent
      ? typeOrEvent
      : new PinEvent(typeof typeOrEvent === 'string' ? typeOrEvent : 'message', { payload, target: pin });
    return pin.transmit(evt);
  }

  onTransmit(pin, event, context) {
    const type = event?.type || 'message';
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const fn of handlers) {
        fn(event, pin, context);
      }
    }

    const wildcardHandlers = this.listeners.get('*');
    if (wildcardHandlers) {
      for (const fn of wildcardHandlers) {
        fn(event, pin, context);
      }
    }

    // Optionally propagate along ConnectableTrait links
    const pinMap = context?.pinMap || (pin._manager ? pin._manager.pins : null);
    if (this.forwardToConnections && pin.traits.has('connectable') && pinMap) {
      this._relayToConnections(pin, event, { ...context, pinMap });
    }
  }

  /**
   * Forward an event one hop along this pin's connections.
   *
   * Each hop carries a `detail.relayChain` of the pin ids already visited; a pin in
   * that chain is never forwarded to again, so mutual connections terminate instead
   * of recursing forever. Relayed events never bubble - the relay is the propagation.
   */
  _relayToConnections(pin, event, context) {
    const connTrait = pin.traits.get('connectable');
    const relayChain = [...(event?.detail?.relayChain || []), pin.id];

    for (const targetId of connTrait.getConnections()) {
      if (relayChain.includes(targetId)) continue;

      const targetPin = context.pinMap.get(targetId);
      if (!targetPin || targetPin === pin) continue;

      targetPin.transmit(new PinEvent(event?.type, {
        payload: event?.payload,
        bubbles: false,
        source: pin,
        timestamp: event?.timestamp,
        detail: { relayChain, relayedBy: pin.id }
      }), context);
    }
  }
}

/**
 * ScopeTrait: Turns a Pin into a nested workspace container that hosts child Pins
 */
export class ScopeTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'scope',
      capabilities: ['scope-container', 'hierarchical-parent']
    });
  }

  onAttach(pin) {
    pin.getOrCreateScopeElement();
  }

  onActivate(pin, context) {
    for (const child of pin.children) {
      if (!child.lazy) {
        child.activate(context);
      }
    }
  }

  onRender(pin, contents, element, context) {
    const scopeEl = pin.getOrCreateScopeElement();
    if (scopeEl) {
      scopeEl.setAttribute('data-scope-id', pin.id);
    }
  }
}

/**
 * ConnectableTrait: Manages SVG connections to target Pins and renders in global SVG pass
 */
export class ConnectableTrait extends PinTrait {
  constructor(options = {}) {
    super(options, {
      name: 'connectable',
      capabilities: ['connectable', 'graph-node', 'global-render']
    });
    this.connections = new Set(options.connections || options.targets || options.connectTo || []);
    this.stroke = options.stroke || 'var(--cc-connector, rgba(56, 189, 248, 0.6))';
    this.strokeWidth = options.strokeWidth || 2;
    this.dashed = options.dashed !== undefined ? options.dashed : true;

    /**
     * Bumped on every change to `connections`.
     *
     * The SVG group layer gates its redraws on things it can see from outside a
     * trait - the camera, Pin geometry, the carrier count - and a connection
     * added to a Pin that was already carrying this trait moves none of them.
     * The counter is that missing input: the layer sums it across the
     * participating Pins, so a mutation in here is visible as a changed
     * signature without the layer knowing what a connection is.
     */
    this.revision = 0;

    /**
     * Scratch list handed to the SVG group layer's dependency gate, refilled in
     * place on every call. The gate runs on frames where nothing else changed,
     * so allocating a fresh array here would put garbage on every idle frame.
     * @type {Pin[]}
     */
    this._dependencies = [];
  }

  connectTo(targetPinId) {
    const before = this.connections.size;
    this.connections.add(targetPinId);
    if (this.connections.size !== before) this.revision += 1;
  }

  disconnectFrom(targetPinId) {
    if (this.connections.delete(targetPinId)) this.revision += 1;
  }

  getConnections() {
    return Array.from(this.connections);
  }

  isConnectedTo(targetPinId) {
    return this.connections.has(targetPinId);
  }


  /**
   * The Pins at the far end of this Pin's connections.
   *
   * A connector is drawn between two boxes, but only one of them carries the
   * trait, so the SVG group layer's carrier scan cannot see the other move. A
   * target that is re-measured - a scope well growing around it after the first
   * paint, say - changes this connector's geometry and nothing else's, and this
   * is how the layer is told (see `SvgGroupLayer` dependency gate).
   *
   * @returns {Pin[]|null} the owned scratch list, valid until the next call
   */
  collectRenderDependencies(pin, context) {
    const pinMap = context ? context.pinMap : null;
    if (!pinMap || this.connections.size === 0) return null;

    const dependencies = this._dependencies;
    dependencies.length = 0;

    for (const targetId of this.connections) {
      const target = pinMap.get(targetId);
      if (target && target !== pin) dependencies.push(target);
    }
    return dependencies;
  }

  /**
   * Draw one path per connection whose *both* endpoints take part in the current
   * render root.
   *
   * The layer has already filtered the source Pins it hands over; the targets are
   * resolved here, from the pin map, so the same participation test has to be
   * applied here too - otherwise a promoted subtree would trail connectors out to
   * Pins that are no longer in the document.
   */
  onGlobalRender(pinsWithThisTrait, globalContext) {
    let out = '';
    const pinMap = globalContext.pinMap;
    if (!pinMap) return out;

    const participates = typeof globalContext.participates === 'function'
      ? globalContext.participates
      : null;

    for (const sourcePin of pinsWithThisTrait) {
      const connTrait = sourcePin.traits.get(this.name);
      if (!connTrait || connTrait.connections.size === 0) continue;

      const p1 = sourcePin.getGlobalBounds();
      const fromX = p1.centerX;
      const fromY = p1.centerY;

      for (const targetId of connTrait.connections) {
        const targetPin = pinMap.get(targetId);
        if (!targetPin) continue;
        if (participates && !participates(targetPin)) continue;

        const p2 = targetPin.getGlobalBounds();
        out += createConnectorPathSVG(fromX, fromY, p2.centerX, p2.centerY, {
          stroke: connTrait.stroke,
          strokeWidth: connTrait.strokeWidth,
          dashed: connTrait.dashed
        });
      }
    }
    return out;
  }
}
