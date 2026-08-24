# Spike 3: Retina screenshot annotation to image attachment

## Question

Can the selected responsive viewport be frozen, annotated in CSS coordinates, exported at physical
pixel resolution, and represented as the `File` input consumed by the existing composer pipeline?

## Method

- Captured a hidden real-Electron page at `420x480` CSS pixels on the current Retina display.
- Loaded the screenshot into a canvas whose backing store matched physical pixels.
- Drew a CSS-coordinate line with deterministic `scaleX`/`scaleY` conversion.
- Exported PNG through `canvas.toBlob`, constructed a browser `File`, and reloaded the data through
  Electron `nativeImage` for independent size/validity checks.

Artifact: `.ref/plans/browser-skill-cli-iab-20260818/spike-annotation.cjs`.

## Observed result

- Source capture: non-empty `840x960` PNG for a `420x480` CSS viewport.
- Canvas and exported PNG remained `840x960`; coordinate scale was exactly `2x2`.
- Browser `File` metadata was `iab-annotation.png`, `image/png`, 198,044 bytes.
- Independent PNG decoding succeeded and remained non-empty.

## Conclusion

The annotation pipeline is feasible without touching page DOM. Repark the native view, display a
frozen screenshot in renderer canvas mode, store strokes in normalized/CSS coordinates plus the
capture's viewport revision, and export a PNG File into the existing `useImageAttachments.add`
pipeline. Resize or navigation invalidates the frozen annotation session.

## Remaining risk

- Bound history, stroke count, canvas pixels, PNG bytes, and undo memory.
- Validate pointer/touch input, DPR changes between displays, zoom, scroll metadata, and renderer
  device-loss/crash behavior.
- Per D-105, hide annotation controls and explain the reason when the live adapter/runtime does not
  accept PNG input; do not offer text-coordinate fallback.
