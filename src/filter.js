"use strict";

/**
 * Builds the libavfilter graph that flattens a VR frame.
 *
 * The chain is two filters:
 *
 *   1. `crop` picks one eye out of the packed frame. Cropping costs nothing —
 *      it only moves the plane pointers — and it gives us free choice of eye,
 *      which `v360`'s own `in_stereo` handling does not (that always keeps the
 *      left one). Verified byte-identical to `in_stereo=sbs:out_stereo=2d`.
 *
 *   2. `v360` reprojects that eye onto a flat rectilinear image aimed at
 *      `yaw` / `pitch` with a `d_fov` diagonal field of view.
 *
 * `yaw`, `pitch` and `d_fov` are all runtime-settable options, so panning and
 * zooming go through `vf-command` and never rebuild the filter chain.
 * Everything else — projection, eye, output size, interpolation — is fixed at
 * build time and needs the chain re-created.
 *
 * Pure string building, no `iina` API use, unit tested with plain node.
 */

var LABEL = "vr2d";

/**
 * `crop` expression that isolates one eye.
 * @param {string} layout "sbs", "tb" or "mono"
 * @param {boolean} swapEyes true when the right eye is stored first
 * @param {string} eye "left" or "right"
 * @returns {string|null} null when there is nothing to crop
 */
function eyeCrop(layout, swapEyes, eye) {
  if (layout !== "sbs" && layout !== "tb") return null;
  // XOR: asking for the right eye, or the eyes being stored swapped, each flip
  // which half we want; both together cancel out.
  var secondHalf = (eye === "right") !== !!swapEyes;
  if (layout === "sbs") {
    return secondHalf ? "crop=iw/2:ih:iw/2:0" : "crop=iw/2:ih:0:0";
  }
  return secondHalf ? "crop=iw:ih/2:0:ih/2" : "crop=iw:ih/2:0:0";
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Build the `v360` invocation.
 *
 * @param {object} source detector output (`projection`, `inHFov`, `inVFov`)
 * @param {object} view `{yaw, pitch, fov}` in degrees
 * @param {object} out `{width, height, interp}`
 */
function buildV360(source, view, out) {
  var opts = [
    "input=" + source.projection,
    "output=flat",
    "interp=" + (out.interp || "line"),
    "w=" + out.width,
    "h=" + out.height,
    // session.flush sends absolute angles. FFmpeg otherwise accumulates each
    // runtime rotation, causing over-rotation and a jump when we rebuild.
    "reset_rot=1",
  ];

  // Equirectangular and cubemap inputs already default to the full sphere;
  // only the hemispherical and fisheye inputs need their coverage spelled out.
  if (source.projection === "he" || source.projection === "fisheye") {
    opts.push("ih_fov=" + round2(source.inHFov));
    opts.push("iv_fov=" + round2(source.inVFov));
  }

  opts.push("d_fov=" + round2(view.fov));
  opts.push("yaw=" + round2(view.yaw));
  opts.push("pitch=" + round2(view.pitch));
  opts.push("roll=0");

  return "v360=" + opts.join(":");
}

/** The full libavfilter graph description, without mpv's wrapper. */
function buildGraph(source, view, out, eye) {
  var crop = eyeCrop(source.layout, source.swapEyes, eye || "left");
  var v360 = buildV360(source, view, out);
  return crop ? crop + "," + v360 : v360;
}

/**
 * The value handed to mpv's `vf add`. The `@vr2d` label lets us remove or
 * address just our own filter and leave any user filters untouched.
 */
function buildVfValue(source, view, out, eye) {
  return "@" + LABEL + ":lavfi=[" + buildGraph(source, view, out, eye) + "]";
}

/**
 * The `v360` options that can be changed live with `vf-command`. Anything not
 * listed here needs the chain rebuilt.
 */
var RUNTIME_OPTIONS = ["yaw", "pitch", "d_fov", "roll", "h_flip", "v_flip"];

module.exports = {
  LABEL: LABEL,
  eyeCrop: eyeCrop,
  buildV360: buildV360,
  buildGraph: buildGraph,
  buildVfValue: buildVfValue,
  RUNTIME_OPTIONS: RUNTIME_OPTIONS,
};
