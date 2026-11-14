"use strict";

/**
 * Optional FFmpeg regression test for absolute runtime pan/zoom commands.
 * Run with `npm run test:ffmpeg`; FFMPEG can select a different binary.
 * This exercises libavfilter, not IINA's GUI or its bundled libraries.
 */
var assert = require("node:assert/strict");
var spawnSync = require("node:child_process").spawnSync;
var filter = require("../src/filter.js");
var binary = process.env.FFMPEG || "ffmpeg";

function run(args) {
  var result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error("Cannot run FFmpeg; install it or set FFMPEG: " + result.error.message);
  }
  assert.equal(result.status, 0, result.stderr || "FFmpeg failed");
  return result.stdout;
}

// A stationary panorama: every source frame is identical, but different view
// directions produce different pixels. Hashes therefore compare only the view.
var fixture = "nullsrc=s=360x180:r=10:d=1," +
  "geq=lum=255*X/W:cb=255*Y/H:cr=255*(X+Y)/(W+H)";

function frameHashes(graph, count) {
  var output = run([
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", fixture,
    "-vf", graph, "-frames:v", String(count), "-threads", "1",
    "-f", "framemd5", "-",
  ]);
  var hashes = output.split("\n").filter(function (line) {
    return /^\s*\d+\s*,/.test(line);
  }).map(function (line) {
    return line.slice(line.lastIndexOf(",") + 1).trim();
  });
  assert.equal(hashes.length, count, "Unexpected number of output frames");
  return hashes;
}

console.log(run(["-version"]).split("\n")[0]);

var views = [
  { yaw: 0, pitch: 0, fov: 90 },
  { yaw: 10, pitch: 0, fov: 90 },
  { yaw: 20, pitch: 0, fov: 90 },
  { yaw: 20, pitch: 15, fov: 90 },
  { yaw: 30, pitch: 15, fov: 90 },
  { yaw: 30, pitch: 15, fov: 80 },
];
var commands = "0.1 v360 yaw 10;0.2 v360 yaw 20;0.3 v360 pitch 15;" +
  "0.4 v360 yaw 30;0.5 v360 d_fov 80";
var graph = filter.buildGraph(
  { layout: "mono", projection: "e", inHFov: 360, inVFov: 180 },
  views[0],
  { width: 64, height: 36, interp: "near" },
  "left"
);
var actual = frameHashes("sendcmd=commands='" + commands + "'," + graph, views.length);

views.forEach(function (view, index) {
  // Independent reference: create a fresh filter at the intended absolute
  // angles. No runtime commands or plugin graph builder are used here.
  var reference = "v360=input=e:output=flat:w=64:h=36:interp=near:" +
    "yaw=" + view.yaw + ":pitch=" + view.pitch + ":roll=0:d_fov=" + view.fov;
  var expected = frameHashes(reference, 1)[0];
  assert.equal(actual[index], expected, "Frame " + index + ": " + JSON.stringify(view));
});

console.log("6/6 runtime views match fresh absolute-angle reference frames (not an IINA GUI test).");
