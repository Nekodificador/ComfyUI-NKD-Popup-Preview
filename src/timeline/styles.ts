/**
 * Widget CSS, injected by hand into a <style> with a fixed id.
 *
 * Deliberately NOT `vite-plugin-css-injected-by-js`: with multiple entries the plugin
 * picks which chunk carries all the CSS, and a desynchronised scope-id leaves the widget
 * with no styles at all (documented in the nkd-node skill). A <style> with an id is
 * idempotent and cannot desynchronise.
 *
 * Note there is no `height` on `.nkd-tl-canvas`: it is pinned in px from JS, because the
 * timeline has a fixed intrinsic height while the preview derives its own from
 * `aspect-ratio`.
 */
const STYLE_ID = "nkd-timeline-styles";

const CSS = `
.nkd-tl {
  display: flex; flex-direction: column; gap: 4px;
  width: 100%; box-sizing: border-box;
  font: 12px system-ui, sans-serif; color: #c8d0e0;
  outline: none;
  container-type: inline-size;
}
.nkd-tl-preview {
  /* max-width is set from JS (height cap x aspect) and margin auto centres it, so
     widening the node stretches the TIMELINE rather than the monitor. */
  width: 100%; display: block; margin: 0 auto;
  background: #000; border: 1px solid #3a3d46; border-radius: 6px;
  min-height: 60px;
}
.nkd-tl-canvas {
  width: 100%; display: block;
  background: #111318; border: 1px solid #3a3d46; border-radius: 6px;
  touch-action: none;   /* the drag is ours, not the browser's scroll */
}
.nkd-tl-bar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 6px;
  padding: 4px 6px;
}
/* Button families. The rule is drawn by the ADJACENT-sibling selector so it only ever
   falls BETWEEN two groups: a separator element of its own would survive into a wrapped
   line and hang there with nothing to its left. */
.nkd-tl-grp { display: flex; align-items: center; gap: 4px; }
.nkd-tl-grp + .nkd-tl-grp {
  border-left: 1px solid #3a3d46; padding-left: 7px; margin-left: 3px;
}
.nkd-tl-btn {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; cursor: pointer;
  padding: 3px 7px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.nkd-tl-btn:hover { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-tl-btn.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-tl-btn .pi { font-size: 12px; color: inherit; }
/* ComfyUI loads the MDI font but its stylesheet only sets the glyph content, not the
   family - so it has to be named here or every MDI button renders as a tofu box.
   (No backticks in this file: the CSS lives in a template literal.) */
.nkd-tl-btn .mdi {
  font-family: "Material Design Icons"; font-size: 14px; color: inherit;
  line-height: 1; font-style: normal;
}
/* In/out brackets: monochrome text, sized in the button so the box does not depend on
   the host's base font. Matches the [ ] drawn on the ruler. */
.nkd-tl-brk {
  font: bold 13px ui-monospace, monospace; color: inherit;
  display: block; width: 12px; line-height: 12px;
}
.nkd-tl-status {
  margin-left: auto; color: rgba(255,255,255,0.45);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* Right-click menu. Lives on <body>, not inside the node: within the graph canvas it
   would be clipped by the node box and scaled by the canvas zoom transform. */
.nkd-tl-menu {
  position: fixed; z-index: 10000; min-width: 170px;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 6px;
  padding: 4px; box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  font: 12px system-ui, sans-serif;
}
.nkd-tl-menu-item {
  display: block; width: 100%; text-align: left;
  background: none; border: 0; border-radius: 4px;
  color: #c8d0e0; padding: 5px 8px; cursor: pointer;
}
.nkd-tl-menu-item:hover { background: #252830; color: #4ab4ff; }
.nkd-tl-menu-item.on { color: #4ab4ff; }
.nkd-tl-menu-item.on::after { content: " ✓"; }
/* Container query, not a media query: the node resizes, the window does not. */
@container (max-width: 330px) { .nkd-tl-status { display: none; } }

/* 😺NKD Video Viewer. Shares .nkd-tl-bar/-btn/-status above rather than restating them. */
.nkd-vid-stage {
  /* aspect-ratio gives the height; max-width is set from JS so widening the node does not
     grow the picture (a portrait clip would otherwise turn the node into a column). */
  width: 100%; margin: 0 auto; position: relative;
  background: #000; border: 1px solid #3a3d46; border-radius: 6px;
  overflow: hidden;
}
.nkd-vid-el {
  position: absolute; inset: 0;
  width: 100%; height: 100%; object-fit: contain; display: block;
}
.nkd-vid-scrub {
  width: 100%; height: 44px; display: block;
  border: 1px solid #3a3d46; border-radius: 6px;
  cursor: pointer; touch-action: none;   /* the drag is ours, not the browser's scroll */
}
.nkd-vid a.nkd-tl-btn { text-decoration: none; }
.nkd-vid-path {
  font: 11px ui-monospace, monospace; color: rgba(255,255,255,0.40);
  padding: 0 2px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.nkd-vid-path:hover { color: #4ab4ff; }
.nkd-vid-path:empty { display: none; }
/* A/B compare. The reference is a second <video> stacked on top and clipped back, so the
   composite is the browser's, not an approximation. */
.nkd-vid-ref { z-index: 1; pointer-events: none; }
.nkd-vid-divider {
  position: absolute; top: 0; bottom: 0; width: 2px; z-index: 2;
  background: #4ab4ff; box-shadow: 0 0 6px rgba(0,0,0,0.6);
  pointer-events: none;
}
.nkd-vid-divider::before, .nkd-vid-divider::after {
  content: ""; position: absolute; left: 50%; transform: translateX(-50%);
  border: 5px solid transparent;
}
.nkd-vid-divider::before { top: 50%; margin-top: -14px; border-bottom-color: #4ab4ff; }
.nkd-vid-divider::after { top: 50%; margin-top: 4px; border-top-color: #4ab4ff; }

/* Full screen: the whole widget goes, so the transport and the compare controls come with
   it. The picture takes whatever is left and letterboxes itself.
   !important is not decoration here - max-width and aspect-ratio are written INLINE from
   JS (the height cap that stops a wide node growing the monitor), and inline wins over a
   plain rule. In full screen that cap is exactly what has to go. */
.nkd-vid:fullscreen {
  display: flex; flex-direction: column; gap: 6px;
  width: 100vw; height: 100vh; box-sizing: border-box;
  padding: 8px; background: #000;
}
.nkd-vid:fullscreen .nkd-vid-stage {
  flex: 1 1 auto; min-height: 0;
  max-width: none !important; aspect-ratio: auto !important;
  border: 0; border-radius: 0;
}
.nkd-vid:fullscreen .nkd-vid-scrub { flex: 0 0 auto; }
.nkd-vid:fullscreen .nkd-tl-bar { flex: 0 0 auto; }

/* Stand-in left in the node while the viewer is off in its own window. Without it the
   widget row collapses and the node just looks broken. */
.nkd-vid-away {
  display: flex; align-items: center; justify-content: center;
  min-height: 90px; border: 1px dashed #3a3d46; border-radius: 6px;
  color: rgba(255,255,255,0.35); font: 12px system-ui, sans-serif;
}

/* Project chip + its picker. Reuses .nkd-tl-btn and .nkd-tl-menu so a chip in the video
   viewer, in the popup node and in a menu all read as the same control. */
.nkd-proj-chip { gap: 5px; max-width: 190px; font: 11px system-ui, sans-serif; }
.nkd-proj-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nkd-proj-head {
  padding: 6px 8px 3px; color: rgba(255,255,255,0.35);
  font: 10px system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.06em;
}
.nkd-proj-modal {
  position: fixed; inset: 0; z-index: 10001;
  background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center;
}
.nkd-proj-box {
  display: flex; flex-direction: column; gap: 6px;
  width: min(460px, 92vw); padding: 14px;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6);
  font: 12px system-ui, sans-serif; color: #c8d0e0;
}
.nkd-proj-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.nkd-proj-lab { color: rgba(255,255,255,0.45); font-size: 11px; margin-top: 4px; }
.nkd-proj-area, .nkd-proj-input {
  background: #111318; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; padding: 6px 8px; font: 12px ui-monospace, monospace;
  resize: vertical;
}
.nkd-proj-area { min-height: 96px; }
.nkd-proj-area-sm { min-height: 56px; }
.nkd-proj-row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }

/* 😺NKD Popup Preview, in-node panel: same bar, same buttons, same path line as the video
   viewer - two nodes in one pack should not speak two different dialects.
   No thumbnail of its own: ComfyUI already renders the node's preview from nodeOutputs,
   so one was the same pixels twice and a taller node for nothing.
   (No backticks in this file: the CSS lives in a template literal.) */
.nkd-pp-bar {
  flex-wrap: nowrap;       /* the buttons must never drop to a second line */
  width: max-content;      /* content-sized, so offsetWidth is the intrinsic row width */
  max-width: none;
}
`;

export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
