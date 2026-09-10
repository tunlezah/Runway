# Spec: sticky site banner ("accent rule")

A portable, single-line notification banner for a single-page web app. Pinned to the top
of the viewport, configurable from one place, immune to the host app's theme and accent
pickers, and additive — it does not restyle or reposition any existing chrome.

This spec is written to be handed to another project as-is. Section 2 is discovery you
must complete before writing code; sections 3–8 are requirements; section 10 is a working
reference implementation; section 12 is how to prove it.

Every requirement marked **Trap** is something that looks fine in review, passes a casual
glance in the browser, and is wrong. They are the reason this document is longer than the
component.

---

## 1. Objective

Add a single-line, site-wide notification banner to the top of every page. It must:

- work in light and dark mode, and keep its own colours under any *other* theme the app offers;
- stay pinned to the top of the viewport while page content scrolls beneath it;
- be reconfigurable from one place — text, on/off, dismissible;
- add no dependencies;
- change no existing page's layout, spacing or scroll behaviour other than by its own height.

**Additive means additive.** If you find yourself editing an existing header, nav, or
container rule to make the banner fit, stop and re-read section 6 — `position: sticky`
exists so that you don't have to.

---

## 2. Resolve before starting

Answer all six in the target codebase before writing any CSS. Each one changes what you
write; guessing produces a banner that works on your machine and breaks on someone else's.

**1. How does the app do dark mode, and on which element does the hook live?**

Find out; do not introduce a second, parallel theming system. Three cases:

| Mechanism | Where the dark values go |
|---|---|
| `prefers-color-scheme` only | `@media (prefers-color-scheme: dark) { :root { … } }` |
| A class or attribute on a root element (`.dark`, `[data-theme="dark"]`) | Under that exact selector, on that exact element |
| Both — OS default with a manual override | Scope the media query so an explicit light setting still wins: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`, then repeat the dark values under `:root[data-theme="dark"]` so the manual override wins in the other direction too |

**2. Does the app offer themes beyond light and dark?** A high-contrast mode, a joke
theme, a per-tenant skin. If so, section 7 applies and it is the single most likely place
to ship a contrast bug.

**3. Is there an accent/brand colour picker that writes a CSS variable at runtime?**
If yes, the banner must not consume that variable — including for its focus ring. Check
for `style.setProperty("--accent", …)` or similar.

**4. Is there an existing z-index scale?** List the layers and their values. The banner
belongs above page content and below every overlay (dropdown, popover, toast, modal,
scrim, drawer). Pick a value inside the existing scale. If there is genuinely no scale,
use `100` and say so in a comment.

**5. Is there already a fixed or sticky header?** If so, the banner sits above it, both
need to stick, and you must confirm the intended stacking order and the combined offset
(`top: var(--banner-height)` on the header). This is the one case where you will touch
existing chrome, so agree it first.

**6. Where does site-wide configuration live, and should dismissal persist?** Prefer a
module constant over a user-settings store: the banner text is build-time configuration,
not a user preference. Dismissal persistence is out of scope by default (section 9) —
confirm rather than assume.

---

## 3. Visual definition

The banner sits *on* the page background and carries no fill of its own. Its presence is
signalled by two things only: coloured text, and a solid rule along its bottom edge.

```
┌──────────────────────────────────────────────────┐
│                 YOUR TEXT HERE                   │  ← page bg, accent-coloured text
├══════════════════════════════════════════════════┤  ← 2px accent rule
│                                                  │
│  page content scrolls under the banner           │
│                                                  │
```

### Tokens

Define these as custom properties in one block, prefixed so they cannot collide with the
host app's tokens (`--bnr-*` below). Map to the project's naming convention if it has one,
but keep the values and keep the prefix.

**Geometry — shared by every mode**

| Token | Value | Purpose |
|---|---|---|
| `--bnr-pad-y` | `0.45rem` | **The height knob.** See below. |
| `--bnr-pad-x` | `1.25rem` | Horizontal padding |
| `--bnr-font-size` | `0.875rem` | 14px |
| `--bnr-line-height` | `1.4` | |
| `--bnr-line` | `calc(var(--bnr-font-size) * var(--bnr-line-height))` | The one-line text box — 19.6px |
| `--bnr-rule` | `2px` | Thickness of the bottom rule |
| `--bnr-gap` | `0.625rem` | Gap between mark, text and dismiss control |
| `--bnr-hit` | `24px` | Dismiss control hit target |
| `--bnr-h` | `calc(var(--bnr-pad-y)*2 + var(--bnr-line) + var(--bnr-rule))` | Derived height — 36px |

**Never hardcode the height.** Derive it, so it survives a font-size change and so
`scroll-padding-top` can reuse the same expression. With the values above the banner is
**36px including the rule**.

`--bnr-pad-y` is the only knob you need to change the banner's height: it sets the space
above the text *and* the gap between the text and the rule, so tightening it does both at
once. Useful values: `0.6rem` → 40.8px, `0.45rem` → 36px, `0.375rem` → 33.6px.

> **Trap — the floor on `--bnr-pad-y`.** The dismiss control's focus ring needs
> `(--bnr-hit / 2) + offset + width - (--bnr-line / 2)` = **6.2px** of vertical padding to
> stay clear of the rule. Below about `0.4rem` the ring draws over it. Note the limit in a
> comment next to the token or someone will rediscover it.

**Light mode**

| Token | Value | Contrast on `#ffffff` |
|---|---|---|
| `--bnr-bg` | the project's page-background token | — |
| `--bnr-fg` | `#a32d2d` | 7.05:1 ✓ AA text |
| `--bnr-accent` | `#d94a49` | 4.18:1 — rule and focus ring only |
| `--bnr-fg-quiet` | `#b8615f` | 4.28:1 — **UI colour only**, see below |

**Dark mode**

| Token | Value | Contrast on `#0f1115` |
|---|---|---|
| `--bnr-bg` | the project's page-background token | — |
| `--bnr-fg` | `#f0a09f` | 9.27:1 ✓ AA text |
| `--bnr-accent` | `#c9504e` | rule and focus ring only |
| `--bnr-fg-quiet` | `#a86d6c` | 4.59:1 — UI colour only |

The dark values are deliberately desaturated. Do not reuse the light-mode colours on a
dark background; they glare.

`--bnr-fg-quiet` is the *resting* colour of the dismiss control, which is a UI component
(WCAG 1.4.11, 3:1) and not text. It is below 4.5:1 in light mode by design. Do not use it
for the message. On hover it goes to `--bnr-fg`.

`--bnr-bg` aliases the project's page-background token rather than duplicating a hex, so
the banner reads as part of the page rather than as a separate strip — but see section 7
for the case where that alias must be broken.

---

## 4. Content and configuration surface

The message is a literal string, supplied through the config surface — **not** hardcoded in
the markup and not in the component body, so it can be changed in one place.

One object, in the app's config or as a module constant near the top of the script:

```js
const BANNER = { show: true, message: "YOUR TEXT HERE", dismissible: false };
```

| Key | Effect |
|---|---|
| `message` | The text shown. Plain text — set with `textContent`, never `innerHTML`. |
| `show: false` | Removes the banner outright: no gap, no offset, no scroll artefact. |
| `dismissible: true` | Adds a keyboard-reachable `×` that hides it for this page load. |

Normalise the object defensively rather than trusting it, and make the normaliser a pure
function so it can be unit-tested without a DOM:

- a non-string `message` is ignored, not stringified (`42` must not render as "42");
- a blank or whitespace-only `message` counts as **no banner** — an empty notice is a bare
  rule saying nothing;
- `dismissible` is opt-in and only for a literal `true` (`"yes"` is not true).

---

## 5. Markup contract

```html
<div class="site-banner" id="siteBanner" role="status" hidden>
  <span class="site-banner__mark" aria-hidden="true" hidden></span>
  <span class="site-banner__message"></span>
  <button class="site-banner__dismiss" type="button" aria-label="Dismiss banner" hidden>
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"
         stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round">
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/>
    </svg>
  </button>
</div>
```

- **First element in `<body>`**, before any existing header, nav or wrapper. If the app has
  a skip-to-content link, the banner goes after it.
- `role="status"` on the container. **Not** `role="alert"` — that interrupts screen reader
  output on every page load.
- The dismiss control is a real `<button type="button">`, not a styled `<span>` or `<a>`.
- The `×` is an inline SVG with `stroke="currentColor"` — not a text character, not an icon font.
- The message span ships **empty**; the config fills it. The container ships `hidden`; the
  script reveals it. Both are deliberate — see the FOUC trap in section 7.
- `.site-banner__mark` is a reserved slot: styled, `hidden`, no config key. Leave it that way
  unless someone asks for it.

---

## 6. Layout and behaviour

- `position: sticky; top: 0` — **not** `position: fixed`. Sticky keeps the banner in
  document flow, so nothing else needs a compensating top margin or padding, and nothing is
  hidden underneath it on first paint.
- `z-index` from the app's existing scale (question 4). Above content, below every overlay.
- Flexbox: `mark` (fixed) / `message` (`flex: 1 1 auto`, `min-width: 0`) / `dismiss` (fixed).
- The message is **always one line**: `white-space: nowrap`, `overflow: hidden`,
  `text-overflow: ellipsis`. A wrapping banner changes height and shifts the layout below it.
- `scroll-padding-top` at least the banner height, so in-page anchor targets don't land
  underneath it.

> **Trap — `min-width: 0`.** Without it the flex item refuses to shrink below its content
> width and the ellipsis silently never appears; the text overflows or wraps instead. This is
> the single easiest thing to get wrong here.

> **Trap — the dismiss control must not set the height.** A 24px button in a 19.6px line box
> grows the banner by 4.4px, so turning `dismissible` on changes its height. Bleed the hit
> target into the banner's own vertical padding with a negative margin:
> `margin-block: calc((var(--bnr-line) - var(--bnr-hit)) / 2)`. The flex line stays
> `--bnr-line`, the button's border box is still 24px (WCAG 2.5.8), and the height is
> unchanged whether or not the `×` is on.

> **Trap — `scroll-padding-top` must be gated.** If it is unconditional on `<html>`, then
> `show: false` and every dismissal leave a phantom anchor offset behind — a scroll artefact
> with no banner to justify it. Put it behind a flag the script owns:
> `:root[data-banner] { scroll-padding-top: var(--bnr-h) }`, set on reveal and removed on
> dismiss. A `:has()` selector also works but couples a correctness detail to a newer feature
> for no gain.

> **Trap — centring is not `text-align: center`.** That centres the text in its own flex
> *track*, which is offset left by the dismiss control's footprint whenever `dismissible` is
> on — off-centre by half of `(--bnr-hit + --bnr-gap)`. Mirror that footprint on the far side
> of the message so the text sits on the banner's true centre line and the `×` stays hard
> right. Drive it from a modifier class the script toggles, not from `:has()`.
>
> Centring does **not** break truncation: an overflowing nowrap line still starts at the
> inline-start edge and ellipsises at the end, so `text-align` only takes effect when there
> is slack. Verify it anyway at your narrowest supported width.

> **Trap — full-height containers grow.** If the app has a container with
> `min-height: 100%` (or `100vh`) resolving against the viewport, adding an in-flow banner
> above it makes the document taller than the viewport by the banner's height — an empty page
> gains a scrollbar. This is within "changes by the banner's own height", so the default is to
> accept it and say so. If you must remove it, gate the compensation on the same flag —
> `:root[data-banner] .app { min-height: calc(100% - var(--bnr-h)) }` — so `show: false`
> changes nothing. Do not apply it ungated.

---

## 7. Theme integration

Hook into the mechanism you found in question 1. Do not add a second one.

**The banner has exactly two appearances: light and dark.** Nothing else the app offers —
a third theme, an accent picker, a density setting — may restyle it. Consequences:

- Never consume the app's accent variable, including for the focus ring. Use `--bnr-accent`.
- If the app's theme can change the body font, pin `font-family` on the banner too, or a
  joke theme will render your notice in Comic Sans.
- Resolve the colours from light-vs-dark only. Scope the dark media query so it matches
  when the theme attribute is *absent, dark, or any other value* — i.e.
  `:root:not([data-theme="light"])` — so an unknown theme falls through to the OS
  preference instead of landing on the wrong set.

> **Trap — the `--bnr-bg` alias breaks on a third theme.** Aliasing `--bnr-bg` to the page
> background is right for light and dark, where you have verified contrast. Under a theme
> with a different background — a navy joke theme, a high-contrast black — the alias silently
> resolves to that background while the text keeps the light or dark colours, and contrast
> fails. A light `#a32d2d` on a navy `#000080` is unreadable.
>
> Fix it generically, not per-theme, so a theme added next year is covered:
>
> ```css
> :root { --bnr-bg: var(--page-bg); }                                    /* light + dark */
> :root[data-theme]:not([data-theme="light"]):not([data-theme="dark"])
>   { --bnr-bg: #ffffff; }                                               /* anything else */
> @media (prefers-color-scheme: dark) {
>   :root[data-theme]:not([data-theme="light"]):not([data-theme="dark"])
>     { --bnr-bg: #191817; }
> }
> ```
>
> The trade-off is explicit: under a third theme the banner reads as its own strip rather
> than as part of the page. That is the correct trade — legible and consistent beats blended
> and unreadable. State it in a comment so it does not look like an oversight.

> **Trap — flash of the wrong colours on load.** If the app stores a theme choice
> asynchronously (IndexedDB, `localStorage` behind a hydration step, a fetch), the theme
> attribute is not on `<html>` at first paint. Mount the banner *after* the theme has been
> applied, and ship the container `hidden` so it cannot paint the light colours and then flip
> to dark. This is why the markup starts hidden rather than visible.
>
> Verify by sampling `getComputedStyle` every animation frame during load with the OS set to
> one mode and the stored preference set to the other; assert that no frame in which the
> banner is *visible* carries the wrong palette.

---

## 8. Accessibility

- Message text meets WCAG AA (4.5:1) against the banner background in both modes. Re-verify
  after any colour substitution, and after any change to `--bnr-bg`.
- The dismiss control is a UI component: 3:1 (WCAG 1.4.11) and a 24×24 target (WCAG 2.5.8).
- Visible keyboard focus on the dismiss control and on any link in the message:
  `:focus-visible` with a 2px outline in `--bnr-accent` at 2px offset. Scope it inside the
  banner (`.site-banner :focus-visible`) so it beats the app's global focus rule on
  specificity without `!important`.
- The rule is decorative reinforcement, never the sole carrier of meaning.
- Set the message **before** revealing the container, so `role="status"` announces the notice
  once rather than announcing an empty region and then the text.
- Respect `prefers-reduced-motion`. There is no motion in the default design; if any is
  added, suppress it under that query.

---

## 9. Out of scope

Do not add: multiple stacked banners, severity variants, animation or slide-in, a countdown
or timer, analytics events, dismissal persistence, or markdown/HTML in the message. If any
look necessary, raise it rather than building it.

---

## 10. Reference implementation

Proven in a single-file app whose theming is `data-theme` on `<html>` (`light` / `dark` /
a third theme) with `prefers-color-scheme` as the default, plus a runtime accent picker.
Adjust the selectors to your answers from section 2; keep the structure.

### CSS

```css
/* ============ site banner ("accent rule") ============
   Additive, self-contained chrome: no fill of its own, coloured text and a rule along the
   bottom edge. Keeps its own colour tokens on purpose, so neither the accent picker nor a
   third theme reaches it. The wording lives in BANNER in the script.
   --bnr-pad-y is the height knob: it sets the space above the text and the gap between the
   text and the rule, so the banner is 36px at 0.45rem. Below about 0.4rem the dismiss
   control's focus ring starts to overlap the rule. */
:root {
  --bnr-pad-y: 0.45rem;
  --bnr-pad-x: 1.25rem;
  --bnr-font-size: 0.875rem;
  --bnr-line-height: 1.4;
  --bnr-line: calc(var(--bnr-font-size) * var(--bnr-line-height));
  --bnr-rule: 2px;
  --bnr-gap: 0.625rem;
  --bnr-hit: 24px;
  --bnr-h: calc(var(--bnr-pad-y) * 2 + var(--bnr-line) + var(--bnr-rule));
  --bnr-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  --bnr-bg: var(--surface);      /* alias the project's page-background token */
  --bnr-fg: #a32d2d;
  --bnr-accent: #d94a49;
  --bnr-fg-quiet: #b8615f;
}
/* --bnr-bg follows the page background only where that background is the light or dark one:
   under any other theme the reds would fail contrast, so the banner keeps its own colour. */
:root[data-theme]:not([data-theme="light"]):not([data-theme="dark"]) { --bnr-bg: #ffffff }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bnr-fg: #f0a09f; --bnr-accent: #c9504e; --bnr-fg-quiet: #a86d6c;
  }
  :root[data-theme]:not([data-theme="light"]):not([data-theme="dark"]) { --bnr-bg: #191817 }
}
:root[data-theme="dark"] {
  --bnr-fg: #f0a09f; --bnr-accent: #c9504e; --bnr-fg-quiet: #a86d6c;
}

/* set by the script only while the banner is on screen, so a hidden or dismissed banner
   leaves no anchor offset behind */
:root[data-banner] { scroll-padding-top: var(--bnr-h) }

.site-banner {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; gap: var(--bnr-gap);
  padding: var(--bnr-pad-y) var(--bnr-pad-x);
  background: var(--bnr-bg); color: var(--bnr-fg);
  border-bottom: var(--bnr-rule) solid var(--bnr-accent);
  font-size: var(--bnr-font-size); line-height: var(--bnr-line-height);
  font-family: var(--bnr-font);
}
.site-banner__mark {
  flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--bnr-accent);
}
/* min-width:0 is what lets the ellipsis appear: without it the flex item refuses to shrink
   and the text wraps, changing the banner's height */
.site-banner__message {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  text-align: center;
}
/* centred in the banner, not just in its own track: the dismiss control's footprint is
   mirrored on the far side of the message, so the text sits on the banner's true centre
   line with the × still hard right */
.site-banner--dismissible .site-banner__message {
  margin-inline-start: calc(var(--bnr-hit) + var(--bnr-gap));
}
/* the 24px hit target is bled into the banner's own vertical padding by a negative margin:
   the row height stays --bnr-line, so the dismiss control cannot change the banner's height */
.site-banner__dismiss {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: var(--bnr-hit); height: var(--bnr-hit);
  margin-block: calc((var(--bnr-line) - var(--bnr-hit)) / 2);
  padding: 0; border: none; background: none; cursor: pointer;
  color: var(--bnr-fg-quiet);
}
.site-banner__dismiss:hover { color: var(--bnr-fg) }
.site-banner__dismiss svg {
  width: 14px; height: 14px; stroke: currentColor; fill: none;
  stroke-width: 2; stroke-linecap: round;
}
.site-banner :focus-visible { outline: 2px solid var(--bnr-accent); outline-offset: 2px }
```

If the app does not already force `[hidden] { display: none !important }`, add it — a
`display: flex` rule otherwise beats the `hidden` attribute and the banner never hides.

### Script

```js
/* The one place to change the site-wide notice. `show:false` removes the banner outright;
   `dismissible:true` adds a × that hides it for this page load. A dismissal is deliberately
   not remembered. */
const BANNER = { show: true, message: "YOUR TEXT HERE", dismissible: false };

const Banner = (() => {
  // pure, so it can be tested without a DOM
  const config = raw => {
    const c = raw && typeof raw === "object" ? raw : BANNER;
    const message = typeof c.message === "string" ? c.message : "";
    return {
      // an empty notice would be a bare rule saying nothing, so it counts as no banner
      show: c.show !== false && message.trim() !== "",
      message,
      dismissible: c.dismissible === true,
    };
  };

  const node = () => document.getElementById("siteBanner");

  const dismiss = () => {
    const b = node();
    if (b) b.hidden = true;
    document.documentElement.removeAttribute("data-banner");
  };

  const mount = () => {
    const b = node();
    if (!b) return;
    const c = config();
    const msg = b.querySelector(".site-banner__message");
    const btn = b.querySelector(".site-banner__dismiss");
    if (msg) msg.textContent = c.message;
    b.classList.toggle("site-banner--dismissible", c.dismissible);
    if (btn) {
      btn.hidden = !c.dismissible;
      if (!btn.dataset.wired) {
        btn.dataset.wired = "1";
        btn.addEventListener("click", dismiss);
      }
    }
    // the text is in place before the banner is revealed, so role="status" announces the
    // notice once rather than an empty region
    b.hidden = !c.show;
    document.documentElement.toggleAttribute("data-banner", c.show);
  };

  return { mount, dismiss, config };
})();
```

**Call `Banner.mount()` after the theme has been applied** and as early as possible after
that — in the app's boot sequence, immediately following whatever sets the theme attribute.
Not before (wrong colours flash), not at the end of boot (the banner appears late).

---

## 11. Acceptance criteria

1. Banner appears at the top of every page, above existing chrome.
2. Scrolling any page leaves the banner pinned; content passes beneath it, and the banner
   wins the hit test at the top edge.
3. Toggling the OS theme, and the app's own theme control, switches the banner between the
   two colour sets — with no flash of the wrong colours on load, including when the stored
   preference disagrees with the OS.
4. A third theme, and the accent picker, leave the banner's colours untouched.
5. A very long `message` produces a single truncated line with an ellipsis, at unchanged
   height, at the narrowest supported width — and the start of the string is not clipped.
6. `show: false` removes the banner and leaves no gap, offset, or scroll artefact.
7. `dismissible: true` renders a keyboard-focusable 24×24 `×` with a visible focus ring that
   hides the banner; the banner's height is identical with and without it.
8. No existing page's layout, spacing or scroll behaviour changes other than by the banner's
   own height.
9. No new dependencies.

---

## 12. How to verify

Read the computed values; do not eyeball it. Drive a headless browser, or paste the checks
into a console.

| Claim | Check |
|---|---|
| Sticky, not fixed | `getComputedStyle(b).position === "sticky"`; after `scrollTo(0, 600)` the rect top is still `0` and the header's top has decreased |
| Content passes beneath | `document.elementFromPoint(innerWidth/2, 4).closest(".site-banner")` is truthy |
| Height derives from tokens | rect height equals `pad-y*2 + line + rule`, and is **identical** with `dismissible` on and off |
| Ellipsis works | `msg.scrollWidth > msg.clientWidth`, `msg.getClientRects().length === 1` |
| Nothing clipped at the start | a `Range` over the message's contents has `left >= msg` rect `left` |
| Truly centred | the `Range`'s centre equals the banner's centre, with and without the `×` |
| No FOUC | sample `getComputedStyle` per frame during load; no frame where the banner is visible has the wrong palette |
| `show: false` is clean | `offsetHeight === 0`, `scrollPaddingTop === "auto"`, `scrollHeight <= clientHeight` |
| Focus ring | tab to the button, then assert outline width, style, colour and offset |

> **Trap — how you compare "before and after" geometry.** To prove criterion 8, capture every
> existing chrome box before the change and after, subtracting the banner's height from each
> `top`. Two ways to get a false failure:
>
> - **Rounding.** Subtracting an integer `offsetHeight` (36) from a sub-pixel `rect.top`
>   (57.469) and rounding invents 1px differences that are not there. Subtract the fractional
>   `getBoundingClientRect().height` and compare to 3 decimal places.
> - **A baseline that already has the banner.** Once you have committed, "the current file" is
>   no longer the before state. Take the baseline from the last commit *without* the banner
>   and assert that it contains no banner markup before trusting it.
>
> Both of these produced a spurious 1px failure during development. The geometry was correct
> the whole time; the measurement was not.

Also worth running: the app's own test suite, lint, and any visual-regression or stress
suites, before and after. The banner should move none of them.
