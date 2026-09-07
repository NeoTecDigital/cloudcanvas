# CloudCanvas

> Minimalist client-side GUI framework treating HTML elements as interactive canvas **Pins**.
> Written by Richard Christopher &bull; Copyright &copy; 2026 NeoTec, LLC &bull; MIT License

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Module: ESM](https://img.shields.io/badge/module-ESM-yellow.svg)](package.json)

---

> **This repository is the core engine only.** It is the importable, buildable client-side
> framework: session, `Pin`, particles, traits, renderer and theming. The pre-built widgets and
> component library live at **[NeoTecDigital/cloudcanvas-lib](https://github.com/NeoTecDigital/cloudcanvas-lib)**,
> and the interactive sandbox / site builder at
> **[NeoTecDigital/cloudcanvas-site](https://github.com/NeoTecDigital/cloudcanvas-site)**.

---

## Overview

CloudCanvas is an embeddable, client-side GUI engine where interactive HTML `<div>` elements exist on an infinite virtual plane. Rather than tightly coupling behaviors to monolithic classes, CloudCanvas strips the Pin down to its pure mathematical and structural foundation:

- **Traits**: Composable, programmable capabilities (`DisplayTrait`, `DraggableTrait`, `SelectableTrait`, `PhysicsTrait`, `FocussableTrait`, `ScopeTrait`, `ConnectableTrait`, `TransmitterTrait`).
- **Contents**: A `Map<string, any>` key-value store for application state and template payloads.
- **Vectors**: An array of `float` values (`PinParticle`) storing spatial coordinates $(x, y, z)$, velocities $(vx, vy)$, and directional quantities (magnitudes, angles, gradients).
- **Element**: An HTML `<div>` with a fixed two-child architecture (`.cloudcanvas-pin-content` + `.cloudcanvas-pin-scope`).

The framework is native browser ESM with **no runtime dependencies**.

---

## Core Pillars

### 1. The Conjugate Renderer (Zero Layout Thrashing)
A three-phase per-frame render pipeline that separates layout reads from DOM writes:
1. **Structure Flush**: Resolves reload states (`active` / `persistent` / `lazy`), mounting or unmounting pins shallowest-first.
2. **Read Phase**: Batches layout measurements (`offsetWidth`, `offsetHeight`, scope offsets). Dormant pins skip measurement.
3. **Write Phase**: Writes content updates to dirty pins, executes a three-float position diff, updates camera transforms, and writes per-trait SVG groups.

*Result*: Zero layout thrashing, idle frames perform zero DOM writes, and stationary pins have compositor hints swept after 30 frames.

### 2. Hierarchical Pin Scoping & Zoom-to-Parent Focus
- **Nested Scopes**: Pins host child pins inside `.cloudcanvas-pin-scope`. Scope containers are granted size dynamically (`ScopeWellPass`) and clip their children cleanly.
- **Zoom-to-Parent Focus**: Zoom into any pin with `session.focus(pin)`, which promotes it to the new parent view by default. An animated frustum projection connects the parent scope corners directly to the focused child pin. `session.focus(pin, { promote: false })` is the plain camera move.
- **Root Promotion & Breadcrumbs**: Promotion isolates the active subtree while keeping the ancestor chain mounted for breadcrumb navigation (`session.breadcrumb()`). `session.popFocus()` steps back out and `session.goForward()` steps back in, browser-style.

### 3. Null-Pin Overlay Cursors
Cursors are not bolted-on DOM mutations. A dedicated null utility Pin (`__cursor__`, `utility: true`) carries independent screen-space cursor traits in the overlay:
- `cursor-focus`: Reticle framing the focused pin with parent-scope frustum projection and WCAG-compliant text contrast.
- `cursor-selected`: Persistent selection ring tracking selected pins.
- `cursor-activated`: Corner brackets indicating active status.
- Reskinning a cursor is as simple as re-registering its definition in `traitRegistry`.

### 4. Input & Accessibility Agnosticism
- **Keyboard Navigation**: Single tab-stop (`tabindex="0"`) on the canvas host with roving reading-order focus between pins (`Arrow` keys, `Enter` to descend, `Space` to act, `Escape` to back out, `+`/`-` to zoom).
- **Pointer & Touch**: Multi-touch pinch-to-zoom centered at pointer midpoints, trackpad two-axis pan & ctrl-pinch zoom, 3px click jitter threshold, and native text selection support (`selectableText: true`).
- **Screen Reader Support**: Host declared as `role="application"` with a polite live region (`role="status" aria-atomic="true"`) announcing camera movements, focus transitions, and child load events.
- **Theming**: 100% token-based CSS variables (`--cc-*`) with dark defaults as fallback. Instant zero-CSS styling and light theme support via `applyTheme(host, LIGHT_THEME)`.

---

## Installation

The engine ships a committed single-file build in [`dist/`](dist/), so every method below works with
**zero build step**. Pick whichever fits your setup.

### 1. npm (install straight from GitHub)

```bash
npm install git+https://github.com/NeoTecDigital/cloudcanvas.git
```

```javascript
import { createCanvasSession } from 'cloudcanvas';
const session = createCanvasSession({ container: '#canvas-container' });
```

> Not yet published to the npm registry — install via the `git+` URL above, not a bare
> `npm install cloudcanvas`.

### 2. git clone (use the prebuilt bundle directly)

```bash
git clone https://github.com/NeoTecDigital/cloudcanvas.git
```

Then reference the committed bundle — no build required:

```html
<script src="cloudcanvas/dist/cloudcanvas.iife.js"></script>
<script>
  const session = CloudCanvas.createCanvasSession({ container: '#canvas-container' });
</script>
```

### 3. Single-file `<script>` include (CDN / raw URL)

```html
<!-- jsDelivr GitHub mirror (CDN, cached, recommended) -->
<script src="https://cdn.jsdelivr.net/gh/NeoTecDigital/cloudcanvas@main/dist/cloudcanvas.iife.js"></script>

<!-- or the raw GitHub file directly -->
<script src="https://raw.githubusercontent.com/NeoTecDigital/cloudcanvas/main/dist/cloudcanvas.iife.js"></script>

<script>
  const session = CloudCanvas.createCanvasSession({ container: '#canvas-container' });
</script>
```

### 4. Download the file with curl

```bash
curl -o cloudcanvas.iife.js https://raw.githubusercontent.com/NeoTecDigital/cloudcanvas/main/dist/cloudcanvas.iife.js
```

Append `.min` to any bundle filename for the minified build (`dist/cloudcanvas.iife.min.js`).

### Entry Points

| Specifier | Contents |
| :--- | :--- |
| `cloudcanvas` | Core engine: session, Pin, particles, traits, theming. |
| `cloudcanvas/styles` | Stylesheet API: `injectCanvasStyles`, `applyTheme`, `LIGHT_THEME`, `CANVAS_DEFAULT_CSS`. |
| `cloudcanvas/styles.css` | Deprecated alias for the raw `CANVAS_DEFAULT_CSS` string module; import `cloudcanvas/styles` instead. Kept for one release. |

> The prebuilt widgets (`cloudcanvas/lib`, `cloudcanvas/components`) and the sandbox
> (`cloudcanvas/sandbox`) are packaged separately in
> **[NeoTecDigital/cloudcanvas-lib](https://github.com/NeoTecDigital/cloudcanvas-lib)**.

---

## Distribution Bundles

`npm run build` (needs the one `esbuild` devDependency) bundles the whole engine into `dist/` as
two single files, each with a minified sibling. Both are self-contained: no import map, no
directory of module requests, no runtime dependencies. The build is committed, so running it is a
release step, never required to consume the engine.

| Artifact | Format | Load it with |
| :--- | :--- | :--- |
| `dist/cloudcanvas.esm.js` | ESM, named exports | `<script type="module">` over `http(s)` |
| `dist/cloudcanvas.iife.js` | IIFE, `window.CloudCanvas` | plain `<script src>`, works from `file://` |

**ESM — modern apps served over http(s).** Its named exports are exactly the ones
`import 'cloudcanvas'` gives you, and a downstream bundler can still tree-shake it.

```html
<script type="module">
  import { createCanvasSession } from './dist/cloudcanvas.esm.js';
  const session = createCanvasSession({ container: '#canvas-container' });
</script>
```

**IIFE — the strict zero-server case.** Use this when the page is opened straight off disk. A
module script *cannot* be used from a `file://` URL: Chromium fetches module scripts in CORS mode
and a `file://` origin is always denied. Bundling to a single module does not help — the failure is
the fetch mode, not the request count. A classic script tag carries no such restriction.

```html
<script src="./dist/cloudcanvas.iife.js"></script>
<script>
  const session = CloudCanvas.createCanvasSession({ container: '#canvas-container' });
</script>
```

---

## API Surface at a Glance

`index.js` is grouped in three tiers under the same banner comments, so the file reads
in the order you need it:

| Tier | Names | When |
| :--- | :--- | :--- |
| **Start here** | `createCanvasSession`, `CloudCanvasSession`, `Pin`, `PinEvent` | Every application. A canvas, a Pin, and the event they speak. |
| **Everyday** | traits (`DisplayTrait`, `DraggableTrait`, `ScopeTrait`, `FocussableTrait`, ...), `resizePin` / `rotatePin` / `reparentPin`, reload strategies + `DEFAULT_OFFLOAD_MARGIN`, `defineComponent` + the template kit, theming (`applyTheme`, `injectCanvasStyles`, `LIGHT_THEME`), cursors, `place` / `droppablePinAt`, the canvas menu (`registerMenuItem` / `unregisterMenuItem`, nested through `parent`) | Once you have a session and are building with it. |
| **Advanced** | `Viewport`, `ConjugateRenderer`, `PinManager`, `ParticleEngine`, `bindKeyboard` / `unbindKeyboard`, `mountAnnouncer` / `unmountAnnouncer`, `applyHostAria`, `ensureVisible`, `readingOrder`, `setElevationChain` | Rarely needed: `CloudCanvasSession` constructs, wires and tears down all of it. Reach in only to build your own host or drive one piece standalone. |

---

## Basic Usage

```javascript
import { createCanvasSession, PinEvent } from 'cloudcanvas';

// 1. Initialize Canvas Session
const session = createCanvasSession({
  container: '#canvas-container',
  viewport: { x: 0, y: 0, scale: 1 }
});

// 2. Create a Root Card Pin
const welcomePin = session.createPin({
  id: 'pin_welcome',
  type: 'card',
  x: 100,
  y: 100,
  contents: new Map([
    ['title', 'Welcome to CloudCanvas'],
    ['body', 'Minimalist GUI engine treating HTML elements as canvas Pins.'],
    ['badge', { text: 'Active', color: '#10b981' }]
  ])
});

// 3. Create a Parent Scope Pin with a Nested Child
const parentPin = session.createPin({
  id: 'pin_parent',
  type: 'scope',
  x: 400,
  y: 100,
  width: 480,
  contents: new Map([
    ['title', 'Parent Scope Frame'],
    ['body', 'Hosts child pins in its coordinate scope.']
  ])
});

const childPin = session.createPin({
  id: 'pin_child',
  parent: parentPin,
  x: 20,
  y: 80,
  width: 200,
  contents: new Map([
    ['title', 'Child Pin'],
    ['body', 'Zoom into this pin as the new parent view.']
  ])
});

// 4. Zoom into the Child Pin (promotes it to the new parent view)
session.focus(childPin);
```

---

## Trait Composition

Traits can be attached, queried, or replaced dynamically:

```javascript
import { Pin, FocussableTrait, TransmitterTrait, PinEvent } from 'cloudcanvas';

const pin = new Pin({ x: 50, y: 50 });

// Attach interactive & event traits
pin.addTrait(new FocussableTrait({ padding: 60, maxZoom: 3.0 }));
const transmitter = pin.addTrait(new TransmitterTrait());

// Listen for custom events
transmitter.on('telemetry', (event, targetPin) => {
  console.log('Received telemetry:', event.payload);
});

// Transmit custom event (bubbles to parent scopes)
pin.transmit(new PinEvent('telemetry', { payload: { status: 'OK', ping: 12 } }));
```

---

## Architecture & Verification

- Comprehensive Specification: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Release & Migration Notes: [`CHANGELOG.md`](CHANGELOG.md)

The development server, the examples playground and the full unit / integration / browser test
suites are maintained in the umbrella workspace alongside the
[`cloudcanvas-lib`](https://github.com/NeoTecDigital/cloudcanvas-lib) and
[`cloudcanvas-site`](https://github.com/NeoTecDigital/cloudcanvas-site) repositories, which import
this engine directly from source.

---

## License

MIT &copy; 2026 NeoTec, LLC, Richard Christopher. See [`LICENSE`](LICENSE).
