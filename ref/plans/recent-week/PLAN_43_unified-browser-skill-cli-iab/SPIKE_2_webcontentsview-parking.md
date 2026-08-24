# Spike 2: Background WebContentsView parking and reparenting

## Question

Can an Electron 33 WebContentsView keep painting without foreground focus, preserve page state, move
between a background host and the Session Detail panel, and follow responsive panel bounds?

## Method

- Confirmed the repository real-Electron baseline with `pnpm test:browser-electron`.
- Ran CommonJS real-Electron fixtures under `.ref/plans/browser-skill-cli-iab-20260818/`.
- Tested a view in a hidden host, detached, explicitly hidden, parked in an opacity-zero,
  non-focusable visible host, and reparented between two visible hosts.
- Captured PNGs and queried `innerWidth`, `innerHeight`, a page-state marker, host visibility, and
  focus events.

## Observed result

- A WebContentsView in a hidden BrowserWindow, `setVisible(false)`, or initially detached collapsed
  to `0x0`; `capturePage()` returned an empty image. That route is invalid.
- A parking BrowserWindow configured with `opacity:0`, `focusable:false`, `skipTaskbar:true`, and
  ignored mouse input kept a child view painted after the host was shown inactive and the view was
  attached/bounded.
- Reparenting preserved page state and updated responsive viewport sizes:
  `420x480 -> 360x430 -> 440x500` CSS pixels.
- Retina captures were non-empty at twice the CSS dimensions.
- Page mutation survived reparenting.
- Focus event count remained zero and no BrowserWindow became focused.

## Conclusion

Use one main-owned invisible parking host for unselected IAB views. Keep parked views attached,
bounded to their latest panel viewport, and visible inside the opacity-zero host. When the user
selects a session/tab, reparent the chosen view into the real Agent Deck window at the renderer-
reported panel bounds; repark it before switching away. Never use `setVisible(false)` or long-term
detachment as the background state.

The parking host must be shown inactive before views are attached/bounded; the first ordering tested
before host presentation produced `0x0` until visibility was toggled.

## Remaining risk

- Validate multiple overlapping parked views, actual transparent/vibrant main-window composition,
  window recreation, Spaces, app hide/show, compact mode, and all supported platforms.
- Pin the parking host to no taskbar/dock, no focus, ignored mouse input, opacity zero, and no external
  navigation of its own.
- Ensure shutdown destroys every parked WebContents exactly once and renderer crashes cannot leave
  a visible native view over another Session Detail tab.
