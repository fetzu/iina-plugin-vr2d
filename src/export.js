"use strict";

var filter = require("./filter.js");

function ffmpegArgs(job, destination) {
  var args = [
    "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin", "-n",
    "-progress", "pipe:1", "-nostats",
    "-i", job.input, "-map", "0:" + job.videoIndex,
  ];
  if (job.audioIndex !== null) args.push("-map", "0:" + job.audioIndex);
  return args.concat([
    "-vf", job.graph + ",setsar=1,sidedata=delete:STEREO3D,sidedata=delete:SPHERICAL",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    "-f", "mp4", destination,
  ]);
}

function snapshot(input, tracks, source, state) {
  if (typeof input !== "string" || input.charAt(0) !== "/") {
    throw new Error("Export requires a local video file.");
  }
  var video = tracks.find(function (track) {
    return track.selected && track.type === "video";
  });
  var audio = tracks.find(function (track) {
    return track.selected && track.type === "audio";
  });
  if (!video || video.external || !Number.isInteger(video["ff-index"]) || video["ff-index"] < 0) {
    throw new Error("Export requires a video track from the current file.");
  }
  if (audio && (audio.external || !Number.isInteger(audio["ff-index"]) || audio["ff-index"] < 0)) {
    throw new Error("Select an audio track from the current file before exporting.");
  }
  return {
    input: input,
    videoIndex: video["ff-index"],
    audioIndex: audio ? audio["ff-index"] : null,
    graph: filter.buildGraph(source, state.view, state.out, state.overrides.eye),
  };
}

function defaultDestination(input) {
  var slash = input.lastIndexOf("/");
  var dot = input.lastIndexOf(".");
  return input.slice(0, dot > slash + 1 ? dot : input.length) + "_flattened.mp4";
}

function progressReader(onTime) {
  var pending = "";
  return function (chunk) {
    var lines = (pending + chunk).split("\n");
    pending = lines.pop();
    lines.forEach(function (line) {
      var match = /^out_time_us=(\d+)$/.exec(line.trim());
      if (match) onTime(Number(match[1]) / 1000000);
    });
  };
}

module.exports = {
  snapshot: snapshot,
  ffmpegArgs: ffmpegArgs,
  defaultDestination: defaultDestination,
  progressReader: progressReader,
};
