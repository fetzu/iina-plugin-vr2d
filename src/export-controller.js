"use strict";

// The global plugin instance owns the export and its window across players.
var exporter = require("./export.js");
var utils = iina.utils;
var progressWindow = iina.standaloneWindow;
var busy = false;

function showProgress(message, percent) {
  progressWindow.setContent(
    "<p>" + message + "</p><progress aria-label='Export progress' max='100'" +
    (percent === null ? "" : " value='" + percent + "'") + "></progress>"
  );
}

function finish(error) {
  busy = false;
  if (error) iina.console.error("VR2D export failed: " + error);
  showProgress(error ? "Export failed. See the VR2D plugin log for details." : "Export complete.",
    error ? 0 : 100);
}

iina.global.onMessage("vr2d:export", async function (job) {
  if (busy) {
    progressWindow.open();
    return;
  }

  busy = true;
  try {
    var ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg"]
      .find(function (path) { return utils.fileInPath(path); });
    if (!ffmpeg) {
      utils.ask("VR2D export requires FFmpeg. Install it with Homebrew or MacPorts.");
      return;
    }

    var suggested = exporter.defaultDestination(job.input);
    var selected = utils.prompt(
      "Export flattened video. Leave the field blank to save to:\n" + suggested +
      "\n\nOr enter a new full MP4 path."
    );
    if (typeof selected !== "string") return;
    var path = selected.trim();
    var destination = path ? utils.resolvePath(path) : suggested;
    if (!destination || !/^\/.*\.mp4$/i.test(destination)) {
      utils.ask("Enter a full path ending in .mp4.");
      return;
    }
    if (utils.fileInPath(destination)) {
      utils.ask("VR2D export needs a new file. Choose a path that does not already exist.");
      return;
    }

    progressWindow.simpleMode();
    progressWindow.setProperty({ title: "Export Flattened Video", resizable: false });
    progressWindow.setFrame(430, 155);
    progressWindow.setStyle("body { padding: 16px; } progress { width: 100%; }");
    showProgress("Exporting… You can close the video window. Keep IINA open.", null);
    progressWindow.open();

    var elapsed = 0;
    var percent = null;
    var timer = setInterval(function () {
      var next = job.duration > 0 ? Math.min(99, Math.floor(elapsed / job.duration * 100)) : null;
      if (next === percent) return;
      percent = next;
      showProgress("Exporting… " + percent + "%", percent);
    }, 500);
    try {
      var result = await utils.exec(ffmpeg, exporter.ffmpegArgs(job, destination), null,
        exporter.progressReader(function (seconds) { elapsed = seconds; }));
      finish(result.status !== 0 || result.stderr.trim()
        ? result.stderr || "FFmpeg exited with status " + result.status
        : null);
    } catch (error) {
      finish(String(error));
    } finally {
      clearInterval(timer);
    }
  } catch (error) {
    iina.console.error("VR2D export failed: " + error);
    utils.ask("VR2D could not start the export. See the plugin log for details.");
  } finally {
    busy = false;
  }
});
