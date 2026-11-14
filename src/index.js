"use strict";

/**
 * VR2D — watch 3D VR video flat.
 *
 * Wiring layer: detects the source when a file loads, exposes the controls
 * (menu, keyboard, overlay drag surface), and hands everything to `session`,
 * which owns the state and the mpv filter.
 */

var detect = require("./detect.js");
var diag = require("./diag.js");
var exporter = require("./export.js");
var geometry = require("./geometry.js");
var presets = require("./presets.js");
var session = require("./session.js");

var core = iina.core;
var console = iina.console;
var event = iina.event;
var input = iina.input;
var menu = iina.menu;
var mpv = iina.mpv;
var overlay = iina.overlay;
var preferences = iina.preferences;

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

var DEFAULTS = {
  autoEnable: true,
  aggressiveDetection: false,
  dragToPan: true,
  showHud: true,
  invertDrag: false,
  // Horizontal, because that is how people think about field of view. A 180°
  // source at 105° horizontal shows a bit over half of what it holds, which is
  // roughly what a headset shows you; the old 90° *diagonal* default worked out
  // to only ~80° horizontal and felt cropped in.
  fieldOfView: 105,
  quality: 0, // 0 = match the display; otherwise a maximum height
  interp: "cubic",
  updateRate: 0, // 0 = pace automatically from the rendered size
  dragSensitivity: 1,
  keyStep: 35, // per cent of the visible field per second
  eye: "left",
  bottomSafeArea: 120,
  topSafeArea: 56,
};

function pref(key) {
  var value = preferences.get(key);
  return value === undefined || value === null || value === "" ? DEFAULTS[key] : value;
}

function prefNumber(key) {
  var n = Number(pref(key));
  return isFinite(n) ? n : Number(DEFAULTS[key]);
}

function prefBool(key) {
  var value = pref(key);
  return value === true || value === "true" || value === 1;
}

/**
 * Remember which eye to show. IINA only writes a plugin's preferences to disk
 * when its settings page closes, so anything set from code has to ask for that
 * explicitly or it is forgotten when the player quits.
 */
function rememberEye(eye) {
  preferences.set("eye", eye);
  preferences.sync();
}

/*
 * Notice preference changes.
 *
 * IINA has no "preferences changed" event. Most of VR2D's settings are read
 * where they are used, so they take effect as soon as the settings window is
 * closed. These do not: the first three are baked into the filter chain when
 * the output is configured, and the last two into the overlay when it is shown,
 * so without a nudge they would appear to do nothing until the file was
 * reopened. Comparing a handful of values every couple of seconds costs
 * nothing and makes the settings behave the way the page implies they do.
 */
var WATCHED_PREFS = ["quality", "interp", "updateRate", "dragToPan", "showHud"];
var prefSignature = null;

function preferenceSignature() {
  return WATCHED_PREFS.map(function (key) {
    return String(pref(key));
  }).join("|");
}

function applyChangedPreferences() {
  var next = preferenceSignature();
  if (next === prefSignature) return;
  prefSignature = next;
  refreshOverlay();
  if (session.state.enabled) {
    applyOutput();
    applyUpdateRate();
  }
}

// ---------------------------------------------------------------------------
// Output sizing
// ---------------------------------------------------------------------------

/*
 * Output sizing, and why it is not adaptive.
 *
 * IINA resizes the player window to match the video whenever the video's size
 * changes — measured, and it holds even when the aspect ratio is identical
 * (halving the output took a 640x400 window to 320x200). The reprojection is
 * the "video" as far as IINA is concerned, so anything that changes its size
 * drags the user's window along with it.
 *
 * That rules out the obvious trick of rendering smaller while panning and
 * sharper when still: it would resize the window on every drag. So the size is
 * chosen once, to exactly the window's own pixel count, which is both the
 * sharpest possible result and a fixed point that leaves the window alone.
 */

// The window we expect to keep while VR2D is on, and the display's pixel
// density, both captured before the filter is attached — afterwards
// `osd-dimensions` reports our own output rather than the window.
var heldFrame = null;
var backingScale = 2;
var reconfigGuardUntil = 0;

/**
 * Run `callback` once the window has stopped changing size.
 *
 * A file-loaded handler runs before the window has been laid out for the new
 * video, and the frame reported then is a placeholder. Since our output size
 * decides the window size, measuring too early locks the window to that
 * placeholder and shrinks it for the rest of the file.
 */
function whenWindowSettled(callback) {
  var previous = null;
  var attempts = 0;
  function poll() {
    attempts += 1;
    var key = null;
    try {
      var frame = core.window.frame;
      if (frame && frame.width > 0) key = Math.round(frame.width) + "x" + Math.round(frame.height);
    } catch (e) {
      // Window not ready at all yet.
    }
    if ((key !== null && key === previous) || attempts >= 12) {
      callback();
      return;
    }
    previous = key;
    setTimeout(poll, 150);
  }
  setTimeout(poll, 150);
}

/**
 * How many pixels the display puts behind one point.
 *
 * mpv knows this directly, and its answer is a property of the screen rather
 * than of the video, so it stays right while our filter is running and follows
 * the window from a Retina display to a plain one.
 *
 * The fallback measures it — window pixels over window points — but that is
 * only meaningful while VR2D is off. Once the filter is attached
 * `osd-dimensions` reports *our own output*, so the same arithmetic returns the
 * ratio between the render size and the window instead of the display scale.
 * Believing that used to halve the render size on the first window resize, and
 * because the output size decides the window size, IINA then shrank the window
 * to match — the "window suddenly resized to half" report.
 */
function measureBackingScale(frame) {
  /*
   * The ratio is only a backing scale if the video actually spans the window.
   * It does not in picture-in-picture (the video goes to a separate floating
   * window while `core.window.frame` still reports the main one — measured at
   * 740 against 1440) or in music mode (600 against a 640-wide window), and it
   * does not once our own filter is attached, because then `osd-dimensions`
   * reports our output. In all of those the ratio comes out below 1 and means
   * nothing, so it is rejected rather than believed.
   */
  if (!session.state.attached) {
    try {
      var osd = mpv.getNative("osd-dimensions");
      if (osd && osd.w >= frame.width) {
        var measured = geometry.clamp(Math.round(osd.w / frame.width), 1, 3);
        diag.log("scale-measured", measured + " osd=" + osd.w + " frame=" + frame.width);
        return measured;
      }
    } catch (e) {
      // Fall through to mpv's own answer.
    }
  }
  try {
    var hidpi = mpv.getNumber("display-hidpi-scale");
    if (hidpi > 0) {
      diag.log("scale-hidpi", String(hidpi));
      return geometry.clamp(hidpi, 1, 3);
    }
  } catch (e) {
    // Older mpv, or the property is not readable yet.
  }
  return backingScale;
}

function captureWindowBaseline() {
  try {
    var frame = core.window.frame;
    if (!frame || !(frame.width > 0)) return;
    heldFrame = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    backingScale = measureBackingScale(frame);
    diag.log("baseline", frame.width + "x" + frame.height + " scale=" + backingScale);
  } catch (e) {
    // Window not ready; the defaults are reasonable.
  }
}

/**
 * Render at the window's true pixel size. Anything smaller is upscaled by IINA
 * and looks soft — that is the whole of the sharpness question here.
 */
function computeOutput() {
  var width = 1920;
  var height = 1080;
  if (heldFrame && heldFrame.width > 0) {
    width = heldFrame.width * backingScale;
    height = heldFrame.height * backingScale;
  }

  var cap = prefNumber("quality"); // 0 = let the source decide
  if (cap > 0 && height > cap) {
    width = (width * cap) / height;
    height = cap;
  }

  /*
   * Never render more pixels than the source can actually fill.
   *
   * Pushing the view to mpv blocks the plugin thread while v360 rebuilds its
   * remap table, and that cost is proportional to output pixels — 54 ms at
   * 3024x1512, enough to stall a drag. Most of those pixels are invented: a
   * 1440-wide eye covering 180° holds 8 pixels per degree, so a 105° view is
   * worth about 840 of them. Rendering a comfortable multiple of that is
   * sharp to the eye and several times cheaper to move around in.
   *
   * A high-resolution source justifies the full display size and gets it; it
   * is only the upscaling that is skipped.
   */
  var justified = resolvableWidth();
  if (justified > 0 && justified < width) {
    height = (height * justified) / width;
    width = justified;
  }

  // Exactly the target, rounded only to even numbers for chroma subsampling.
  // Quantising coarser than this skews the aspect ratio and letterboxes the
  // result; churn from small window jiggles is suppressed in applyOutput.
  return {
    width: Math.max(320, Math.round(width / 2) * 2),
    height: Math.max(180, Math.round(height / 2) * 2),
    interp: ["near", "line", "cubic", "lanczos", "spline16"].indexOf(pref("interp")) >= 0
      ? pref("interp")
      : "cubic",
  };
}

/**
 * How often to push the view to mpv while panning.
 *
 * Every step makes `v360` rebuild its remap table, and that costs about
 * 0.064 s of CPU per megapixel of output — 0.29 s at 3024x1512. Two of those
 * per step (yaw and pitch) at a fixed 30 Hz would ask for more CPU than the
 * machine has. So the rate is derived from the size actually being rendered,
 * keeping the filter inside a couple of cores' worth of work.
 */
var CPU_SECONDS_PER_MEGAPIXEL = 0.064;
var PAN_CPU_BUDGET = 4.0; // CPU-seconds per wall second

function autoUpdateRate(out) {
  var megapixels = (out.width * out.height) / 1e6;
  var perStep = 2 * CPU_SECONDS_PER_MEGAPIXEL * megapixels;
  return Math.round(geometry.clamp(PAN_CPU_BUDGET / perStep, 10, 30));
}

function applyUpdateRate() {
  var configured = prefNumber("updateRate");
  session.setUpdateRate(configured > 0 ? configured : autoUpdateRate(session.state.out));
}

/** How wide an output the source's own detail can justify, in pixels. */
function resolvableWidth() {
  var src = session.source();
  var size = videoSize();
  if (!src || !size) return 0;
  var eyeWidth = src.layout === "sbs" ? size.width / 2 : size.width;
  var pixelsPerDegree = eyeWidth / Math.max(1, src.inHFov);
  // 1.8x the source's own density: comfortably past the point where more
  // pixels stop adding visible detail, without paying for a blind upscale.
  return Math.round(pixelsPerDegree * prefNumber("fieldOfView") * 1.8);
}

/**
 * The starting view, as a diagonal FOV. The preference is horizontal, so it has
 * to be converted for whatever shape the output actually is.
 */
function startingFov(out) {
  return geometry.diagonalFromHorizontal(prefNumber("fieldOfView"), out.width, out.height);
}

/** Put the window back where it was after our own output change moved it. */
function holdWindow() {
  if (!heldFrame || Date.now() > reconfigGuardUntil) return;
  try {
    var frame = core.window.frame;
    if (Math.abs(frame.width - heldFrame.width) < 2 && Math.abs(frame.height - heldFrame.height) < 2) {
      return;
    }
    core.window.frame = heldFrame;
  } catch (e) {
    // Nothing to do if the window has gone away.
  }
}

function applyOutput() {
  var next = computeOutput();
  var current = session.state.out;
  diag.log(
    "applyOutput",
    current.width + "x" + current.height + " -> " + next.width + "x" + next.height +
      " held=" + (heldFrame ? heldFrame.width + "x" + heldFrame.height : "none") +
      " scale=" + backingScale
  );
  // Rebuilding the chain is disruptive, so ignore changes too small to see.
  if (
    session.state.attached &&
    next.interp === current.interp &&
    Math.abs(next.width - current.width) < 24 &&
    Math.abs(next.height - current.height) < 24
  ) {
    return;
  }
  reconfigGuardUntil = Date.now() + 900;
  session.setOutput(next);
  applyUpdateRate();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function videoSize() {
  var width = core.status.videoWidth;
  var height = core.status.videoHeight;
  if (!(width > 0) || !(height > 0)) {
    // `core.status` can lag a touch behind file-loaded; mpv always knows.
    try {
      width = mpv.getNumber("width");
      height = mpv.getNumber("height");
    } catch (e) {
      return null;
    }
  }
  return width > 0 && height > 0 ? { width: width, height: height } : null;
}

function analyzeCurrentFile() {
  var size = videoSize();
  if (!size) return null;

  var stereoIn = null;
  try {
    stereoIn = mpv.getString("video-params/stereo-in");
  } catch (e) {
    // Property missing on this mpv build or no video track; name-based
    // detection still works.
  }

  return detect.detect({
    url: core.status.url,
    width: size.width,
    height: size.height,
    stereoIn: stereoIn,
    aggressive: prefBool("aggressiveDetection"),
  });
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

function osd(message) {
  try {
    if (core.window.loaded) core.osd(message);
  } catch (e) {
    console.log(message);
  }
}

function enableVR2D(announce) {
  if (!session.state.detected) {
    osd("VR2D: nothing to flatten — no video loaded");
    return;
  }
  // Measure the window before attaching: once the filter is running,
  // `osd-dimensions` reports our own output instead of the window.
  captureWindowBaseline();
  applyOutput();
  if (!session.enable(startingFov(session.state.out))) return;

  refreshOverlay();
  updateMenu();
  if (announce) osd("VR2D on — " + session.describe());
}

function disableVR2D(announce) {
  if (!session.disable()) return;
  refreshOverlay();
  updateMenu();
  if (announce) osd("VR2D off");
}

function toggleVR2D() {
  if (session.state.enabled) disableVR2D(true);
  else enableVR2D(true);
}

function exportFlattenedVideo() {
  if (!session.state.enabled || !session.state.attached) return;

  try {
    var job = exporter.snapshot(
      mpv.getString("path"), mpv.getNative("track-list") || [], session.source(), session.state
    );
    job.duration = mpv.getNumber("duration");
    iina.global.postMessage("vr2d:export", job);
  } catch (error) {
    osd("VR2D: " + error.message);
  }
}

// ---------------------------------------------------------------------------
// Overlay (heads-up display and drag surface)
// ---------------------------------------------------------------------------

var overlayLoaded = false;
var overlayPushTimer = null;

function loadOverlay() {
  if (overlayLoaded) return;
  overlay.loadFile("ui/overlay.html");
}

function refreshOverlay() {
  var on = session.state.enabled;
  overlay.setClickable(on && prefBool("dragToPan"));
  if (on) overlay.show();
  else overlay.hide();
  pushOverlayState();
}

function pushOverlayState() {
  if (!overlayLoaded) return;
  var src = session.source();
  overlay.postMessage("vr2d:state", {
    enabled: session.state.enabled,
    yaw: session.state.view.yaw,
    pitch: session.state.view.pitch,
    fov: session.state.view.fov,
    // The overlay predicts the view locally so the read-out keeps up with the
    // cursor; it needs the source extent and the sensitivity to do the same
    // arithmetic we do.
    inHFov: src ? src.inHFov : 180,
    inVFov: src ? src.inVFov : 180,
    sensitivity: prefNumber("dragSensitivity") * (prefBool("invertDrag") ? -1 : 1),
    summary: session.describe(),
    showHud: prefBool("showHud"),
    dragToPan: prefBool("dragToPan"),
    topSafeArea: prefNumber("topSafeArea"),
    bottomSafeArea: prefNumber("bottomSafeArea"),
  });
}

/** Coalesce HUD updates; a drag produces far more changes than it needs pixels. */
function scheduleOverlayPush() {
  if (overlayPushTimer !== null) return;
  overlayPushTimer = setTimeout(function () {
    overlayPushTimer = null;
    pushOverlayState();
  }, 50);
}

/**
 * Subscribe to the overlay's messages.
 *
 * This has to run *after* the overlay reports itself loaded: handlers
 * registered while the entry script is still being evaluated are silently
 * dropped when the webview comes up, which would leave dragging and zooming
 * dead with no error anywhere.
 */
var overlayHandlersReady = false;

function registerOverlayHandlers() {
  if (overlayHandlersReady) return;
  overlayHandlersReady = true;

  overlay.onMessage("vr2d:drag", function (data) {
    if (!session.state.enabled) return;
    var sensitivity = prefNumber("dragSensitivity") * (prefBool("invertDrag") ? -1 : 1);
    session.setView(geometry.applyDrag(session.state.view, data, sensitivity));
  });

  overlay.onMessage("vr2d:gesture", function (data) {
    session.setGesture(!!(data && data.active));
  });

  overlay.onMessage("vr2d:zoom", function (data) {
    if (!session.state.enabled) return;
    session.setView(geometry.applyZoom(session.state.view, data.notches));
  });

  overlay.onMessage("vr2d:click", function () {
    // The drag surface swallows the click IINA would normally act on, so play /
    // pause has to be reproduced here.
    if (core.status.paused) core.resume();
    else core.pause();
  });

  overlay.onMessage("vr2d:dblclick", function () {
    core.window.fullscreen = !core.window.fullscreen;
  });

  overlay.onMessage("vr2d:reset", function () {
    session.resetView(startingFov(session.state.out));
  });
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

/*
 * Pick a shortcut that is actually free.
 *
 * IINA drops a plugin's key binding silently when something already owns that
 * combination — the menu item just renders without a shortcut and nothing ever
 * fires. Low-priority `onKeyDown` listeners lose the same way, because the
 * existing binding handles the key first. Both had bitten this plugin: the
 * toggle asked for Cmd-Shift-V and the pan keys for Option-arrows, all of which
 * IINA already uses, so none of them worked.
 */
var takenKeys = null;

function keyIsTaken(code) {
  if (takenKeys === null) {
    try {
      takenKeys = input.getAllKeyBindings() || {};
    } catch (e) {
      takenKeys = {};
    }
  }
  try {
    return !!takenKeys[input.normalizeKeyCode(code)];
  } catch (e) {
    return false;
  }
}

function pickKey(name, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (!keyIsTaken(candidates[i])) {
      if (i > 0) console.log("VR2D: " + name + " falling back to " + candidates[i]);
      return candidates[i];
    }
  }
  console.warn("VR2D: no free shortcut for " + name + " (tried " + candidates.join(", ") + ")");
  return null;
}

function keyOption(code) {
  return code ? { keyBinding: code } : {};
}

var KEYS = {
  toggle: pickKey("toggle", ["Alt+Shift+v", "Meta+Alt+v", "Alt+f"]),
  projection: pickKey("next projection", ["Alt+p", "Alt+Shift+p", "Alt+3"]),
  layout: pickKey("next layout", ["Alt+l", "Alt+Shift+l", "Alt+4"]),
  eye: pickKey("swap eye", ["Alt+e", "Alt+Shift+e", "Alt+5"]),
  reset: pickKey("reset view", ["Alt+0", "Alt+Shift+0", "Alt+r"]),
  panLeft: pickKey("pan left", ["Alt+Shift+LEFT", "Ctrl+Alt+LEFT", "Alt+a"]),
  panRight: pickKey("pan right", ["Alt+Shift+RIGHT", "Ctrl+Alt+RIGHT", "Alt+d"]),
  panUp: pickKey("pan up", ["Alt+Shift+UP", "Ctrl+Alt+UP", "Alt+w"]),
  panDown: pickKey("pan down", ["Alt+Shift+DOWN", "Ctrl+Alt+DOWN", "Alt+s"]),
  zoomIn: pickKey("zoom in", ["Alt+=", "Alt+Shift+="]),
  zoomOut: pickKey("zoom out", ["Alt+-", "Alt+Shift+-"]),
};

// ---------------------------------------------------------------------------
// Switching presets
// ---------------------------------------------------------------------------

/*
 * Step through a preset list. Files whose name says nothing useful need this to
 * be quick -- hunting through nested submenus to try four projections is not
 * quick, so each of these is one keystroke and announces the result on the OSD.
 */
function cycleOverride(key, list, noun) {
  var ids = list.map(function (option) {
    return String(option.id);
  });
  var index = ids.indexOf(String(session.state.overrides[key]));
  var next = ids[(index + 1) % ids.length];
  session.setOverride(key, next);
  updateMenu();

  var option = presets.byId(list, next);
  osd(
    "VR2D " + noun + ": " + (option ? option.title : next) +
    (session.state.enabled ? "  ·  " + session.describe() : "  (VR2D is off)")
  );
}

function cycleProjection() {
  cycleOverride("projection", presets.PROJECTIONS, "projection");
}

function cycleLayout() {
  cycleOverride("layout", presets.LAYOUTS, "layout");
}

function swapEye() {
  var next = session.state.overrides.eye === "left" ? "right" : "left";
  session.setOverride("eye", next);
  rememberEye(next);
  updateMenu();
  osd("VR2D — " + session.describe());
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

var menuRefs = { toggle: null, layout: [], projection: [], eye: [], info: null };

// The entry script is evaluated from inside the dispatch_once that builds the
// first PlayerCore, and `menu.forceUpdate()` reaches back for that same token.
// Calling it during init deadlocks and traps the process, so menu refreshes are
// held until the run loop turns over.
var menuReady = false;

function buildMenu() {
  menu.removeAllItems();

  /*
   * IINA shows only the first five top-level items a plugin adds and sweeps the
   * rest into a generic "More…" submenu -- and separators count toward the five.
   * So the top level is exactly five real items, with no separators wasted on
   * it, and everything else hangs one level down where it stays reachable.
   */
  menuRefs.toggle = menu.item("Flatten VR Video", toggleVR2D, keyOption(KEYS.toggle));
  menu.addItem(menuRefs.toggle);

  var projectionMenu = menu.item("Projection");
  projectionMenu.addSubMenuItem(
    menu.item("Try the Next One", cycleProjection, keyOption(KEYS.projection))
  );
  projectionMenu.addSubMenuItem(menu.separator());
  menuRefs.projection = presets.PROJECTIONS.map(function (option) {
    var item = menu.item(option.title, function () {
      chooseOverride("projection", option.id, presets.PROJECTIONS);
    });
    projectionMenu.addSubMenuItem(item);
    return { id: option.id, item: item };
  });
  menu.addItem(projectionMenu);

  var layoutMenu = menu.item("Stereo Layout");
  layoutMenu.addSubMenuItem(
    menu.item("Try the Next One", cycleLayout, keyOption(KEYS.layout))
  );
  layoutMenu.addSubMenuItem(menu.separator());
  menuRefs.layout = presets.LAYOUTS.map(function (option) {
    var item = menu.item(option.title, function () {
      chooseOverride("layout", option.id, presets.LAYOUTS);
    });
    layoutMenu.addSubMenuItem(item);
    return { id: option.id, item: item };
  });
  menu.addItem(layoutMenu);

  var eyeMenu = menu.item("Eye");
  eyeMenu.addSubMenuItem(menu.item("Swap", swapEye, keyOption(KEYS.eye)));
  eyeMenu.addSubMenuItem(menu.separator());
  menuRefs.eye = ["left", "right"].map(function (id) {
    var item = menu.item(id === "left" ? "Left" : "Right", function () {
      session.setOverride("eye", id);
      rememberEye(id);
      updateMenu();
      osd("VR2D — " + session.describe());
    });
    eyeMenu.addSubMenuItem(item);
    return { id: id, item: item };
  });
  menu.addItem(eyeMenu);

  /*
   * Panning and zooming hang off a menu item each, rather than going through
   * `input.onKeyDown`. Plugin key listeners proved unreliable for these chords
   * — they fired at first and then latched, repeating one direction whatever
   * was pressed. A menu key equivalent is handled by AppKit itself, which is
   * the same path the projection shortcut already uses successfully.
   */
  var viewMenu = menu.item("Look Around");
  viewMenu.addSubMenuItem(menu.item("Left", panBy(-1, 0), keyOption(KEYS.panLeft)));
  viewMenu.addSubMenuItem(menu.item("Right", panBy(1, 0), keyOption(KEYS.panRight)));
  viewMenu.addSubMenuItem(menu.item("Up", panBy(0, 1), keyOption(KEYS.panUp)));
  viewMenu.addSubMenuItem(menu.item("Down", panBy(0, -1), keyOption(KEYS.panDown)));
  viewMenu.addSubMenuItem(menu.separator());
  viewMenu.addSubMenuItem(menu.item("Zoom In", zoomBy(-1), keyOption(KEYS.zoomIn)));
  viewMenu.addSubMenuItem(menu.item("Zoom Out", zoomBy(1), keyOption(KEYS.zoomOut)));
  viewMenu.addSubMenuItem(menu.separator());
  viewMenu.addSubMenuItem(
    menu.item(
      "Recentre",
      function () {
        session.resetView(startingFov(session.state.out));
        osd("VR2D — view recentred");
      },
      keyOption(KEYS.reset)
    )
  );
  viewMenu.addSubMenuItem(menu.separator());
  menuRefs.exportVideo = menu.item("Export Flattened Video…", exportFlattenedVideo);
  viewMenu.addSubMenuItem(menuRefs.exportVideo);
  menu.addItem(viewMenu);

  updateMenu();
}

function chooseOverride(key, id, list) {
  session.setOverride(key, id);
  updateMenu();
  var option = presets.byId(list, id);
  osd(
    "VR2D — " + (option ? option.title : id) +
    (session.state.enabled ? "  ·  " + session.describe() : "  (VR2D is off)")
  );
}

function updateMenu() {
  var detected = session.state.detected;
  var hasVideo = !!detected;
  menuRefs.exportVideo.enabled = session.state.enabled && session.state.attached;

  if (menuRefs.toggle) {
    menuRefs.toggle.selected = session.state.enabled;
    menuRefs.toggle.enabled = hasVideo;
  }

  function mark(refs, current) {
    refs.forEach(function (ref) {
      ref.item.selected = String(ref.id) === String(current);
      ref.item.enabled = hasVideo;
    });
  }
  mark(menuRefs.projection, session.state.overrides.projection);
  mark(menuRefs.layout, session.state.overrides.layout);
  mark(menuRefs.eye, session.state.overrides.eye);

  // The "Auto" rows carry the status, so no top-level slot has to be spent on
  // an information line.
  function labelAuto(refs, text) {
    refs.forEach(function (ref) {
      if (ref.id === "auto") ref.item.title = hasVideo ? "Auto — " + text : "Auto";
    });
  }
  if (hasVideo) {
    labelAuto(menuRefs.projection, detect.summarize("mono", detected.projection, detected.inHFov));
    labelAuto(
      menuRefs.layout,
      detected.layout === "sbs"
        ? "side-by-side"
        : detected.layout === "tb"
          ? "over-under"
          : "monoscopic"
    );
  } else {
    labelAuto(menuRefs.projection, "");
    labelAuto(menuRefs.layout, "");
  }

  if (menuReady) menu.forceUpdate();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * Pan by a fraction of the *visible* field, so a keypress covers the same
 * apparent distance whether zoomed in or out.
 */
/*
 * Keyboard panning runs at a constant angular speed, not a fixed step per
 * event.
 *
 * A key equivalent repeats as fast as the OS wants to repeat it — around thirty
 * times a second on a held key, and not at all between separate taps. Applying
 * one fixed step per event therefore made a tap and a half-second hold differ
 * by a factor of fifteen, which is what made held keys shoot straight to the
 * edge of the pannable range and look like they only travelled one way.
 * Scaling each step by the time since the last one makes both behave.
 */
var lastPanTick = 0;
var lastZoomTick = 0;

function panBy(dirX, dirY) {
  return function () {
    if (!session.state.enabled) return;
    var now = Date.now();
    var seconds = geometry.clamp((now - lastPanTick) / 1000, 0.016, 0.12);
    lastPanTick = now;

    var out = session.state.out;
    var parts = geometry.fovComponents(session.state.view.fov, out.width, out.height);
    var fraction = (prefNumber("keyStep") / 100) * seconds;
    session.setView(
      geometry.applyPanStep(
        session.state.view,
        dirX * parts.h * fraction,
        dirY * parts.v * fraction
      )
    );
  };
}

function zoomBy(direction) {
  return function () {
    if (!session.state.enabled) return;
    var now = Date.now();
    var seconds = geometry.clamp((now - lastZoomTick) / 1000, 0.016, 0.12);
    lastZoomTick = now;
    // Same reasoning as panBy: notches per second, not notches per key event.
    session.setView(geometry.applyZoom(session.state.view, direction * 10 * seconds));
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

var resizeTimer = null;

function onFileLoaded() {
  diag.start();
  diag.log("ev.file-loaded");
  session.teardown();

  var detected = analyzeCurrentFile();
  if (!detected) {
    updateMenu();
    refreshOverlay();
    return;
  }

  session.setDetected(detected);
  session.setOverride("eye", pref("eye") === "right" ? "right" : "left");
  diag.log(
    "detected",
    detected.summary + " layout=" + detected.layout + " swap=" + detected.swapEyes +
      " proj=" + detected.projection + " hfov=" + detected.inHFov +
      " aspect=" + Math.round(detected.aspect * 1000) / 1000 + " auto=" + detected.auto +
      " strong=" + detected.strong.length + " weak=" + detected.weak.length
  );
  console.log(
    "detected " +
      detected.summary +
      " | strong: [" +
      detected.strong.join("; ") +
      "] weak: [" +
      detected.weak.join("; ") +
      "] auto: " +
      detected.auto
  );

  if (prefBool("autoEnable") && detected.auto) {
    // Wait for the window: enabling against a placeholder frame would size the
    // reprojection to it, and IINA would then shrink the window to match.
    whenWindowSettled(function () {
      if (session.state.detected === detected && !session.state.enabled) enableVR2D(true);
    });
  } else {
    refreshOverlay();
  }
  updateMenu();
}

// Only the overlay follows the view. Rebuilding the plugin's NSMenu is main-
// thread work, and this fires on every pan step -- doing it here was rebuilding
// the whole menu up to 30 times a second while dragging.
session.onChange(function () {
  scheduleOverlayPush();
});

session.onError(function (message) {
  osd(message);
  refreshOverlay();
});

event.on("iina.window-loaded", function () {
  loadOverlay();
});

event.on("iina.plugin-overlay-loaded", function () {
  overlayLoaded = true;
  registerOverlayHandlers();
  pushOverlayState();
});

event.on("iina.file-loaded", onFileLoaded);

/*
 * Anything that makes mpv rebuild the filter graph drops every runtime pan and
 * zoom we have sent since. Seeking is the one users notice: scrub the timeline
 * and the view snaps back to wherever it was when the chain was built.
 *
 * `video-params` is the decoder's output, *before* our filter, and it is the
 * signal the other three miss. A decoder re-initialisation — hardware decoding
 * falling back, a format change part-way through a file — rebuilds the
 * libavfilter graph, but because our filter pins the output size and format the
 * video output never reconfigures, so `video-reconfig` either arrives late or
 * not at all. Measured: setting `hwdec` rebuilt the graph 29 ms later, with the
 * seek event arriving after the rebuild had already reverted the view.
 */
event.on("mpv.video-params.changed", function () {
  diag.log("ev.video-params.changed");
  session.resync();
});
event.on("mpv.video-reconfig", function () {
  diag.log("ev.video-reconfig");
  session.resync();
  holdWindow();
});
event.on("mpv.seek", function () {
  diag.log("ev.seek");
  session.resync();
});
event.on("mpv.playback-restart", function () {
  diag.log("ev.playback-restart");
  session.resync();
});

function onWindowGeometryChanged(source) {
  diag.log("ev.window-geometry", String(source));
  if (!session.state.enabled) return;
  // A resize we caused ourselves is undone rather than adopted; otherwise the
  // output would chase the window down and shrink it again on the next pass.
  if (Date.now() <= reconfigGuardUntil) {
    holdWindow();
    return;
  }
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    resizeTimer = null;
    captureWindowBaseline();
    applyOutput();
  }, 400);
}

event.on("iina.window-resized", function () {
  onWindowGeometryChanged("resized");
});
event.on("iina.window-size-adjusted", function () {
  onWindowGeometryChanged("size-adjusted");
});
event.on("iina.window-fs.changed", function () {
  onWindowGeometryChanged("fs");
});
event.on("iina.window-screen.changed", function () {
  onWindowGeometryChanged("screen");
});
// Entering or leaving picture-in-picture or music mode moves the video to a
// different surface, so the size we render for is no longer the right one.
event.on("iina.pip.changed", function () {
  onWindowGeometryChanged("pip");
});
event.on("iina.music-mode.changed", function () {
  onWindowGeometryChanged("music-mode");
});

event.on("iina.window-will-close", function () {
  session.teardown();
});

buildMenu();

setTimeout(function () {
  menuReady = true;
  updateMenu();
}, 0);

// A trace of what the plugin believed, sampled next to mpv's own record of what
// it did to the filter graph. Off unless `diag.js` is switched on.
diag.startHeartbeat(session);

prefSignature = preferenceSignature();
setInterval(applyChangedPreferences, 2000);

console.log("VR2D ready");
