/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * The action side of a Pin-to-Pin reaction: what a bound signal *does* to its
 * target, and the one table that both validates an action's parameters and tells
 * an editor how to render fields for them.
 *
 * A `TraitRegistry` in miniature (`./traits/registry.js`), and deliberately the
 * same shape: `register(type, definition)` adds an action, names are unique, and
 * a page that never adds one still has the built-in set. What a trait definition
 * does not carry, an action definition does - a `params` list of descriptors -
 * because the reaction editor has to build a form for an action it was never
 * told about at compile time, and the only honest source for "what fields does
 * this action need" is the action itself. This mirrors `pin-style.js`'s
 * `STYLE_PROPERTIES`: one declared table drives validation and UI at once, so a
 * parameter added to an action grows a field with no second edit.
 *
 * The `run` of a built-in reaches only the Pin's public surface - `setContent`,
 * `setPinStyle`, the session's `focus`, the element's own inline visibility -
 * never the particle or a private field, exactly as the editor's own writes do.
 */

import { STYLE_PROPERTIES, setPinStyle } from './pin-style.js';

/**
 * The control kinds a parameter descriptor may declare, and the coercion each
 * one owes. The vocabulary is `pin-style.js`'s ('select', a value kind) plus the
 * scalar kinds a form field commits: a reaction editor reads `control` to pick a
 * widget, this map reads it to turn a raw form value into the typed one `run`
 * expects. Adding a kind is one entry here and one branch in the editor.
 */
export const PARAM_CONTROLS = Object.freeze(['text', 'number', 'checkbox', 'select']);

/**
 * Coerce one raw parameter value to its declared control kind.
 *
 * Returns `{ value }` on success or `{ error }` on a value the kind cannot hold,
 * so the caller reports the rejection rather than writing garbage - the same
 * contract `setPinStyle` keeps when the CSSOM refuses a value.
 */
function coerceParam(descriptor, raw) {
  if (descriptor.control === 'number') {
    const number = Number(raw);
    if (!Number.isFinite(number)) return { error: `"${descriptor.key}" must be a number` };
    return { value: number };
  }
  if (descriptor.control === 'checkbox') return { value: Boolean(raw) };
  if (descriptor.control === 'select') {
    const value = raw === undefined || raw === null ? '' : String(raw);
    const allowed = descriptor.options.some((option) => option.value === value);
    if (!allowed) return { error: `"${descriptor.key}" is not one of the offered values` };
    return { value };
  }
  return { value: raw === undefined || raw === null ? '' : String(raw) };
}

/** Whether a descriptor is one whose absence is an error (default: yes). */
function isRequired(descriptor) {
  return descriptor.required !== false;
}

/**
 * Validate a raw parameter object against a definition's descriptors, returning
 * the coerced set. A required parameter that is missing, or any parameter the
 * kind cannot hold, fails; unknown keys are dropped, so a hand-edited snapshot
 * cannot smuggle a field the action never declared.
 *
 * @returns {{valid: true, params: object}|{valid: false, error: string}}
 */
function validateParams(definition, raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const params = {};

  for (const descriptor of definition.params) {
    const has = Object.prototype.hasOwnProperty.call(source, descriptor.key);
    if (!has) {
      if (isRequired(descriptor)) return { valid: false, error: `missing parameter "${descriptor.key}"` };
      continue;
    }
    const coerced = coerceParam(descriptor, source[descriptor.key]);
    if (coerced.error) return { valid: false, error: coerced.error };
    params[descriptor.key] = coerced.value;
  }

  return { valid: true, params };
}

/** A parameter descriptor, frozen and checked once at registration. */
function normalizeDescriptor(descriptor, type) {
  const key = descriptor && typeof descriptor.key === 'string' ? descriptor.key : '';
  if (key === '') throw new Error(`ActionRegistry: action "${type}" has a parameter with no key`);
  if (!PARAM_CONTROLS.includes(descriptor.control)) {
    throw new Error(`ActionRegistry: parameter "${key}" of "${type}" has an unknown control`);
  }
  if (descriptor.control === 'select' && !Array.isArray(descriptor.options)) {
    throw new Error(`ActionRegistry: select parameter "${key}" of "${type}" needs options`);
  }
  return Object.freeze({
    key,
    label: descriptor.label || key,
    control: descriptor.control,
    required: descriptor.required !== false,
    options: descriptor.control === 'select' ? Object.freeze([...descriptor.options]) : null,
    placeholder: descriptor.placeholder || ''
  });
}

/**
 * The registry of reaction actions: an open set, keyed by type, each entry a
 * `{ label, params, run }` triple. The counterpart of `TraitRegistry` for the
 * *action* half of a binding.
 */
export class ActionRegistry {
  constructor() {
    /** @type {Map<string, {type: string, label: string, params: object[], run: Function}>} */
    this._definitions = new Map();
  }

  /**
   * Register an action definition. Names are unique - re-registering throws, so a
   * page cannot silently shadow `set-style` with its own.
   *
   * @param {string} type
   * @param {{label?: string, params?: object[], run: Function}} definition
   * @returns {object} the frozen, normalized definition
   */
  register(type, definition) {
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error('ActionRegistry.register: type must be a non-empty string');
    }
    if (!definition || typeof definition.run !== 'function') {
      throw new Error(`ActionRegistry.register: "${type}" requires a run function`);
    }
    if (this._definitions.has(type)) {
      throw new Error(`ActionRegistry.register: "${type}" is already registered`);
    }

    const params = Array.isArray(definition.params) ? definition.params : [];
    const normalized = Object.freeze({
      type,
      label: definition.label || type,
      params: Object.freeze(params.map((descriptor) => normalizeDescriptor(descriptor, type))),
      run: definition.run
    });
    this._definitions.set(type, normalized);
    return normalized;
  }

  has(type) {
    return this._definitions.has(type);
  }

  get(type) {
    return this._definitions.get(type);
  }

  unregister(type) {
    return this._definitions.delete(type);
  }

  /** Every registered definition, for an editor's action picker. */
  list() {
    return Array.from(this._definitions.values());
  }

  /** The parameter descriptors an editor renders fields from, or []. */
  describe(type) {
    const definition = this._definitions.get(type);
    return definition ? definition.params : [];
  }

  /**
   * Validate a `{ type, params }` pair without running it.
   * @returns {{valid: true, params: object}|{valid: false, error: string}}
   */
  validate(type, params) {
    const definition = this._definitions.get(type);
    if (!definition) return { valid: false, error: `unknown action type "${type}"` };
    return validateParams(definition, params);
  }

  /**
   * Run an action against its target Pin.
   *
   * @param {string} type an action name; an unknown one throws, never runs
   * @param {Pin} target the Pin the action mutates
   * @param {object} params raw parameters, validated and coerced here
   * @param {object} [context] `{ session, source, event }` handed to `run`
   * @returns {*} whatever the action's `run` returned
   * @throws {TypeError} on an unknown type or invalid parameters
   */
  run(type, target, params, context = {}) {
    const definition = this._definitions.get(type);
    if (!definition) throw new TypeError(`ActionRegistry.run: unknown action type "${type}"`);

    const result = validateParams(definition, params);
    if (!result.valid) throw new TypeError(`ActionRegistry.run: ${result.error}`);

    return definition.run(target, result.params, context);
  }
}

/* ------------------ BUILT-IN ACTIONS ------------------ */

/** The style properties, offered to the `set-style` action as its `property` set. */
const STYLE_PARAM_OPTIONS = Object.freeze(
  STYLE_PROPERTIES.map((entry) => Object.freeze({ value: entry.property, label: entry.label }))
);

/** How `toggle-visibility` may act: flip, or force one way. */
const VISIBILITY_MODES = Object.freeze([
  Object.freeze({ value: 'toggle', label: 'Toggle' }),
  Object.freeze({ value: 'hide', label: 'Hide' }),
  Object.freeze({ value: 'show', label: 'Show' })
]);

/**
 * Set the target's visibility through its own inline style.
 *
 * Inline `visibility`, not a display trait concern: the framework's render pass
 * writes into the content node and never touches the root's `visibility`, so an
 * override here survives every frame, and `toggle` reads the value in force to
 * decide which way to flip.
 */
function runToggleVisibility(target, params) {
  const element = target && target.element;
  if (!element || !element.style) return false;

  const hidden = element.style.getPropertyValue('visibility') === 'hidden';
  const next = params.mode === 'hide' ? true
    : params.mode === 'show' ? false
      : !hidden;

  if (next) element.style.setProperty('visibility', 'hidden');
  else element.style.removeProperty('visibility');
  return next;
}

/**
 * The default action set. Small on purpose: four real actions over four real
 * Pin surfaces, each declaring exactly the parameters its `run` reads.
 */
export function registerBuiltinActions(registry) {
  registry.register('set-content', {
    label: 'Set content',
    params: [
      { key: 'key', label: 'Content key', control: 'text', placeholder: 'title' },
      { key: 'value', label: 'Value', control: 'text' }
    ],
    run: (target, params) => target.setContent(params.key, params.value)
  });

  registry.register('set-style', {
    label: 'Set style',
    params: [
      { key: 'property', label: 'Property', control: 'select', options: STYLE_PARAM_OPTIONS },
      { key: 'value', label: 'CSS value', control: 'text', placeholder: 'e.g. #ff0000' }
    ],
    run: (target, params) => setPinStyle(target, params.property, params.value)
  });

  registry.register('toggle-visibility', {
    label: 'Toggle visibility',
    params: [
      { key: 'mode', label: 'Mode', control: 'select', options: VISIBILITY_MODES, required: false }
    ],
    run: runToggleVisibility
  });

  registry.register('focus', {
    label: 'Focus (zoom to)',
    params: [
      { key: 'promote', label: 'Zoom in', control: 'checkbox', required: false }
    ],
    run: (target, params) => {
      const session = target && target.session;
      if (!session) return null;
      return session.focus(target, { promote: Boolean(params.promote) });
    }
  });

  return registry;
}

/** The shared registry, built once with the built-in set. */
export const actionRegistry = registerBuiltinActions(new ActionRegistry());
