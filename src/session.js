"use strict";

/**
 * The VR2D state machine for one player window.
 *
 * Owns the detected source description, the user's overrides, the current
 * view direction, and the mpv filter that realises them. Callers move the view
 * as often as they like; this module coalesces those changes and pushes at
 * most `updateRate` updates per second to mpv, because every `vf-command` on
 * `v360` rebuilds its remap table (~0.06 s of CPU at 720p, ~0.14 s at 1080p —
 * cheap enough to be interactive, far too expensive to do per mouse event).
 */

// All requires must happen while the module is being evaluated -- IINA's
// `require` polyfill traps if it is called later, from a callback.
var detect = require("./detect.js");
var diag = require("./diag.js");
var filter = require("./filter.js");
var geometry = require("./geometry.js");
var presets = require("./presets.js");

var mpv = iina.mpv;
var console = iina.console;

var LABEL = filter.LABEL;

var state = {
  enabled: false,
  attached: false,
  detected: null,
  overrides: { layout: "auto", projection: "auto", eye: "left" },
  view: { yaw: 0, pitch: 0, fov: 90 },
  out: { width: 1920, height: 1080, interp: "line" },
};

// Last values actually handed to mpv, so we only send what moved.
var pushed = { yaw: null, pitch: null, fov: null };
// The view baked into the current filter string. mpv rebuilds the libavfilter
// graph from that string whenever the format changes, so this is what `v360`
// falls back to when it does.
var attachedView = null;
var dirty = false;
var timer = null;
var updateRate = 30;
var changeHandlers = [];
var errorHandlers = [];

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/** Detection result with the user's menu overrides layered on top. */
function source() {
  if (!state.detected) return null;
  var s = {
    layout: state.detected.layout,
    swapEyes: state.detected.swapEyes,
    projection: state.detected.projection,
    inHFov: state.detected.inHFov,
    inVFov: state.detected.inVFov,
  };

  var layout = presets.byId(presets.LAYOUTS, state.overrides.layout);
  if (layout && layout.layout) {
    s.layout = layout.layout;
    s.swapEyes = layout.swapEyes;
  }

  var projection = presets.byId(presets.PROJECTIONS, state.overrides.projection);
  if (projection && projection.projection) {
    s.projection = projection.projection;
    s.inHFov = projection.hFov;
    s.inVFov = projection.vFov;
  }

  return s;
}

function describe() {
  var s = source();
  if (!s) return "no video";
  var text = detect.summarize(s.layout, s.projection, s.inHFov);
  if (s.layout !== "mono") {
    text += ", " + state.overrides.eye + " eye";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Hardware decoding
// ---------------------------------------------------------------------------

// `v360` runs on the CPU, so it needs frames in system memory. Under plain
// `videotoolbox` they stay on the GPU and mpv gives up on the whole chain with
// "Disabling filter vr2d because it has failed" -- while still listing it in
// `vf`, so the failure is otherwise silent. A `-copy` mode keeps the hardware
// decoder and just reads the frames back, which is much cheaper than falling
// all the way back to software decoding on 8K sources.
var savedHwdec = null;

function usesSystemMemory(mode) {
  return !mode || mode === "no" || mode === "auto-safe-copy" || /-copy$/.test(mode);
}

function ensureSoftwareFrames() {
  if (savedHwdec !== null) return;
  var current;
  try {
    current = mpv.getString("hwdec");
  } catch (e) {
    return;
  }
  if (usesSystemMemory(current)) return;
  savedHwdec = current;
  mpv.set("hwdec", "auto-copy");
  console.log("VR2D: hwdec " + current + " -> auto-copy so the filter can read frames");
}

function forceSoftwareDecoding() {
  if (savedHwdec === null) {
    try {
      savedHwdec = mpv.getString("hwdec");
    } catch (e) {
      savedHwdec = "auto";
    }
  }
  mpv.set("hwdec", "no");
  console.log("VR2D: falling back to software decoding");
}

function restoreHwdec() {
  if (savedHwdec === null) return;
  mpv.set("hwdec", savedHwdec);
  console.log("VR2D: hwdec restored to " + savedHwdec);
  savedHwdec = null;
}

/**
 * Whether the filter is actually producing frames. mpv keeps a failed filter
 * in the `vf` list, so the only reliable tell is the size coming out of the
 * chain matching what we asked `v360` for.
 */
function filterIsLive() {
  try {
    var params = mpv.getNative("video-out-params");
    if (!params || !(params.w > 0)) return true; // can't tell; assume fine
    return params.w === state.out.width && params.h === state.out.height;
  } catch (e) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// mpv plumbing
// ---------------------------------------------------------------------------

/** Whether our labelled filter is currently in mpv's chain. */
function isAttached() {
  try {
    var chain = mpv.getNative("vf") || [];
    for (var i = 0; i < chain.length; i++) {
      if (chain[i] && chain[i].label === LABEL) return true;
    }
  } catch (e) {
    // Property unreadable; fall back to assuming it worked.
    return true;
  }
  return false;
}

/** True when our filter is the only thing in mpv's chain (or the chain is empty). */
function ownsWholeChain() {
  try {
    var chain = mpv.getNative("vf") || [];
    for (var i = 0; i < chain.length; i++) {
      if (!chain[i] || chain[i].label !== LABEL) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function attach() {
  var s = source();
  if (!s) return;
  var value = filter.buildVfValue(s, state.view, state.out, state.overrides.eye);

  // `remove` then `add` leaves a moment with no filter, and mpv can put an
  // untouched side-by-side frame on screen in the gap -- a visible flash every
  // time the chain is rebuilt. `set` swaps it in one step, so use that whenever
  // nothing else is in the chain to be preserved.
  var owns = ownsWholeChain();
  diag.log("attach>", (owns ? "set" : "add") + " " + diag.v(state.view) + " was=" + diag.v(attachedView));
  if (owns) {
    mpv.command("vf", ["set", value]);
    state.attached = true;
  } else {
    detach();
    mpv.command("vf", ["add", value]);
    state.attached = isAttached();
  }

  // mpv reports a malformed filter on its own log and leaves the chain alone,
  // so the command "succeeding" proves nothing -- check the chain itself.
  if (state.attached) state.attached = isAttached();
  if (!state.attached) {
    console.error("VR2D: mpv rejected the filter chain: " + value);
    return;
  }
  console.log("VR2D: attached " + value);
  attachedView = { yaw: state.view.yaw, pitch: state.view.pitch, fov: state.view.fov };
  pushed.yaw = state.view.yaw;
  pushed.pitch = state.view.pitch;
  pushed.fov = state.view.fov;
}

/**
 * Restore the current view after mpv has re-created the filter graph.
 *
 * A graph rebuild re-parses the filter string, so `v360` reverts to whatever
 * yaw/pitch/d_fov were baked in at attach time and every `vf-command` since is
 * lost -- the view snaps back on its own. Re-sending the commands does not fix
 * it: around a rebuild mpv drops them, and further rebuilds would undo them
 * again anyway. Re-attaching with the current view baked into the string is
 * the only version that sticks, and it costs nothing during ordinary panning
 * because panning alone never triggers a reconfig.
 */
var resyncTimer = null;
var commitTimer = null;

/*
 * Bake the current view back into the filter string as soon as the user stops
 * moving.
 *
 * Panning goes through `vf-command`, which lives only in the running filter
 * instance — the string mpv keeps still says wherever the view was when the
 * chain was last built. Anything that makes mpv re-create the graph rebuilds
 * from that string and throws the pan away, so the picture jumps back on its
 * own, and it stays jumped back until something notices.
 *
 * The window between the last `vf-command` and this commit is therefore the
 * window in which the view can be lost, and it has to be short. It used to be
 * 1200 ms, which was long enough for a rebuild to land inside it routinely: a
 * decoder re-initialisation is enough to trigger one, and mpv reports that to
 * the plugin late or not at all, because our filter pins the output format so
 * the video output never reconfigures. 150 ms is about four frames — short
 * enough that a rebuild inside it is rare and barely visible when it happens.
 *
 * The commit costs one chain rebuild, so a floor keeps a hesitant gesture (a
 * slow drag, or repeated key taps) from rebuilding the chain over and over:
 * when a commit comes too soon after the last one it is deferred rather than
 * dropped.
 */
var COMMIT_DELAY = 150;
var MIN_COMMIT_GAP = 400;
var lastCommitAt = 0;
// A drag in progress is a poor moment to rebuild the chain — the pause between
// two mouse moves is not the end of the gesture.
var gestureActive = false;
var lastMoveAt = 0;

function scheduleCommit() {
  if (commitTimer !== null) clearTimeout(commitTimer);
  var sinceLast = Date.now() - lastCommitAt;
  var delay = Math.max(COMMIT_DELAY, MIN_COMMIT_GAP - sinceLast);
  commitTimer = setTimeout(function () {
    commitTimer = null;
    if (!state.enabled || !state.attached || !attachedView) return;
    if (
      state.view.yaw === attachedView.yaw &&
      state.view.pitch === attachedView.pitch &&
      state.view.fov === attachedView.fov
    ) {
      diag.log("commit-skip", diag.v(state.view));
      return; // the string already matches
    }
    // Still dragging: try again once it settles. A gesture that has stopped
    // moving counts as over whatever the flag says, so a `mouseup` lost to a
    // focus change can never strand the string out of date.
    if (gestureActive && Date.now() - lastMoveAt < 400) {
      diag.log("commit-defer", diag.v(state.view));
      scheduleCommit();
      return;
    }
    diag.log("commit", diag.v(state.view) + " string=" + diag.v(attachedView));
    lastCommitAt = Date.now();
    attach();
  }, delay);
}

/** Tell the session a pointer gesture is running, so commits wait for its end. */
function setGesture(active) {
  if (gestureActive === active) return;
  gestureActive = active;
  diag.log("gesture", String(active));
  // The end of a drag is exactly when the string should catch up.
  if (!active) scheduleCommit();
}

function resync() {
  // Whatever just happened may have rebuilt the graph, in which case the filter
  // is back at the string and every `vf-command` since is gone. Forget what we
  // think it holds so the next push sends absolute angles instead of being
  // skipped by the deadband: if the view is still moving, that repairs it
  // within a frame, well before the commit below would.
  pushed.yaw = pushed.pitch = pushed.fov = null;

  // One format change makes mpv emit a burst of reconfigs; coalesce them —
  // but only just enough, because the picture is wrong until this runs.
  if (resyncTimer !== null) return;
  resyncTimer = setTimeout(function () {
    resyncTimer = null;
    resyncNow();
  }, 60);
}

function resyncNow() {
  if (!state.enabled || !state.attached || !attachedView) {
    diag.log("resync-idle", "en=" + state.enabled + " at=" + state.attached);
    return;
  }
  /*
   * While the view is still moving there is nothing to repair here, and every
   * repair would be a chain rebuild in the middle of a gesture. The flush loop
   * pushes absolute angles, so a rebuild is undone by the next push a frame or
   * two later, and `scheduleCommit` bakes the result as soon as movement stops.
   * Without this, our own `attach()` raises `video-reconfig`, which lands back
   * here, which attaches again — one rebuild per second for as long as the user
   * keeps panning.
   */
  if (Date.now() - lastMoveAt < 250) {
    diag.log("resync-moving", diag.v(state.view));
    return;
  }
  if (
    state.view.yaw === attachedView.yaw &&
    state.view.pitch === attachedView.pitch &&
    state.view.fov === attachedView.fov
  ) {
    diag.log("resync-skip", diag.v(state.view));
    return; // the string already holds the current view
  }
  diag.log("resync", diag.v(state.view) + " string=" + diag.v(attachedView));
  attach();
}

/**
 * mpv only finds out whether the chain works when the next frame arrives, so
 * check shortly after attaching and escalate if it silently died.
 */
function verifyAttachment(attempt) {
  if (!state.enabled || !state.attached || filterIsLive()) return;

  if (attempt === 0) {
    console.warn("VR2D: filter produced no frames, retrying with software decoding");
    forceSoftwareDecoding();
    attach();
    scheduleVerify(1);
    return;
  }
  // Deliberately not switching VR2D off here. A false positive -- the size
  // check racing a rebuild that has not landed yet -- would yank the mode out
  // from under the user for no reason, and a genuinely dead filter already
  // shows the untouched frame, so turning it off changes nothing they can see.
  console.error("VR2D: the reprojection filter is not producing frames");
  fail("VR2D could not reproject this video");
}

function scheduleVerify(attempt) {
  setTimeout(function () {
    verifyAttachment(attempt);
  }, 900);
}

function detach() {
  if (!state.attached) return;
  diag.log("detach", diag.v(attachedView));
  mpv.command("vf", ["remove", "@" + LABEL]);
  state.attached = false;
  attachedView = null;
  pushed.yaw = pushed.pitch = pushed.fov = null;
}

/** Re-create the filter chain. Needed for anything `vf-command` cannot change. */
function rebuild() {
  if (!state.enabled) return;
  attach();
  notify();
}

var lastPausedRebuild = 0;

function isPaused() {
  try {
    return mpv.getFlag("pause");
  } catch (e) {
    return false;
  }
}

function flush() {
  if (!dirty || !state.attached) return;

  // A paused frame has already been through the filter, and changing `v360`'s
  // parameters does not make mpv re-run the chain on it -- the view state moves
  // but the picture never redraws. Re-attaching does force a re-filter, so
  // while paused that is the only thing that actually shows the user anything.
  if (isPaused()) {
    var now = Date.now();
    if (now - lastPausedRebuild < 90) return; // keep dirty; retry next tick
    lastPausedRebuild = now;
    dirty = false;
    attach();
    return;
  }

  dirty = false;
  var v = state.view;

  // Each of these rebuilds the remap table in full, so a change too small to
  // see is not worth sending. A mostly-horizontal drag still jitters pitch by a
  // fraction of a degree every frame; ignoring that roughly halves the work.
  // Target v360 directly because the crop filter cannot handle these commands.
  if (moved(v.yaw, pushed.yaw)) {
    mpv.command("vf-command", [LABEL, "yaw", String(round2(v.yaw)), "v360"]);
    pushed.yaw = v.yaw;
  }
  if (moved(v.pitch, pushed.pitch)) {
    mpv.command("vf-command", [LABEL, "pitch", String(round2(v.pitch)), "v360"]);
    pushed.pitch = v.pitch;
  }
  if (moved(v.fov, pushed.fov)) {
    mpv.command("vf-command", [LABEL, "d_fov", String(round2(v.fov)), "v360"]);
    pushed.fov = v.fov;
  }

  scheduleCommit();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Whether an angle is worth sending. `null` means we no longer know what the
 * filter holds — after a possible graph rebuild — so it always is.
 */
function moved(current, sent) {
  return sent === null || Math.abs(current - sent) > 0.1;
}

function startTimer() {
  stopTimer();
  timer = setInterval(flush, Math.max(8, Math.round(1000 / updateRate)));
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function notify() {
  for (var i = 0; i < changeHandlers.length; i++) {
    try {
      changeHandlers[i](state);
    } catch (e) {
      console.error("VR2D change handler failed: " + e);
    }
  }
}

function onChange(handler) {
  changeHandlers.push(handler);
}

function onError(handler) {
  errorHandlers.push(handler);
}

function fail(message) {
  for (var i = 0; i < errorHandlers.length; i++) {
    try {
      errorHandlers[i](message);
    } catch (e) {
      console.error("VR2D error handler failed: " + e);
    }
  }
}

function setDetected(detected) {
  state.detected = detected;
  state.overrides.layout = "auto";
  state.overrides.projection = "auto";
}

function setOverride(key, value) {
  if (state.overrides[key] === value) return;
  state.overrides[key] = value;
  // Layout, projection and eye all live in the un-commandable half of the
  // filter, so they need the chain re-created.
  state.view = geometry.clampView(state.view, source(), state.out.width, state.out.height);
  rebuild();
}

/** @param {{width: number, height: number, interp: string}} out */
function setOutput(out) {
  if (!out || !(out.width > 0) || !(out.height > 0)) {
    console.error("VR2D: ignoring bad output size " + JSON.stringify(out));
    return;
  }
  if (
    out.width === state.out.width &&
    out.height === state.out.height &&
    out.interp === state.out.interp
  ) {
    return;
  }
  // The view is stored as a diagonal FOV, but what a viewer notices is how wide
  // the shot is. Carry the horizontal angle across the change so re-shaping the
  // output -- a window resize, or dropping detail to pan -- does not quietly
  // zoom the picture in or out.
  var horizontal = geometry.fovComponents(state.view.fov, state.out.width, state.out.height).h;
  diag.log(
    "setOutput",
    state.out.width + "x" + state.out.height + " -> " + out.width + "x" + out.height +
      " view=" + diag.v(state.view)
  );

  state.out = { width: out.width, height: out.height, interp: out.interp || "line" };
  state.view.fov = geometry.diagonalFromHorizontal(
    horizontal,
    state.out.width,
    state.out.height
  );
  state.view = geometry.clampView(state.view, source(), state.out.width, state.out.height);
  diag.log("setOutput-clamped", diag.v(state.view));
  rebuild();
}

function setUpdateRate(rate) {
  updateRate = Math.max(5, Math.min(60, rate || 30));
  if (state.enabled) startTimer();
}

/** Move the view. `next` is a full `{yaw, pitch, fov}`; it gets clamped here. */
function setView(next) {
  var s = source();
  if (!s) return;
  var clamped = geometry.clampView(next, s, state.out.width, state.out.height);
  if (
    clamped.yaw === state.view.yaw &&
    clamped.pitch === state.view.pitch &&
    clamped.fov === state.view.fov
  ) {
    return;
  }
  state.view = clamped;
  dirty = true;
  lastMoveAt = Date.now();
  notify();
}

function resetView(defaultFov) {
  setView({ yaw: 0, pitch: 0, fov: defaultFov || 90 });
  flush();
}

function enable(defaultFov) {
  if (state.enabled || !state.detected) return false;
  state.enabled = true;
  state.view = geometry.clampView(
    { yaw: 0, pitch: 0, fov: defaultFov || 90 },
    source(),
    state.out.width,
    state.out.height
  );
  ensureSoftwareFrames();
  attach();
  startTimer();
  scheduleVerify(0);
  notify();
  return true;
}

function disable() {
  if (!state.enabled) return false;
  state.enabled = false;
  stopTimer();
  detach();
  restoreHwdec();
  notify();
  return true;
}

/** Drop the filter without touching `enabled`, e.g. when a file unloads. */
function teardown() {
  stopTimer();
  detach();
  restoreHwdec();
  state.enabled = false;
  state.detected = null;
}

module.exports = {
  state: state,
  // Diagnostics only: what the filter *string* currently holds, and what we
  // last sent over `vf-command`.
  attachedView: function () {
    return attachedView;
  },
  pushed: pushed,
  source: source,
  describe: describe,
  onChange: onChange,
  onError: onError,
  setDetected: setDetected,
  setOverride: setOverride,
  setOutput: setOutput,
  setGesture: setGesture,
  setUpdateRate: setUpdateRate,
  setView: setView,
  resetView: resetView,
  enable: enable,
  disable: disable,
  rebuild: rebuild,
  resync: resync,
  teardown: teardown,
  flush: flush,
};
