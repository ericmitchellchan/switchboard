// Diagram pan/zoom math (T9) — the PURE core behind DiagramView.
//
// Hand-rolled on purpose (no pan/zoom library): the whole model is one affine
// transform `translate(tx,ty) then scale(s)` applied to the rendered SVG with
// transform-origin 0 0, so a content point c maps to the container point
// p = c*s + t. Everything below is direct algebra on that equation, which is
// what makes the invariants unit-testable without a DOM:
//   - panBy: shift t, scale untouched.
//   - zoomToPoint: change s while keeping the content point under the cursor
//     FIXED on screen — solve p = c*s' + t' for t' with c = (p - t)/s.
// Scale is clamped to [SCALE_MIN, SCALE_MAX]; when the clamp makes the scale
// a no-op, the transform comes back unchanged (identity-stable, so a wheel
// spin at the limit doesn't drift the pan).

export interface Transform {
  /** Translation in container px, applied BEFORE scale (transform-origin 0 0:
   *  `translate3d(tx,ty,0) scale(scale)`). */
  tx: number;
  ty: number;
  scale: number;
}

export const IDENTITY: Transform = { tx: 0, ty: 0, scale: 1 };

export const SCALE_MIN = 0.1;
export const SCALE_MAX = 8;

/** Non-finite → 1 (identity); otherwise clamped to [SCALE_MIN, SCALE_MAX].
 *  Same defensive shape as pins.clampZoom. */
export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
}

/** Pan by a container-px delta. Composes additively: panBy(panBy(t,a,b),c,d)
 *  === panBy(t, a+c, b+d). */
export function panBy(t: Transform, dx: number, dy: number): Transform {
  return { tx: t.tx + dx, ty: t.ty + dy, scale: t.scale };
}

/** Exponential wheel→zoom factor — symmetric (factor(d) * factor(-d) === 1)
 *  and smooth across mouse/trackpad delta magnitudes. Wheel up (negative
 *  deltaY) zooms in. Same curve as pins.zoomAfterWheel. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015);
}

/**
 * Zoom by `factor` centered on the cursor: the content point currently under
 * (cursorX, cursorY) — container-local coordinates — stays under the cursor
 * after the zoom. Derivation: c = (p - t)/s must satisfy p = c*s' + t', so
 * t' = p - (p - t) * (s'/s). Scale clamps to [SCALE_MIN, SCALE_MAX]; a
 * clamp-to-same-scale returns `t` unchanged (no pan drift at the limits).
 */
export function zoomToPoint(
  t: Transform,
  cursorX: number,
  cursorY: number,
  factor: number
): Transform {
  const nextScale = clampScale(t.scale * factor);
  if (nextScale === t.scale) return t;
  const ratio = nextScale / t.scale;
  return {
    tx: cursorX - (cursorX - t.tx) * ratio,
    ty: cursorY - (cursorY - t.ty) * ratio,
    scale: nextScale,
  };
}

/** CSS transform string for the SVG (with transform-origin 0 0). translate3d
 *  keeps the SVG on its own compositor layer so pan/zoom doesn't re-rasterize
 *  the whole diagram every frame. */
export function transformToCss(t: Transform): string {
  return `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`;
}
