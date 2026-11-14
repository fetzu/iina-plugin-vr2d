# VR2D

An [IINA](https://iina.io) plugin that plays 3D VR video as a flat 2D picture you can look around
in — no headset, no stereo, just a normal window you pan and zoom.

Point it at a `..._180_180x180_3dh_LR.mp4` or a `..._MKX200.mp4` and it works out what the file is
and turns itself on. Ordinary videos are left completely alone.

## What it handles

| | |
|---|---|
| **Stereo layouts** | side-by-side, over-under, monoscopic, either eye first |
| **Projections** | 180° equirectangular, 360° equirectangular, equi-angular cubemap, fisheye (180 / 190 / 200 / 220°) |
| **Detection** | file-name conventions, container stereo metadata, frame aspect ratio |

Each of those is checked end to end rather than by inspection. Every fixture is derived from one
equirectangular graticule, so whatever the packing and projection, flattening it has to produce the
same picture — which makes a rendered frame comparable against ground truth:

| Source | Detected | Rendered vs ground truth |
|---|---|---|
| 180° half-equirect, side-by-side | sbs, left eye first | 25.5 dB |
| 180° half-equirect, right eye first | sbs, eyes swapped | 28.4 dB |
| 180° half-equirect, over-under | tb | 22.9 dB |
| 360° equirect, over-under | tb, full sphere | 27.4 dB |
| 360° equirect, monoscopic | mono | 26.8 dB |
| 360° equi-angular cubemap | mono, eac | 25.9 dB |
| 190° fisheye (RF52), side-by-side | sbs, 190° | 27.8 dB |
| 200° fisheye (MKX200), side-by-side | sbs, 200° | 27.4 dB |

The eye is verified separately by tinting one of the pair, so "it picked an eye" and "it picked the
*right* eye" are not the same result. Windowed, fullscreen, picture-in-picture, music mode and two
player windows at once were each exercised as well.

## Installing

In IINA, open **Settings → Plugins → Install from GitHub** and enter:

```
fetzu/iina-plugin-vr2d
```

Then switch VR2D on in the plugin list. IINA checks this repository for updates on its own.

To work on it instead, link a local checkout as a development plugin:

```bash
git clone https://github.com/fetzu/iina-plugin-vr2d.git
cd iina-plugin-vr2d
/Applications/IINA.app/Contents/MacOS/iina-plugin link .
```

Then open **IINA → Settings → Plugins** and switch VR2D on. A freshly linked plugin is registered
but disabled until you do — if nothing happens after linking, this is why.

To package it for distribution instead:

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin pack .
```

Requires IINA 1.4.0 or newer.

IINA 1.5 and later require the **File System** permission for the mpv commands VR2D uses
to apply the reprojection filter and change the view while the video plays.

## Using it

Open a VR video. If the name or the container says what it is, VR2D turns on by itself and tells
you what it found (`VR2D on — 180° equirect, side-by-side`).

| Action | |
|---|---|
| Look around | Drag the video |
| Zoom | Scroll |
| Look around (keyboard) | <kbd>⇧</kbd><kbd>⌥</kbd> + arrow keys |
| Zoom (keyboard) | <kbd>⌥</kbd><kbd>=</kbd> / <kbd>⌥</kbd><kbd>-</kbd> |
| Recentre | <kbd>⌥</kbd><kbd>0</kbd> |
| Try the next projection | <kbd>⌥</kbd><kbd>P</kbd> |
| Try the next stereo layout | <kbd>⌥</kbd><kbd>L</kbd> |
| Swap eye | <kbd>⌥</kbd><kbd>E</kbd> |
| Turn on/off | <kbd>⌥</kbd><kbd>⇧</kbd><kbd>V</kbd>, or **Plugins → Flatten VR Video** |

Every one of these is also a menu item under **Plugins**, so the shortcut is always visible next to
the command it runs.

Holding a pan or zoom key moves at a steady speed rather than one step per key repeat, so a tap
nudges and a hold glides — the OS repeat rate does not change how far you travel.

Shortcuts are assigned at startup from whatever is actually free — IINA drops a plugin's binding
without a word when something already owns the combination, so VR2D checks first and falls back to
its second choice rather than handing you a shortcut that does nothing. The menu always shows the
one it settled on.

Play/pause and double-click-to-fullscreen keep working while dragging is active — the drag surface
reproduces them. It also stays clear of the top and bottom of the window so the title bar and the
on-screen controller remain clickable; those margins are adjustable in the preferences.

### When the name tells you nothing

Plenty of files are named in a way that says nothing about how they were shot, and detection can
only guess. <kbd>⌥</kbd><kbd>P</kbd> steps through the projections one keystroke at a time,
announcing each on the OSD, so you can find the right one by eye in a few seconds — the tell is
that straight lines in the scene (door frames, ceiling beams, table edges) go straight when the
projection is right, and bow when it is wrong. <kbd>⌥</kbd><kbd>L</kbd> does the same for stereo
layout, <kbd>⌥</kbd><kbd>E</kbd> swaps eyes.

The same commands live under **Plugins**, in the VR2D section. IINA shows only the first five
top-level items a plugin adds — separators included — and sweeps the rest into a generic "More…",
so VR2D spends those five carefully:

```
✓ Flatten VR Video        ⌥⇧V
  Projection          ▸   Try the Next One ⌥P, then Auto + 8 presets
  Stereo Layout       ▸   Try the Next One ⌥L, then Auto + 5 layouts
  Eye                 ▸   Swap ⌥E, Left, Right
  Look Around         ▸   pan, zoom, recentre
```

The `Auto` entries name what detection guessed, so you can always see what VR2D thinks it is
looking at.

### View limits

You can never pan into the void. Yaw and pitch are fenced in by how much of the sphere the source
actually covers, and zooming out stops at the point where the view would run past the edge — so a
180° file simply refuses to look behind you, while a 360° file wraps around freely.

## How it works

Two libavfilter filters, added to mpv as one labelled chain:

```
crop=iw/2:ih:0:0 , v360=input=he:output=flat:d_fov=113:yaw=0:pitch=0:w=3024:h=1512
```

`crop` takes one eye out of the packed frame — free, it only moves the plane
pointers, and unlike `v360`'s own `in_stereo` handling it lets you choose *which*
eye. `v360` then reprojects that eye onto a flat rectilinear image aimed wherever
you are looking, rendered at exactly the window's pixel size.

`yaw`, `pitch` and `d_fov` are runtime-settable, so panning and zooming go
through `vf-command` and never rebuild the chain. Everything else — projection,
eye, output size — is fixed at build time.

### The constraints this runs into

All of these were measured on IINA 1.4.4 / mpv 0.38, and each one shapes the
design:

- **Reprojection is CPU work, and it is not cheap.** Every pan step makes `v360`
  recompute its entire remap table — about **0.064 s of CPU per megapixel of
  output**, twice per step (yaw and pitch). At a 1512x756 window that is 0.29 s
  per step. VR2D therefore paces its own update rate from the size being
  rendered, rather than hammering a fixed 30 Hz and stuttering.
- **Sharpness and smoothness genuinely trade against each other.** Both are
  governed by the same number — output pixels. Rendering at display resolution
  is the only way to avoid a soft, upscaled picture, and it is also what makes
  panning cost the most. See *Preferences* for which end to pick.
- **Hardware decoding has to copy back.** `v360` needs frames in system memory.
  Under plain `videotoolbox` mpv gives up with `Disabling filter vr2d because it
  has failed` — while still listing the filter in `vf`, so the failure is
  otherwise invisible. VR2D switches to `auto-copy`, which keeps the hardware
  decoder and just reads frames back, and restores your setting when it stops.
- **A graph rebuild throws runtime parameters away, and mpv may not tell you.**
  Any format change makes mpv re-parse the filter string, so `v360` reverts to
  the values baked in at attach time and the view snaps back on its own.
  Re-sending the commands does *not* work — around a rebuild mpv drops them.

  The trap is that the rebuild can be invisible from a plugin. Because VR2D's
  filter pins the output size and pixel format, a change *upstream* of it never
  reaches the video output, so `video-reconfig` arrives late or not at all.
  Measured: setting `hwdec` re-initialised the decoder and rebuilt the
  libavfilter graph **29 ms later**, with the seek event arriving only after the
  view had already been lost. A decoder falling back to software part-way
  through a file does the same thing, unprompted.

  So VR2D does not rely on being told. `video-params` — the decoder's output,
  *before* our filter — is watched alongside `video-reconfig`, `seek` and
  `playback-restart`, and the current view is baked back into the filter string
  **150 ms** after the last movement rather than 1200 ms, which is what closes
  the window in which a rebuild can strand the picture. Panning itself is
  unaffected: the flush loop sends absolute angles, so a rebuild mid-gesture is
  corrected by the next push a frame later, and the commit only ever fires once
  a gesture has finished (the overlay reports drag start and end, so a pause
  mid-drag is not mistaken for the end of one).
- **Paused, `vf-command` changes nothing on screen.** The held frame has already
  been filtered and mpv will not re-run the chain over it, so the view state
  moved while the picture sat still. While paused VR2D re-attaches instead,
  which does force a re-filter.
- **The output size decides the window size.** IINA resizes the player window to
  match the video whenever the video's size changes — verified even at identical
  aspect, where halving the output took a 640x400 window to 320x200. So VR2D
  sizes its output to exactly the window's own pixels, which is a fixed point
  that leaves the window alone, and puts the window back if a deliberate change
  (like the quality cap) would otherwise move it.

### Two things that were tried and rejected

- **Reprojecting in a GPU shader.** This would have made panning genuinely
  instantaneous and free. mpv 0.38 has `glsl-shader-opts` and the bundled
  libplacebo supports `//!PARAM`, but IINA renders through mpv's *classic* GPU
  renderer, which does not: loading such a shader logs
  `Unrecognized command 'PARAM shift'`. Without runtime uniforms there is no way
  to steer a shader from the plugin, so this is not available until IINA adopts
  `gpu-next`.
- **Rendering smaller while panning and sharper when still.** The obvious way to
  have both. It resizes the user's window on every drag, because of the coupling
  above, so it was removed.

What is left to make movement feel immediate is the read-out: the overlay
predicts the view locally, with the same maths the plugin uses, so the angles and
the field map track the cursor exactly while the picture follows a beat behind.

## Detection

A file is flattened automatically when there is at least one **strong** signal and the frame's
shape agrees with it:

- container stereo flag (`video-params/stereo-in`)
- an explicit layout in the name — `3dh`, `sbs`, `lr`, `rl`, `3dv`, `tb`, `ou`, `bt`, `mono`
- a lens profile — `MKX200`, `MKX220`, `VRCA220`, `RF52`, `fisheye190`
- an explicit projection — `180x180`, `vr180`, `360x180`, `vr360`, `equirect`, `eac`

**Weak** hints — a bare `180`/`360`, or a headset name like `oculus` or `quest` — are ignored by
default, because plenty of ordinary files contain them. Turn on *"Also act on weak hints"* to accept
them when the aspect ratio agrees.

Aspect ratio never triggers detection on its own; it only fills in and sanity-checks what the name
did not say. A 2:1 frame is 180° side-by-side or 360° monoscopic, and knowing the projection settles
which — so `_180_` on a 2:1 frame is read as a stereo pair, while `_360_` on the same frame is read
as mono.

## Preferences

**IINA → Settings → Plugins → VR2D.**

The one worth knowing about is **Reprojection quality**, because it is the
sharpness-versus-smoothness dial:

| Setting | Picture | Panning |
|---|---|---|
| Match the display *(default)* | Native, no upscaling | ~10 updates/s on a large window |
| Limit to 1080p | Slightly soft on a Retina display | ~15 updates/s |
| Limit to 720p | Noticeably soft | 30 updates/s |

Leave **Pan update rate** at 0 and VR2D works out a sustainable rate from
whatever it is currently rendering. Also there: detection behaviour, starting
field of view (horizontal, default 105°), eye, drag sensitivity and direction,
keyboard step, interpolation, and the safe-area margins.

## Limitations

- Reprojection is CPU-side, so hardware decoding runs in copy-back mode while VR2D is on, and
  panning cannot be frame-rate smooth at full display resolution.
- Dragging is captured by a transparent overlay, which means the top and bottom strips of the window
  are excluded so IINA's own controls keep working.
- Spherical metadata (`sv3d`/Spherical V1) is not read — mpv does not expose it. Stereo layout from
  the container is used, and the projection comes from the name or the aspect ratio.

## Development

```bash
npm install     # type definitions for editor completion
npm test        # unit tests for detection, frustum maths, filter building
```

Test clips are generated locally with `ffmpeg` and kept out of the repository. The fixtures behind
the table at the top of this file are all derived from a single equirectangular graticule — a grid
whose meridians must come out straight once flattened, with chroma ramping along longitude and
latitude — reprojected into each packing with `v360`. Building them that way is what makes a
rendered frame checkable against ground truth instead of eyeballed.

`src/detect.js`, `src/geometry.js` and `src/filter.js` are pure and free of any `iina` API use, so
they run under plain node — that is where the tests live. `src/session.js` owns the state machine
and the mpv filter; `src/index.js` is the wiring.

One IINA-specific trap worth repeating: `require()` only works while a module is being evaluated,
and `menu.forceUpdate()` and `overlay.onMessage()` must **not** be called during initial evaluation
of the entry script — the first traps the process, the second is silently dropped.

### Tracing what the filter is actually doing

`src/diag.js` is off by default; set `ENABLED = true` in it to turn it on. A plugin has no
file-system access and its console is not readable from a shell, so it goes through mpv instead:

- `mpv.set("log-file", …)` captures mpv's own messages at debug level — every `vf` and
  `vf-command`, every libavfilter graph construction with the exact filter string, and failures like
  `Disabling filter vr2d because it has failed`. `mpv.command("print-text", …)` interleaves the
  plugin's own state with them on one timeline. That pairing is what found the panning bug.
- `diag.shot()` writes a post-filter frame (`screenshot-to-file` with `window`, not `video`) named
  with the view the plugin believed at the time. Render a reference with the same numbers and
  compare:

  ```bash
  ffmpeg -i eye.png -vf "crop=iw/2:ih:0:0,v360=input=he:output=flat:interp=lanczos:w=1512:h=756:ih_fov=180:iv_fov=180:d_fov=111.07:yaw=31.5:pitch=8.1:roll=0" ref.png
  ffmpeg -i ref.png -i shot.png -lavfi "[0][1]psnr" -f null -
  ```

  A match is ~30 dB against a ~12 dB floor, so it is unambiguous. This is the only way to tell "the
  picture moved" from "our state moved", which is the whole bug class. Do **not** try to shortcut it
  by reading chroma out of the screenshot: the colour matrix does not survive the round trip and it
  reports a 30° pan as 23°.

Note that more than one IINA can be running — an installed build and a development build both load
the linked plugin — so each instance tags its own log and screenshots.
