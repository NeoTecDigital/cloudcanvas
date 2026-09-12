/**
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * The canvas's own right-click menu: a registry of commands, and the small
 * overlay that renders whichever of them apply where the click landed.
 *
 * Two halves, one concern - what a secondary click may do here:
 *
 *   1. `MenuRegistry` holds *definitions*
 *      (`{id, label, when, action, group, parent}`), exactly as `TraitRegistry`
 *      holds trait definitions: ids are unique, registration order is render
 *      order, and `clear()` restores the built-ins. A consumer adds a command
 *      with `registerMenuItem`; nothing else is needed.
 *   2. The overlay half is the usual engine shape - free functions taking the
 *      session first (`./navigation.js`, `./host.js`). The session owns the state
 *      (`_contextMenu`, created at mount and removed by `destroy()`), this module
 *      owns the transitions.
 *
 * NESTING. A command may name another command as its `parent`. Any command that
 * is named by at least one child becomes a *submenu trigger* rather than a
 * clickable action: it renders with a caret and opens a flyout listing its
 * children when activated. The relationship is derived, never flagged - the same
 * mechanism composes to any depth, because a child of a flyout may itself be
 * some third command's parent. A trigger therefore carries no `action` of its
 * own (a command that is both is an authoring mistake, and registration throws
 * rather than paper over it); and a `parent` must already be registered when its
 * child arrives, which keeps the graph an acyclic forest and its render order
 * top-down.
 *
 * THREE DECORATION SEAMS, all opt-in on the command definition and all defaulting
 * to the behaviour that predates them, so an item that declares none renders and
 * runs exactly as before. Each replaces a way a consumer had to reach *around*
 * this module - a `MutationObserver`, a capture-phase `stopPropagation`, a
 * synthetic hover click - because the seam did not exist:
 *
 *   - `renderItem(button, item, context)` runs the instant the bundle has built a
 *     command's `<button>` (class, role, `data-menu-item`, label, and a trigger's
 *     caret already on it). The caller decorates it in place - a hint, a tick, a
 *     swatch - or returns a replacement element. It is the built-in alternative to
 *     watching the overlay for buttons to appear and decorating them after the
 *     fact.
 *   - `closeOnRun: false` on a leaf keeps the menu open after its action runs, for
 *     an in-place toggle. The alternative was pre-empting the bundle's own click
 *     with a capture-phase listener that ran the action and stopped the close.
 *   - `openOnHover: true` on a trigger opens its flyout when the pointer rests on
 *     it, the same as a click. The alternative was dispatching a synthetic click
 *     at the trigger on a hover timer.
 *
 * Plain DOM, core tokens, no `lib/` import: the menu is core code, and the
 * dependency edge only ever runs core -> nothing.
 *
 * The native menu is *not* replaced wholesale. When no item's `when()` passes -
 * a bare canvas with no history and no Pin under the pointer - the event is left
 * alone and the platform menu opens, with its own reload, inspect and
 * spellcheck. Suppression is earned by having something better to show.
 */

import { PIN_CLASS } from '../pins/pin-element.js';
import { canGoBack, canGoForward } from './navigation.js';

/** The menu element itself, hidden between openings. */
export const MENU_CLASS = 'cloudcanvas-context-menu';

/** A flyout panel: a submenu opened beside its trigger. Shares the menu's look. */
export const MENU_FLYOUT_CLASS = 'cloudcanvas-context-menu-flyout';

/** One group of items; consecutive groups are separated by a rule. */
export const MENU_GROUP_CLASS = 'cloudcanvas-context-menu-group';

/** One command. Always a real `<button>`, so the keyboard gets it for free. */
export const MENU_ITEM_CLASS = 'cloudcanvas-context-menu-item';

/** A command that opens a submenu rather than running: carries a caret. */
export const MENU_ITEM_SUBMENU_CLASS = 'cloudcanvas-context-menu-item--submenu';

/** Attribute carrying an item's id from the DOM back to its definition. */
export const MENU_ITEM_ATTR = 'data-menu-item';

/**
 * How long the pointer rests on an `openOnHover` trigger before its flyout opens.
 * A short delay, so a pointer merely crossing a trigger on its way elsewhere does
 * not open panels it never meant to.
 */
export const MENU_HOVER_OPEN_MS = 180;

/* ------------------ Z-ORDER (the DOM is the model) ------------------ */

/**
 * Paint order among siblings is document order, so moving the element is the
 * whole operation - there is no z-index bookkeeping to keep in step, no second
 * ordering model to disagree with the tree, and a Pin that moves scope carries
 * nothing stale with it. (Elevation - `./elevation.js` - is the orthogonal axis:
 * it lifts a focused or dragged *chain* over everything, whatever the order.)
 *
 * The structure flush only ever appends a Pin whose parent actually changed
 * (`mountPin` in `./mounting.js`), so a reordering survives every later frame.
 *
 * @returns {boolean} true when the element moved
 */
export function bringToFront(pin) {
  const element = pin ? pin.element : null;
  const container = element ? element.parentNode : null;
  if (!container || container.lastElementChild === element) return false;

  container.appendChild(element);
  return true;
}

/**
 * Move a Pin behind every sibling Pin.
 *
 * Behind the *Pins*, not behind everything: the canvas plane's first child is
 * the focus veil, which is placed first deliberately (see `mountLayers`), and a
 * Pin inserted above it would quietly take that place.
 *
 * @returns {boolean} true when the element moved
 */
export function sendToBack(pin) {
  const element = pin ? pin.element : null;
  const container = element ? element.parentNode : null;
  if (!container || typeof container.querySelector !== 'function') return false;

  const first = container.querySelector(`:scope > .${PIN_CLASS}`);
  if (!first || first === element) return false;

  container.insertBefore(element, first);
  return true;
}

/* ------------------ REGISTRY ------------------ */

/**
 * The commands the framework ships.
 *
 * Navigation first, because it is what a right-click on the canvas background
 * is for; the z-order pair is Pin-scoped and disappears on empty canvas.
 */
const BUILT_IN_ITEMS = Object.freeze([
  {
    id: 'nav-back',
    label: 'Back',
    group: 'navigation',
    when: (session) => canGoBack(session),
    action: (session) => session.popFocus()
  },
  {
    id: 'nav-forward',
    label: 'Forward',
    group: 'navigation',
    when: (session) => canGoForward(session),
    action: (session) => session.goForward()
  },
  {
    id: 'bring-to-front',
    label: 'Bring to front',
    group: 'order',
    when: (session, { pin }) => Boolean(pin),
    action: (session, { pin }) => bringToFront(pin)
  },
  {
    id: 'send-to-back',
    label: 'Send to back',
    group: 'order',
    when: (session, { pin }) => Boolean(pin),
    action: (session, { pin }) => sendToBack(pin)
  }
]);

/** Visible always, unless the item says otherwise. */
const ALWAYS = () => true;

/**
 * @typedef {object} MenuItem
 * @property {string} id unique; the DOM carries it back to the definition
 * @property {string} label the button's text
 * @property {string} group items sharing a group render together, separated
 *           from the next group by a rule
 * @property {string} parent the id of the command this one nests under; '' at
 *           the top level. A command named here becomes a submenu trigger.
 * @property {(session: CloudCanvasSession, context: MenuContext) => boolean} when
 *           visibility, decided per opening
 * @property {((session: CloudCanvasSession, context: MenuContext) => any)|null} action
 *           run on click, before the menu closes; null for a submenu trigger
 * @property {((button: Element, item: MenuItem, context: MenuContext) => (Element|void))|null} renderItem
 *           called once the item's `<button>` is built, to decorate it in place
 *           or return a replacement element (which must carry `MENU_ITEM_ATTR` to
 *           stay clickable); null for the default rendering
 * @property {boolean} closeOnRun whether running the action closes the menu
 *           (default true); false keeps it open for an in-place toggle. Ignored
 *           for a submenu trigger, which has no action
 * @property {boolean} openOnHover whether resting the pointer on this trigger
 *           opens its flyout (default false); ignored for a leaf, which has no
 *           flyout
 *
 * @typedef {{pin: Pin|null, x: number, y: number}} MenuContext
 *          `pin` is null when the click landed on empty canvas; `x`/`y` are
 *          client coordinates.
 */
export class MenuRegistry {
  constructor() {
    /** @type {Map<string, MenuItem>} insertion-ordered, which is render order */
    this._items = new Map();
    this._initDefaults();
  }

  _initDefaults() {
    for (const item of BUILT_IN_ITEMS) this.register(item);
  }

  /**
   * Register a command. Ids are unique: re-registering one throws rather than
   * silently displacing a command something else put there.
   *
   * An `action` is required *unless* the command is (or becomes) a submenu
   * trigger. Because trigger status is derived from being named as a `parent`,
   * the two facts can only collide the moment a child arrives naming a parent
   * that already carries an action - and that is exactly where this throws.
   *
   * @param {MenuItem} item
   * @returns {MenuItem} the normalised, frozen definition
   */
  register(item) {
    const { id, label, action } = item || {};
    if (typeof id !== 'string' || id === '') {
      throw new Error('MenuRegistry.register: id must be a non-empty string');
    }
    if (typeof label !== 'string' || label === '') {
      throw new Error(`MenuRegistry.register: "${id}" requires a label`);
    }
    if (action !== undefined && typeof action !== 'function') {
      throw new Error(`MenuRegistry.register: "${id}" action, if given, must be a function`);
    }
    if (item.renderItem !== undefined && typeof item.renderItem !== 'function') {
      throw new Error(`MenuRegistry.register: "${id}" renderItem, if given, must be a function`);
    }
    if (this._items.has(id)) {
      throw new Error(`MenuRegistry.register: "${id}" is already registered`);
    }

    const parent = this._resolveParent(item, id);
    const definition = Object.freeze({
      id,
      label,
      group: typeof item.group === 'string' ? item.group : '',
      parent,
      when: typeof item.when === 'function' ? item.when : ALWAYS,
      action: typeof action === 'function' ? action : null,
      // The three opt-in seams, normalized once so every read is a plain field.
      renderItem: typeof item.renderItem === 'function' ? item.renderItem : null,
      closeOnRun: item.closeOnRun !== false,
      openOnHover: Boolean(item.openOnHover)
    });
    this._items.set(id, definition);
    return definition;
  }

  /**
   * Validate a `parent` reference and return the normalised id ('' at the top
   * level). The parent must already exist - forward references are refused, so
   * the graph is an acyclic forest and its render order stays top-down - and it
   * must not carry an action of its own, because naming it here makes it a
   * trigger, and a command cannot be both.
   */
  _resolveParent(item, id) {
    const parent = typeof item.parent === 'string' ? item.parent : '';
    if (parent === '') return '';

    const target = this._items.get(parent);
    if (!target) {
      throw new Error(`MenuRegistry.register: "${id}" names parent "${parent}", which is not registered`);
    }
    if (typeof target.action === 'function') {
      throw new Error(
        `MenuRegistry.register: "${parent}" cannot be both a submenu trigger and an action `
        + `(named as parent by "${id}")`
      );
    }
    return parent;
  }

  /** @returns {boolean} true when an item was actually removed */
  unregister(id) {
    return this._items.delete(id);
  }

  has(id) {
    return this._items.has(id);
  }

  get(id) {
    return this._items.get(id);
  }

  /** @returns {boolean} true when some other command names `id` as its parent */
  hasChildren(id) {
    for (const item of this._items.values()) {
      if (item.parent === id) return true;
    }
    return false;
  }

  /** @returns {MenuItem[]} the commands nesting under `id`, in registration order */
  childrenOf(id) {
    const out = [];
    for (const item of this._items.values()) {
      if (item.parent === id) out.push(item);
    }
    return out;
  }

  /** @returns {MenuItem[]} in registration order */
  list() {
    return Array.from(this._items.values());
  }

  /** Drop every custom command and restore the built-in set. */
  clear() {
    this._items.clear();
    this._initDefaults();
  }
}

/** The registry every session reads. One menu, however many canvases. */
export const menuRegistry = new MenuRegistry();

/** Add a command to the canvas menu (see {@link MenuRegistry#register}). */
export function registerMenuItem(item) {
  return menuRegistry.register(item);
}

/** Take a command back off it. */
export function unregisterMenuItem(id) {
  return menuRegistry.unregister(id);
}

/* ------------------ RESOLUTION ------------------ */

/** Whether some other command names this one as its parent. */
function isSubmenuTrigger(item) {
  return menuRegistry.hasChildren(item.id);
}

/**
 * Whether a command has anything to show for this opening.
 *
 * A leaf shows when its `when()` passes and it has an action to run. A trigger
 * shows when its `when()` passes *and* at least one descendant would itself show
 * - so an empty category, or one whose every child is gated out, never renders a
 * caret that opens onto nothing. The recursion is what lets that judgement reach
 * arbitrarily deep for free.
 */
function isVisible(session, context, item) {
  if (!item.when(session, context)) return false;
  if (isSubmenuTrigger(item)) {
    return menuRegistry.childrenOf(item.id).some((child) => isVisible(session, context, child));
  }
  return typeof item.action === 'function';
}

/**
 * The top-level commands that apply to one click, in registration order.
 * @returns {MenuItem[]}
 */
export function menuItemsFor(session, context) {
  return menuRegistry.list().filter(
    (item) => item.parent === '' && isVisible(session, context, item)
  );
}

/**
 * The commands nesting directly under `parentId` that apply, in registration
 * order - the top-level filter, one level down.
 * @returns {MenuItem[]}
 */
function childItemsFor(session, context, parentId) {
  return menuRegistry.childrenOf(parentId).filter((item) => isVisible(session, context, item));
}

/**
 * Items bucketed by group, groups in first-appearance order.
 * @returns {MenuItem[][]}
 */
function groupItems(items) {
  const groups = new Map();

  for (const item of items) {
    const bucket = groups.get(item.group);
    if (bucket) bucket.push(item);
    else groups.set(item.group, [item]);
  }

  return Array.from(groups.values());
}

/* ------------------ THE OVERLAY ------------------ */

/**
 * Build the menu element inside the session's overlay layer.
 *
 * Mounted once and kept - like the focus veil and the cursor layer - because a
 * per-click element is a per-click listener too, and the click delegation below
 * is registered exactly once for the life of the session. Flyout panels, by
 * contrast, are transient: created when a submenu opens and removed when it
 * closes, since there may be zero or many and their contents are per-opening.
 *
 * @returns {Element|null} the menu element, or null when there is nowhere to put it
 */
export function mountContextMenu(session) {
  if (typeof document === 'undefined') return null;
  const overlay = session ? session.overlayElement : null;
  if (!overlay) return null;

  unmountContextMenu(session);

  const element = document.createElement('div');
  element.className = MENU_CLASS;
  element.setAttribute('role', 'menu');
  element.hidden = true;

  const state = {
    element,
    /** @type {MenuContext|null} the click the open menu belongs to */
    context: null,
    /** @type {Map<string, MenuItem>} every item on screen now, across all panels */
    items: new Map(),
    /** @type {PanelRecord[]} the open chain: [0] is the root, then each flyout */
    panels: [],
    /** Pending `openOnHover` timer, or null; at most one is ever armed. */
    hoverTimer: null,
    onClick: (event) => runClickedItem(session, event),
    onPointerOver: (event) => onMenuPointerOver(session, event),
    onPointerOut: (event) => onMenuPointerOut(session, event),
    onDocumentPointerDown: (event) => dismissOnOutside(session, event),
    onDocumentKeyDown: (event) => onMenuKeyDown(session, event)
  };

  element.addEventListener('click', state.onClick);
  // Hover-to-open rides the same delegation as click: one listener on the panel,
  // resolved to the item by `MENU_ITEM_ATTR`. A panel with no `openOnHover`
  // trigger under the pointer arms nothing, so this is inert until opted in.
  element.addEventListener('pointerover', state.onPointerOver);
  element.addEventListener('pointerout', state.onPointerOut);
  overlay.appendChild(element);
  session._contextMenu = state;
  return element;
}

/** Close the menu, drop its element, and forget the state. */
export function unmountContextMenu(session) {
  const state = session ? session._contextMenu : null;
  if (!state) return false;

  closeContextMenu(session);
  state.element.removeEventListener('click', state.onClick);
  state.element.removeEventListener('pointerover', state.onPointerOver);
  state.element.removeEventListener('pointerout', state.onPointerOut);
  if (state.element.parentNode) state.element.parentNode.removeChild(state.element);
  session._contextMenu = null;
  return true;
}

/**
 * Show the menu for one click, if anything applies to it.
 *
 * @param {CloudCanvasSession} session
 * @param {MenuContext} context
 * @returns {boolean} true when a menu was opened - and so when the caller owes
 *          the event a `preventDefault()`. False means the platform's menu, and
 *          that is a real outcome rather than a failure.
 */
export function openContextMenu(session, context) {
  const state = session ? session._contextMenu : null;
  if (!state) return false;

  const items = menuItemsFor(session, context);
  if (items.length === 0) {
    closeContextMenu(session);
    return false;
  }

  // A fresh opening supersedes whatever was up: tear down any flyouts and the
  // document listeners first, so a re-open never leaks an orphaned panel or
  // stacks a second copy of a listener.
  closeContextMenu(session);

  const ids = renderInto(state.element, items, state, context);
  state.panels = [rootPanel(state.element, ids)];
  // Unhidden before it is positioned: `placeInHost` clamps the menu inside the
  // host box, and the clamp needs a real measurement to do it. A hidden element
  // is `display:none`, whose `getBoundingClientRect()` is all zeros - measure it
  // then and the clamp is a silent no-op, which is the whole defect.
  state.element.hidden = false;
  placeInHost(session, state.element, { mode: 'point', x: context.x, y: context.y });
  state.context = context;

  document.addEventListener('pointerdown', state.onDocumentPointerDown);
  document.addEventListener('keydown', state.onDocumentKeyDown);
  focusFirstItem(state.element);
  return true;
}

/**
 * Hide the menu and give the canvas its keyboard back. Closes the whole chain -
 * every open flyout, then the root - which is what running a command or a press
 * outside means.
 * @returns {boolean} true when a menu was actually open
 */
export function closeContextMenu(session) {
  const state = session ? session._contextMenu : null;
  if (!state || state.element.hidden) return false;

  // Asked *before* the panels are torn out: removing the focused element drops
  // focus to the document body, and by then there is nothing left to ask.
  const held = menuHoldsFocus(state);

  clearHoverTimer(state);
  closePanelsDeeperThan(session, 0);
  state.element.hidden = true;
  state.element.textContent = '';
  state.items.clear();
  state.panels = [];
  state.context = null;

  document.removeEventListener('pointerdown', state.onDocumentPointerDown);
  document.removeEventListener('keydown', state.onDocumentKeyDown);
  if (held) restoreFocus(session);
  return true;
}

/** Whether the session's menu is currently on screen. */
export function isContextMenuOpen(session) {
  const state = session ? session._contextMenu : null;
  return Boolean(state) && state.element.hidden === false;
}

/* ------------------ PANELS ------------------ */

/**
 * @typedef {object} PanelRecord
 * @property {Element} element the panel's own DOM box
 * @property {Element|null} triggerButton the item that opened it; null for root
 * @property {string|null} triggerId that trigger's id; null for root
 * @property {number} depth 0 for the root, +1 per level of nesting
 * @property {string[]} itemIds the ids rendered into it, for teardown
 * @property {'left'|'right'} side which side of its trigger this panel opened on.
 *           A child inherits its parent's side as the side to try first, so a
 *           chain that flipped to the left stays there instead of oscillating back
 *           over the ancestor it just cleared. The root's is 'right' - the side
 *           its own children start from.
 */

/** The record for the persistent root panel. */
function rootPanel(element, itemIds) {
  return { element, triggerButton: null, triggerId: null, depth: 0, itemIds, side: 'right' };
}

/** The open panel whose box contains `node`, if any. */
function panelOf(state, node) {
  if (!node) return null;
  for (const panel of state.panels) {
    if (panel.element.contains(node)) return panel;
  }
  return null;
}

/**
 * Open the flyout for a trigger, moving focus into it.
 *
 * Only one branch is ever open at a level, so this first closes any panel deeper
 * than the trigger's own - which drops a sibling's flyout while leaving every
 * ancestor (the `+ New ▸ Category` chain above) exactly where it is. Re-opening
 * the trigger that is already expanded is a no-op but for the focus move, so a
 * second click does not flicker the panel it just built.
 *
 * @returns {boolean} true when a flyout is now open for this trigger
 */
function openFlyout(session, triggerItem, triggerButton) {
  const state = session._contextMenu;
  const parentPanel = panelOf(state, triggerButton);
  if (!parentPanel) return false;

  const already = state.panels[state.panels.indexOf(parentPanel) + 1];
  if (already && already.triggerId === triggerItem.id) {
    focusFirstItem(already.element);
    return true;
  }

  closePanelsDeeperThan(session, parentPanel.depth);
  const children = childItemsFor(session, state.context, triggerItem.id);
  if (children.length === 0) return false;

  const panel = state.element.ownerDocument.createElement('div');
  panel.className = `${MENU_CLASS} ${MENU_FLYOUT_CLASS}`;
  panel.setAttribute('role', 'menu');
  panel.addEventListener('click', state.onClick);
  panel.addEventListener('pointerover', state.onPointerOver);
  panel.addEventListener('pointerout', state.onPointerOut);
  session.overlayElement.appendChild(panel);

  const ids = renderInto(panel, children, state, state.context);
  // Beside the trigger, top-aligned with it: `placeInHost` opens it on the side
  // its parent took (so a flipped chain stays flipped), flips to the other side
  // when that would overflow the host, and reports the side it settled on.
  const side = placeInHost(session, panel, {
    mode: 'box',
    rect: triggerButton.getBoundingClientRect(),
    preferSide: parentPanel.side,
    allowFlip: parentPanel.depth === 0
  });

  triggerButton.setAttribute('aria-expanded', 'true');
  state.panels.push({
    element: panel,
    triggerButton,
    triggerId: triggerItem.id,
    depth: parentPanel.depth + 1,
    itemIds: ids,
    side
  });
  focusFirstItem(panel);
  return true;
}

/**
 * Remove every open panel deeper than `depth`, innermost first. Their items
 * leave the on-screen map, their triggers collapse, and their boxes leave the
 * overlay - but never the persistent root element, which is only hidden.
 * @returns {number} how many panels were closed
 */
function closePanelsDeeperThan(session, depth) {
  const state = session._contextMenu;
  let closed = 0;

  while (state.panels.length > 0 && state.panels[state.panels.length - 1].depth > depth) {
    const panel = state.panels.pop();
    for (const id of panel.itemIds) state.items.delete(id);
    if (panel.triggerButton) panel.triggerButton.setAttribute('aria-expanded', 'false');
    if (panel.element !== state.element) {
      panel.element.removeEventListener('click', state.onClick);
      panel.element.removeEventListener('pointerover', state.onPointerOver);
      panel.element.removeEventListener('pointerout', state.onPointerOut);
      if (panel.element.parentNode) panel.element.parentNode.removeChild(panel.element);
    }
    closed += 1;
  }
  return closed;
}

/**
 * Close just the innermost open flyout and return focus to the trigger that
 * opened it - one step back up the chain, which is what Escape means while a
 * flyout is open.
 * @returns {boolean} true when a flyout was there to close
 */
function closeInnermostFlyout(session) {
  const state = session._contextMenu;
  if (state.panels.length <= 1) return false;

  const innermost = state.panels[state.panels.length - 1];
  const trigger = innermost.triggerButton;
  closePanelsDeeperThan(session, innermost.depth - 1);
  if (trigger && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true });
  return true;
}

/* ------------------ RENDERING ------------------ */

/**
 * Fill a panel with one `<button>` per item and one `<div>` per group, register
 * each item into the on-screen map, and report the ids so the panel can be torn
 * down later. Shared by the root and every flyout - the only difference between
 * them is which items they are handed. `context` is the opening's `MenuContext`,
 * passed through to each item's `renderItem` seam.
 * @returns {string[]} the ids rendered, in order
 */
function renderInto(containerElement, items, state, context) {
  const doc = containerElement.ownerDocument;
  containerElement.textContent = '';
  const ids = [];

  for (const group of groupItems(items)) {
    const wrapper = doc.createElement('div');
    wrapper.className = MENU_GROUP_CLASS;

    for (const item of group) {
      wrapper.appendChild(itemButton(doc, item, context));
      state.items.set(item.id, item);
      ids.push(item.id);
    }
    containerElement.appendChild(wrapper);
  }
  return ids;
}

/**
 * A real button: focusable, Enter- and Space-activated, announced as a command.
 *
 * The `renderItem` seam runs last, once the button is fully built (a trigger's
 * caret included): the caller mutates it in place, or returns a replacement
 * element to use instead. A returned element is used as-is - it is the caller's
 * to stamp with `MENU_ITEM_ATTR` if it must stay clickable - and anything else
 * (including the button itself, or nothing) keeps the built button.
 */
function itemButton(doc, item, context) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = MENU_ITEM_CLASS;
  button.setAttribute('role', 'menuitem');
  button.setAttribute(MENU_ITEM_ATTR, item.id);
  button.textContent = item.label;
  if (isSubmenuTrigger(item)) decorateTrigger(button);

  if (typeof item.renderItem === 'function') {
    const replacement = item.renderItem(button, item, context);
    if (replacement && replacement !== button && replacement.nodeType === 1) return replacement;
  }
  return button;
}

/**
 * Turn a plain command button into a submenu trigger: the popup semantics for
 * assistive tech, and a caret at the trailing edge for everyone else.
 *
 * The caret needs no stylesheet change - the button becomes a two-ended flex
 * row inline, so the label sits left and the marker right - which keeps the
 * whole feature inside this module.
 */
function decorateTrigger(button) {
  button.classList.add(MENU_ITEM_SUBMENU_CLASS);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.style.display = 'flex';
  button.style.alignItems = 'center';
  button.style.justifyContent = 'space-between';

  const caret = button.ownerDocument.createElement('span');
  caret.className = `${MENU_ITEM_SUBMENU_CLASS}-caret`;
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▸';
  button.appendChild(caret);
}

/**
 * Put a panel where it belongs and fit it inside the host box.
 *
 * The overlay is the one layer that draws in screen space and covers exactly the
 * host box, so a client coordinate becomes a panel coordinate by subtracting the
 * host's own origin - the cached rect, never a fresh measurement.
 *
 * Two anchor modes, and the horizontal fit is where they part:
 *
 *   - A POINT anchor (`{mode:'point', x, y}`) is the root menu at the right-click.
 *     A point has no other side to move to, so it is placed at the click and then
 *     *clamped*: a panel opened near the right or bottom edge is pulled back inside
 *     by its overhang, never past the near edge - a panel bigger than the host
 *     keeps its top-left corner on screen, the most of it that can be shown.
 *
 *   - A BOX anchor (`{mode:'box', rect, preferSide, allowFlip}`) is a flyout beside
 *     its trigger. Horizontally it is *flipped*, not clamped: it opens on
 *     `preferSide` of the trigger, right-aligning against the trigger's near edge
 *     when that side is the left. Anchoring a flyout at the trigger's right and then
 *     clamping *left* was the defect - near the right edge every level clamped to
 *     the same leftmost slot and stacked on top of its own ancestors; opening on
 *     the far side keeps each level clear of the ones above it.
 *
 *     A chain commits to one side. Only the first flyout (`allowFlip`, because its
 *     parent is the sideless root) may take the other side when its preferred one
 *     overflows; a deeper flyout inherits the committed side and, if even that
 *     overflows, clamps in that direction rather than reversing - because reversing
 *     is precisely what would send a level back across the ancestor it just left
 *     (a right-going chain that runs out of room on the right cannot turn left
 *     without landing on the parents already sitting there). Clamping is therefore
 *     the fallback both when the first flyout fits neither side and when a deeper
 *     one exhausts its committed side. The chosen side is returned for the next
 *     level to inherit.
 *
 * The vertical fit is shared: both modes top-align at the anchor and clamp the
 * bottom edge back inside. There is no vertical flip - the trigger row is fixed.
 *
 * The panel is measured from its own rendered box (the caller unhid or appended it
 * first, so the measurement is real).
 *
 * @param {{mode:'point', x:number, y:number}
 *   |{mode:'box', rect:DOMRect, preferSide:'left'|'right', allowFlip:boolean}} anchor
 * @returns {'left'|'right'|null} the side a box was placed on; null for a point
 */
const EMPTY_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

function placeInHost(session, element, anchor) {
  const hostRect = session.getHostRect();
  // The host is the whole surface, but an application may float chrome over its
  // edges -- a status bar, a toolbar -- and a menu clamped to the raw rect puts
  // its last rows under that chrome: present to a hit test, invisible and
  // unclickable to a person. `session.menuInsets` is how an app says which edges
  // are spoken for; absent, it is the raw rect and nothing changes.
  const inset = session.menuInsets || EMPTY_INSETS;
  // `|| 0` rather than a guard: a synthetic event with no coordinates opens the
  // menu in the host's top-left corner, which is a place - `NaNpx` is not.
  const hostLeft = (hostRect.left || 0) + (inset.left || 0);
  const hostTop = (hostRect.top || 0) + (inset.top || 0);
  const hostRight = (hostRect.left || 0) + (hostRect.width || 0) - (inset.right || 0);
  const hostBottom = (hostRect.top || 0) + (hostRect.height || 0) - (inset.bottom || 0);

  // Preferred top-left in overlay-local coordinates: a point sits at the click, a
  // box top-aligned beside its trigger (its horizontal side is decided below).
  const anchorTop = anchor.mode === 'box' ? anchor.rect.top : (Number(anchor.y) || 0);
  const anchorLeft = anchor.mode === 'box' ? anchor.rect.right : (Number(anchor.x) || 0);
  element.style.top = `${anchorTop - hostTop}px`;
  element.style.left = `${anchorLeft - hostLeft}px`;

  const box = element.getBoundingClientRect();
  let side = null;
  if (anchor.mode === 'box') {
    side = placeBoxHorizontally(element, anchor, box.width, hostLeft, hostRight);
  } else {
    clampFarEdge(element, 'left', box.right, hostRight);
  }
  if (!placeAbove(element, anchor, box, hostTop, hostBottom)) {
    clampFarEdge(element, 'top', box.bottom, hostBottom);
  }
  return side;
}

/**
 * Open upward when there is no room below, the way every desktop menu does.
 *
 * Clamping is the wrong answer for a menu anchored near the bottom edge: it
 * slides the panel up until its *bottom* fits, which walks the panel back over
 * its own trigger and leaves the last rows under whatever chrome sits on that
 * edge -- reachable to a hit test, invisible and unclickable to a person. The
 * flip keeps the anchor honest: the panel's bottom sits where its top would
 * have, so it never covers the point it was opened from.
 *
 * Only for a point anchor. A flyout is placed beside its trigger by
 * `placeBoxHorizontally`, and a vertical flip there would tear a chain apart.
 *
 * @returns {boolean} true when the panel was flipped and no clamp should follow
 */
function placeAbove(element, anchor, box, hostTop, hostBottom) {
  if (anchor.mode === 'box') return false;
  if (box.bottom <= hostBottom) return false;          // it fits below; nothing to do
  const top = parseFloat(element.style.top) || 0;
  const above = top - box.height;
  // Above must be a real improvement, not a different overflow: a panel taller
  // than the space above it stays below and takes the clamp.
  if (above < 0 || box.height > (anchor.y || 0) - hostTop) return false;
  element.style.top = `${above}px`;
  return true;
}

/**
 * Fit a flyout on one side of its trigger, and report the side it took.
 *
 * The committed side (`anchor.preferSide`) is taken whenever it fits, so a chain
 * stays on the side its first flyout chose instead of weaving back over its own
 * ancestors. Only a first flyout (`anchor.allowFlip`) may flip to the other side
 * when its preferred one overflows. Failing both, the far edge is clamped to the
 * host's on the committed side - the point clamp, one axis.
 *
 * @returns {'left'|'right'} the side the flyout was placed on
 */
function placeBoxHorizontally(element, anchor, panelWidth, hostLeft, hostRight) {
  const { rect: triggerRect, preferSide, allowFlip } = anchor;
  const fitsRight = triggerRect.right + panelWidth <= hostRight;
  const fitsLeft = triggerRect.left - panelWidth >= hostLeft;
  const rightLocal = triggerRect.right - hostLeft;
  const leftLocal = (triggerRect.left - panelWidth) - hostLeft;

  // The committed side, when it fits.
  if (preferSide === 'right' && fitsRight) { element.style.left = `${rightLocal}px`; return 'right'; }
  if (preferSide === 'left' && fitsLeft) { element.style.left = `${leftLocal}px`; return 'left'; }

  // The first flyout, and only it, may flip to whichever side is left.
  if (allowFlip && fitsLeft) { element.style.left = `${leftLocal}px`; return 'left'; }
  if (allowFlip && fitsRight) { element.style.left = `${rightLocal}px`; return 'right'; }

  // Neither side is available: clamp the far edge to the host's, on the committed
  // side, never past the near edge.
  const clamped = preferSide === 'left' ? 0 : Math.max(0, (hostRight - hostLeft) - panelWidth);
  element.style.left = `${clamped}px`;
  return preferSide;
}

/**
 * Pull an element's far edge back inside the host by its overhang, never past the
 * near edge (0 in overlay-local space). The point clamp on one axis: `'left'` for
 * the horizontal fit of a point anchor, `'top'` for the vertical fit of any panel.
 */
function clampFarEdge(element, styleProp, boxFar, hostFar) {
  const over = boxFar - hostFar;
  if (over > 0) {
    element.style[styleProp] = `${Math.max(0, parseFloat(element.style[styleProp]) - over)}px`;
  }
}

/**
 * Focus the first command in a panel.
 *
 * A menu opened by the pointer is still a menu: arrow keys, Tab and Enter have
 * to reach it, and they cannot until something inside it holds focus.
 */
function focusFirstItem(element) {
  const first = element.querySelector(`.${MENU_ITEM_CLASS}`);
  if (!first || typeof first.focus !== 'function') return false;

  first.focus({ preventScroll: true });
  return true;
}

/** Whether the keyboard is currently inside any open panel. */
function menuHoldsFocus(state) {
  const active = state.element.ownerDocument.activeElement;
  return Boolean(panelOf(state, active));
}

/**
 * Hand focus back to the canvas.
 *
 * A menu that closes while it holds focus and hands it to nobody drops the
 * keyboard on the document body: Tab restarts from the top of the page and the
 * canvas's own key bindings are gone until it is clicked again.
 */
function restoreFocus(session) {
  const host = session.hostElement;
  if (!host || typeof host.focus !== 'function') return false;

  host.focus({ preventScroll: true });
  return true;
}

/* ------------------ DISMISSAL & ACTIVATION ------------------ */

/**
 * Handle a click on a command, wherever in the chain it landed.
 *
 * A trigger opens (or re-focuses) its flyout and the chain stays up; a leaf runs
 * its action and the whole chain closes - in that order, so an action may reopen
 * the menu. A trigger never runs an action: it has none, and even a stray one
 * would be ignored here.
 *
 * `closeOnRun: false` is the one exception to "a leaf closes the menu": the
 * action runs and the chain is left up, for a toggle that flips in place. This is
 * the click *and* the keyboard path - Enter and Space on a `<button>` dispatch a
 * native click that lands here - so a toggle keeps the menu open however it ran.
 */
function runClickedItem(session, event) {
  const state = session._contextMenu;
  const button = event.target && typeof event.target.closest === 'function'
    ? event.target.closest(`[${MENU_ITEM_ATTR}]`)
    : null;
  if (!button) return false;

  const item = state.items.get(button.getAttribute(MENU_ITEM_ATTR));
  if (!item) return false;

  if (isSubmenuTrigger(item)) return openFlyout(session, item, button);
  if (typeof item.action !== 'function') return false;

  item.action(session, state.context);
  if (item.closeOnRun) closeContextMenu(session);
  return true;
}

/* ------------------ HOVER-TO-OPEN (openOnHover triggers) ------------------ */

/**
 * Arm the flyout of an `openOnHover` trigger the pointer has come to rest on.
 *
 * At most one timer is ever armed: a fresh pointerover clears the pending one, so
 * moving the pointer across several items opens only the last it settled on, and
 * a trigger already expanded arms nothing. The open is deferred by
 * {@link MENU_HOVER_OPEN_MS} and re-checks the trigger is still there and still
 * closed when it fires, because the pointer may have left in the meantime.
 */
function onMenuPointerOver(session, event) {
  const state = session ? session._contextMenu : null;
  if (!state || state.element.hidden) return;

  clearHoverTimer(state);
  const target = event ? event.target : null;
  const button = target && typeof target.closest === 'function'
    ? target.closest(`[${MENU_ITEM_ATTR}]`)
    : null;
  if (!button) return;

  const item = state.items.get(button.getAttribute(MENU_ITEM_ATTR));
  if (!item || !item.openOnHover || !isSubmenuTrigger(item)) return;
  if (button.getAttribute('aria-expanded') === 'true') return;

  state.hoverTimer = setTimeout(() => {
    state.hoverTimer = null;
    if (!button.isConnected || button.getAttribute('aria-expanded') === 'true') return;
    openFlyout(session, item, button);
  }, MENU_HOVER_OPEN_MS);
}

/** A pointer leaving a menu item disarms a pending hover-open. */
function onMenuPointerOut(session, event) {
  const state = session ? session._contextMenu : null;
  if (!state) return;

  const target = event ? event.target : null;
  const onItem = target && typeof target.closest === 'function'
    && target.closest(`[${MENU_ITEM_ATTR}]`);
  if (onItem) clearHoverTimer(state);
}

/** Cancel a pending hover-open, if any. */
function clearHoverTimer(state) {
  if (state && state.hoverTimer !== null) {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
  }
}

/** A press outside every open panel closes the menu, and is otherwise left alone. */
function dismissOnOutside(session, event) {
  const state = session._contextMenu;
  if (panelOf(state, event.target)) return false;
  return closeContextMenu(session);
}

/**
 * The menu's own keyboard, on top of the buttons' native Enter/Space/Tab:
 *
 *   - Escape steps back one level while a flyout is open, and only closes the
 *     whole menu once at the top - the well-understood app-menu convention.
 *   - Up/Down rove within the focused panel, wrapping at the ends.
 *   - Right (like Enter) opens the focused trigger's flyout and steps into it.
 *   - Left closes the flyout focus is in and steps back to its trigger.
 */
function onMenuKeyDown(session, event) {
  const state = session ? session._contextMenu : null;
  if (!state || state.element.hidden) return;

  switch (event.key) {
    case 'Escape':
      preventDefault(event);
      if (!closeInnermostFlyout(session)) closeContextMenu(session);
      break;
    case 'ArrowDown':
      if (moveRoving(state, 1)) preventDefault(event);
      break;
    case 'ArrowUp':
      if (moveRoving(state, -1)) preventDefault(event);
      break;
    case 'ArrowRight':
      if (openFocusedTrigger(session)) preventDefault(event);
      break;
    case 'ArrowLeft':
      if (closeFocusedFlyout(session)) preventDefault(event);
      break;
    default:
      break;
  }
}

/** Move focus to the next/previous command in the focused panel, wrapping. */
function moveRoving(state, delta) {
  const active = state.element.ownerDocument.activeElement;
  const panel = panelOf(state, active);
  if (!panel) return false;

  const buttons = Array.from(panel.element.querySelectorAll(`.${MENU_ITEM_CLASS}`));
  if (buttons.length === 0) return false;

  const from = buttons.indexOf(active);
  const to = (from + delta + buttons.length) % buttons.length;
  buttons[to].focus({ preventScroll: true });
  return true;
}

/** If a submenu trigger is focused, open its flyout. */
function openFocusedTrigger(session) {
  const state = session._contextMenu;
  const active = state.element.ownerDocument.activeElement;
  if (!active || typeof active.getAttribute !== 'function') return false;

  const item = state.items.get(active.getAttribute(MENU_ITEM_ATTR));
  if (!item || !isSubmenuTrigger(item)) return false;
  return openFlyout(session, item, active);
}

/** If focus is inside a flyout, close that flyout and step back to its trigger. */
function closeFocusedFlyout(session) {
  const state = session._contextMenu;
  const active = state.element.ownerDocument.activeElement;
  const panel = panelOf(state, active);
  if (!panel || panel.depth === 0) return false;

  const trigger = panel.triggerButton;
  closePanelsDeeperThan(session, panel.depth - 1);
  if (trigger && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true });
  return true;
}

/** Suppress the platform's own handling of a key the menu just consumed. */
function preventDefault(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
}
