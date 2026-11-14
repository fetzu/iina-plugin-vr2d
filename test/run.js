"use strict";

/**
 * Tests for the pure modules — detection, frustum maths and filter-string
 * building. No `iina` API is involved, so this runs anywhere node does:
 *
 *   node test/run.js
 */

var detect = require("../src/detect.js");
var geometry = require("../src/geometry.js");
var filter = require("../src/filter.js");

var passed = 0;
var failures = [];

function check(name, actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(name + "\n    expected " + e + "\n    got      " + a);
}

function checkNear(name, actual, expected, tolerance) {
  if (Math.abs(actual - expected) <= tolerance) passed++;
  else failures.push(name + "\n    expected " + expected + " ±" + tolerance + ", got " + actual);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function d(url, width, height, extra) {
  var info = { url: url, width: width, height: height };
  if (extra) Object.keys(extra).forEach(function (k) { info[k] = extra[k]; });
  var r = detect.detect(info);
  return {
    layout: r.layout,
    swap: r.swapEyes,
    projection: r.projection,
    hFov: r.inHFov,
    auto: r.auto,
  };
}

// The naming convention from the brief.
check(
  "180_180x180_3dh_LR",
  d("/v/Studio_Title_180_180x180_3dh_LR.mp4", 3840, 1920),
  { layout: "sbs", swap: false, projection: "he", hFov: 180, auto: true }
);

// Right eye stored first.
check(
  "3dh_RL swaps eyes",
  d("/v/Title_180x180_3dh_RL.mp4", 3840, 1920),
  { layout: "sbs", swap: true, projection: "he", hFov: 180, auto: true }
);

// Lens profiles imply fisheye plus, by convention, a side-by-side pair.
check(
  "MKX200 fisheye",
  d("/v/Title_MKX200_alpha.mp4", 4096, 2048),
  { layout: "sbs", swap: false, projection: "fisheye", hFov: 200, auto: true }
);
check(
  "MKX220 fisheye",
  d("/v/Title_MKX220.mp4", 4096, 2048),
  { layout: "sbs", swap: false, projection: "fisheye", hFov: 220, auto: true }
);
check(
  "RF52 dual fisheye",
  d("/v/Canon_RF52_clip.mp4", 3840, 1920),
  { layout: "sbs", swap: false, projection: "fisheye", hFov: 190, auto: true }
);

// 360° over-under: a 1:1 frame whose halves are each 2:1.
check(
  "360 3dv over-under",
  d("/v/Title_360_3dv_TB.mp4", 3840, 3840),
  { layout: "tb", swap: false, projection: "e", hFov: 360, auto: true }
);

// 360° side-by-side is a 4:1 frame.
check(
  "360 side-by-side",
  d("/v/Title_360_sbs.mp4", 7680, 1920),
  { layout: "sbs", swap: false, projection: "e", hFov: 360, auto: true }
);

/*
 * Equi-angular cubemap. Six cube faces packed 3x2 make a 3:2 eye, which is not
 * one of the two shapes the common-layout table knows about. That used to read
 * as "this frame cannot be VR" and left EAC files switched off however
 * explicitly they were named, so all three of these are regression tests.
 */
check(
  "EAC monoscopic",
  d("/v/Title_360_eac.mp4", 3072, 2048),
  { layout: "mono", swap: false, projection: "eac", hFov: 360, auto: true }
);
check(
  "EAC over-under",
  d("/v/Title_eac_3dv_TB.mp4", 3072, 4096),
  { layout: "tb", swap: false, projection: "eac", hFov: 360, auto: true }
);
check(
  "EAC side-by-side",
  d("/v/Title_equiangular_sbs.mp4", 6144, 2048),
  { layout: "sbs", swap: false, projection: "eac", hFov: 360, auto: true }
);

// ...but a 3:2 frame is a perfectly ordinary shape, so accepting it for EAC
// must not make every 3:2 video with a stereo-sounding word in its name a
// candidate.
check(
  "3:2 video named 3dh stays off",
  d("/v/Holiday_3dh.mp4", 3000, 2000),
  { layout: "sbs", swap: false, projection: "he", hFov: 180, auto: false }
);
check(
  "3:2 video named 2d stays off",
  d("/v/Something_2d.mp4", 3000, 2000),
  { layout: "mono", swap: false, projection: "e", hFov: 360, auto: false }
);

// A bare "180" on a square frame is monoscopic 180, not a stereo pair.
check(
  "180 mono is square",
  d("/v/Title_vr180_mono.mp4", 2880, 2880),
  { layout: "mono", swap: false, projection: "he", hFov: 180, auto: true }
);

// Container metadata alone is enough.
check(
  "container stereo flag",
  d("/v/no_hints_in_name.mp4", 4096, 2048, { stereoIn: "sbs2l" }),
  { layout: "sbs", swap: false, projection: "he", hFov: 180, auto: true }
);
check(
  "container stereo flag, right eye first",
  d("/v/no_hints_in_name.mp4", 4096, 2048, { stereoIn: "sbs2r" }),
  { layout: "sbs", swap: true, projection: "he", hFov: 180, auto: true }
);
check(
  "container says mono",
  d("/v/holiday.mp4", 1920, 1080, { stereoIn: "mono" }),
  { layout: "mono", swap: false, projection: "e", hFov: 360, auto: false }
);

// Ordinary videos must be left alone. The descriptor still gets filled in --
// it is what a manual "turn it on anyway" would use -- but `auto` stays false.
check(
  "ordinary 16:9 film",
  d("/v/Some.Film.2024.1080p.BluRay.x264-GRP.mkv", 1920, 1080),
  { layout: "mono", swap: false, projection: "e", hFov: 360, auto: false }
);
check(
  "ordinary 2:1 film without hints stays off",
  d("/v/Some.Documentary.2160p.mp4", 3840, 1920),
  { layout: "mono", swap: false, projection: "e", hFov: 360, auto: false }
);

// Weak hints need the aggressive setting before they count.
check(
  "weak hint alone stays off",
  d("/v/My_VR_clip_360.mp4", 3840, 1920),
  { layout: "mono", swap: false, projection: "e", hFov: 360, auto: false }
);
check(
  "weak hint with aggressive detection",
  d("/v/My_VR_clip_360.mp4", 3840, 1920, { aggressive: true }),
  { layout: "mono", swap: false, projection: "e", hFov: 360, auto: true }
);

// A strong name signal contradicted by the frame shape should not auto-engage.
check(
  "sbs tag on a 16:9 frame does not auto-engage",
  d("/v/weird_sbs_tag.mp4", 1920, 1080).auto,
  false
);

// URLs, escaping and extensions.
check(
  "percent-escaped URL",
  d("file:///Users/x/My%20Clip_180x180_3dh_LR.mp4", 3840, 1920).layout,
  "sbs"
);
check("tokenizer", detect.tokenize("/a/Clip_180_180x180_3dh_LR.mp4"), [
  "clip", "180", "180x180", "3dh", "lr",
]);
check("basename strips query", detect.basename("http://h/v/Clip_180x180.mp4?token=1"), "Clip_180x180");

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// A 90° diagonal on a 16:9 frame splits into a wider horizontal, narrower
// vertical, and both must invert cleanly.
var parts = geometry.fovComponents(90, 1920, 1080);
checkNear("horizontal component of 90° diagonal", parts.h, 82.15, 0.05);
checkNear("vertical component of 90° diagonal", parts.v, 52.23, 0.05);
checkNear(
  "diagonalFromHorizontal inverts fovComponents",
  geometry.diagonalFromHorizontal(parts.h, 1920, 1080),
  90,
  0.01
);
checkNear(
  "diagonalFromVertical inverts fovComponents",
  geometry.diagonalFromVertical(parts.v, 1920, 1080),
  90,
  0.01
);

check("wrap180 folds past the seam", geometry.wrap180(200), -160);
check("wrap180 leaves in-range angles alone", geometry.wrap180(-90), -90);

var hemisphere = { inHFov: 180, inVFov: 180 };
var sphere = { inHFov: 360, inVFov: 180 };

// On a hemisphere the view can never be aimed at the void outside it.
var clamped = geometry.clampView({ yaw: 175, pitch: 0, fov: 90 }, hemisphere, 1920, 1080);
checkNear("yaw is fenced in on a hemisphere", clamped.yaw, (180 - parts.h) / 2, 0.5);

// On a full sphere yaw is free but wraps.
check(
  "yaw wraps on a full sphere",
  geometry.clampView({ yaw: 200, pitch: 0, fov: 90 }, sphere, 1920, 1080).yaw,
  -160
);

// Pitch stops before the poles.
var pitched = geometry.clampView({ yaw: 0, pitch: 89, fov: 90 }, sphere, 1920, 1080);
checkNear("pitch stops short of the pole", pitched.pitch, (180 - parts.v) / 2, 0.5);

// A 180° hemisphere comfortably contains the widest view we ever render, so
// nothing is clipped there...
check(
  "a hemisphere does not restrict zoom-out",
  geometry.clampView({ yaw: 0, pitch: 0, fov: 149 }, hemisphere, 1920, 1080).fov,
  149
);
// ...but a narrower source does, and the cap lands exactly on its coverage.
var narrow = { inHFov: 100, inVFov: 100 };
var zoomedOut = geometry.clampView({ yaw: 0, pitch: 0, fov: 149 }, narrow, 1920, 1080);
checkNear("zoom-out is capped by a narrow source", zoomedOut.fov, 107.7, 0.2);
checkNear(
  "the capped view exactly fills the source horizontally",
  geometry.fovComponents(zoomedOut.fov, 1920, 1080).h,
  100,
  0.05
);

// Dragging right swings the view left; dragging down tips it up.
var dragged = geometry.applyDrag(
  { yaw: 0, pitch: 0, fov: 90 },
  { dx: 100, dy: 100, width: 1920, height: 1080 },
  1
);
check("drag right looks left", dragged.yaw < 0, true);
check("drag down looks up", dragged.pitch > 0, true);
checkNear("a full-width drag sweeps one horizontal field",
  geometry.applyDrag({ yaw: 0, pitch: 0, fov: 90 }, { dx: 1920, dy: 0, width: 1920, height: 1080 }, 1).yaw,
  -parts.h, 0.01);

check("zoom in reduces the field", geometry.applyZoom({ yaw: 0, pitch: 0, fov: 90 }, -1).fov < 90, true);
check("zoom out widens the field", geometry.applyZoom({ yaw: 0, pitch: 0, fov: 90 }, 1).fov > 90, true);

// The starting view is configured horizontally, since that is how the width of
// a shot actually reads on screen. The old 90° *diagonal* default came out at
// only ~82° across, which looked cropped in on 180° footage.
var startDiagonal = geometry.diagonalFromHorizontal(105, 2832, 1770);
checkNear(
  "105° across is what the default asks for",
  geometry.fovComponents(startDiagonal, 2832, 1770).h,
  105,
  0.01
);
check(
  "the new default really is wider than the old one",
  geometry.fovComponents(startDiagonal, 2832, 1770).h >
    geometry.fovComponents(90, 2832, 1770).h,
  true
);
// It must still survive clamping against a 180° source rather than being
// silently pulled back in.
check(
  "the default view fits inside a 180° source",
  Math.abs(
    geometry.clampView({ yaw: 0, pitch: 0, fov: startDiagonal }, hemisphere, 2832, 1770).fov -
      startDiagonal
  ) < 0.01,
  true
);

// ---------------------------------------------------------------------------
// Filter building
// ---------------------------------------------------------------------------

check("sbs left eye crop", filter.eyeCrop("sbs", false, "left"), "crop=iw/2:ih:0:0");
check("sbs right eye crop", filter.eyeCrop("sbs", false, "right"), "crop=iw/2:ih:iw/2:0");
check("sbs swapped, left eye is the right half", filter.eyeCrop("sbs", true, "left"), "crop=iw/2:ih:iw/2:0");
check("sbs swapped, right eye is the left half", filter.eyeCrop("sbs", true, "right"), "crop=iw/2:ih:0:0");
check("tb left eye crop", filter.eyeCrop("tb", false, "left"), "crop=iw:ih/2:0:0");
check("tb swapped left eye crop", filter.eyeCrop("tb", true, "left"), "crop=iw:ih/2:0:ih/2");
check("mono needs no crop", filter.eyeCrop("mono", false, "left"), null);

var source180 = { layout: "sbs", swapEyes: false, projection: "he", inHFov: 180, inVFov: 180 };
var out = { width: 1920, height: 1080, interp: "line" };

check(
  "180 sbs graph",
  filter.buildGraph(source180, { yaw: 10, pitch: -5, fov: 90 }, out, "left"),
  "crop=iw/2:ih:0:0,v360=input=he:output=flat:interp=line:w=1920:h=1080:reset_rot=1:" +
    "ih_fov=180:iv_fov=180:d_fov=90:yaw=10:pitch=-5:roll=0"
);

check(
  "labelled mpv filter value",
  filter.buildVfValue(source180, { yaw: 0, pitch: 0, fov: 90 }, out, "left").slice(0, 21),
  "@vr2d:lavfi=[crop=iw/"
);

// Equirect and cubemap inputs already cover the whole sphere, so no ih/iv_fov.
var source360 = { layout: "mono", swapEyes: false, projection: "e", inHFov: 360, inVFov: 180 };
check(
  "360 mono graph omits input fov",
  filter.buildGraph(source360, { yaw: 0, pitch: 0, fov: 90 }, out, "left"),
  "v360=input=e:output=flat:interp=line:w=1920:h=1080:reset_rot=1:d_fov=90:yaw=0:pitch=0:roll=0"
);

var sourceFish = { layout: "sbs", swapEyes: false, projection: "fisheye", inHFov: 200, inVFov: 200 };
check(
  "fisheye graph carries the lens fov",
  filter.buildGraph(sourceFish, { yaw: 0, pitch: 0, fov: 90 }, out, "right").indexOf("ih_fov=200:iv_fov=200") > 0,
  true
);

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  failures.forEach(function (f, i) {
    console.error("  " + (i + 1) + ". " + f + "\n");
  });
  process.exit(1);
}
console.log(passed + " checks passed");
