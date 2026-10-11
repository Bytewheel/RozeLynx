# RozeLynx branding: what is generated, and where the real artwork goes

This is the artwork handover document for the RozeLynx rebrand. It explains, per
slot, what the build currently ships, the exact filename the real artwork must be
dropped into, the geometry that artwork must have, and any constraint that a
raster or a full-colour image cannot satisfy.

**Scope:** the `USE=rozelynx` branding block of `firefox-156.0.ebuild` /
`firefox-156.0.1.ebuild`. `firefox-153.3.0.ebuild` and `firefox-140.16.0.ebuild`
have no branding generation at all, so nothing described here applies to them.

## The drop-in contract

Five chrome slots accept real artwork by drop-in, with **no ebuild change**:

```
files/rozelynx/branding/vector/<slot-name>          real vector
files/rozelynx/branding/vector/<slot-stem>.png      real raster
```

`<slot-stem>` is `<slot-name>` with the `.svg` removed — the upstream slot
filename. The `vector/` directory name is now a slight misnomer: it holds the
drop-in *artwork* directory and accepts both media.

The ebuild resolves each slot in this order:

* **`vector/<slot>` exists** → copied **verbatim** over the slot. Nothing is
  generated and `magick` is not consulted for that slot.
* **`vector/<slot-stem>.png` exists** → resized at build time to the slot's
  raster budget and base64-wrapped in an `<image>` SVG of the slot's own
  geometry. **The art may be dropped in at any resolution**; the repo copy is
  already downscaled to the raster budget, but a full-resolution drop works
  unchanged and no base64 blob is ever committed.
* **neither exists** → a *placeholder* is generated from the slot's `<src>`
  fallback image (see the source-image table). Only two slots are in this state
  today: `about-logo.svg` and `extensions-panel-empty-onboarding.svg`.

Properties that hold in all three cases:

* Slots are **independent** — a file for one slot affects no other slot.
* Every generated file carries a comment naming its own provenance: a real
  drop-in says `RozeLynx artwork:` and a generated one says `PLACEHOLDER`, each
  naming its drop-in path. A shipped build can be traced back to this document.
* Two things must be true of that comment: it must not contain `--` (illegal
  inside an XML comment) and it must be a **single line** (a multi-line shell
  string carries the ebuild's tabs into the generated SVG). Do not "tidy" the
  note into a heredoc.
* The raster budget is **independent of the slot's user-unit geometry**: the
  `<image>` element is declared in `<svg_w>x<svg_h>` user units, so a raster
  with *more* pixels is a sharper image, not a scaled one. That is how the slots
  marked "2x" below get HiDPI-ready artwork. Measured: a 1x embed of the
  new-profile artwork rendered at 2x differs from the true 2x by RMSE 0.051.

## Slots that accept drop-in artwork

## Slots that accept drop-in artwork

### 1. `about-logo.svg` — the profile selector's logo

| | |
|---|---|
| Drop in | `branding/vector/about-logo.svg` (vector) or `branding/vector/about-logo.png` (raster) |
| Destination | `browser/branding/rozelynx/content/about-logo.svg` |
| Geometry | `width="512" height="512"`, **no `viewBox`** (match upstream) |
| Drawn by | `about:profiles` — `browser/components/profiles/content/profile-selector.mjs:177`, as `.logo`, which upstream sizes 64x64 (`profile-selector.css:18-21`) but **`profile-selector-logo-size.patch` raises to 320x320** (5x); also several smaller chrome surfaces (`--icon-size-large`, 18px, `list-style-image`) |
| Currently shipped | **generated placeholder** (no drop-in yet): a 960px-wide downscale of `main/no-text.png` centred on a transparent 512x512 canvas (size grows with the embed; it was 79,375 B at a 192px embed) |
| Constraint | the largest consumer is now **320px**, not 64px, so a scene reads acceptably where it previously did not. Still supply art that survives a centre crop, and prefer a square source (see the landscape note below). The placeholder remains legible because it embeds a raster rather than scaling one. |

The embed width tracks the largest consumer at 3x. It was 192 against a 64px
`.logo`, and is now **960 against the 320px** `.logo`
(`profile-selector-logo-size.patch`), which is what keeps the slot sharp at its
new size instead of upscaling. This is the only slot whose embed was raised for
a consumer-side change; every other slot is still sized for the consumers
Firefox ships.

### 2. `extensions-panel-empty.svg` — extensions panel, nothing installed

| | |
|---|---|
| Drop in | `branding/vector/extensions-panel-empty.svg` (vector) or `branding/vector/extensions-panel-empty.png` (raster) |
| Destination | `browser/themes/shared/addons/extensions-panel-empty.svg` |
| Geometry | `viewBox="0 0 177 132"`, **no `width`/`height`** (match upstream) |
| Selected by | `.extensions-emptypanel-state` → `content: url(…)` in `browser/themes/shared/addons/unified-extensions.css:46-48` |
| Currently shipped | **real artwork**: `vector/extensions-panel-empty.png` (1370x1148 source, 354x264 committed), wrapped in the 177x132 slot (145,354 B) |
| Constraint | the panel forces `aspect-ratio: 329 / 162; object-fit: contain` on the `<img>` (`unified-extensions.css:40-41`) regardless of the file's own aspect, and this state adds `margin: var(--space-large)`. Keep the native 177x132 aspect or the art will be letterboxed inside the reserved box. |

### 3. `category-extensions.svg` — the "Add-ons" heading icon in about:addons

| | |
|---|---|
| Drop in | `branding/about-addons-category.png` (raster) — a root-level asset, committed at source resolution like `favicon64.png` and `launcher-square.png` |
| Destination | `toolkit/themes/shared/extensions/category-extensions.svg`, reached as `chrome://mozapps/skin/extensions/category-extensions.svg` |
| Geometry | `viewBox="0 0 20 20"`, 60x60 embedded raster (2x on a 20px icon) |
| Selected by | `categories-box.mjs`, which sets it as the `iconsrc` of the Extensions category in the about:addons sidebar |
| Currently shipped | **real artwork**: `about-addons-category.png` (341x283 source), wrapped in the 20x20 slot (10,051 B) |
| Constraint | this is a **20x20 user-unit canvas** and the one small icon among these slots. `rozelynx_install_vector_slot` **contains** (no `^`) and pads onto a transparent canvas, so a source whose aspect is not 1:1 is letterboxed, not cropped — 341x283 becomes a 60x49 raster centred in 60x60. That is deliberate: at 20px a crop would cut the mark, where letterboxing keeps it whole. If it reads poorly when small, a near-square source suits a small icon far better than this landscape one. |
| Fallback | if the file is absent the ebuild `ewarn`s and leaves the stock Firefox icon in place |

### 4. `extensions-panel-empty-onboarding.svg` — extensions panel, onboarding

| | |
|---|---|
| Drop in | `branding/vector/extensions-panel-empty-onboarding.svg` (vector) or `branding/vector/extensions-panel-empty-onboarding.png` (raster) |
| Destination | `browser/themes/shared/addons/extensions-panel-empty-onboarding.svg` |
| Geometry | `width="329" height="162"`, **no `viewBox`** (match upstream) |
| Selected by | `.extensions-onboardingpanel-state` → `content: url(…)` in `unified-extensions.css:43-44` |
| Currently shipped | **generated placeholder** (329x162, 116,493 B) — *knowingly* left as one, see below |
| Constraint | same `aspect-ratio`/`object-fit` box as above, so 329x162 (2.03:1) is the aspect upstream reserved; artwork for this slot must be wide. |

**This is the one deliberate leftover.** The two panel states are selected
mutually exclusively by a class on the same `<img>`, so one image cannot serve
both. The finished puzzle-piece artwork is 1.193; it fits this slot's sibling
(177x132 = 1.341) well but would occupy ~52% of this 2.03:1 box. The decision
taken on 2026-09-27 was to give the real art to the **empty** state and leave
onboarding on the placeholder rather than duplicate a shrunken copy. Supplying
purpose-drawn 329x162 onboarding art (or a wide variant of the same scene) is
what closes it.

The `<img>` in `browser/components/customizableui/content/panelUI.inc.xhtml:103`
has **no `src` attribute at all** — the picture is chosen entirely by the CSS
`content:` rule and a class on the element, so these two files cannot be reached
by a filename search over `browser/themes` and are installed by explicit path.
If a future Firefox moves or drops one of them the build stops with the slot name
in the error, which is the intended signal.

Up to Firefox 155 these were a single file,
`extensions-panel-empty-illustration.svg` (329x162), renamed in 156 and joined by
the 177x132 `extensions-panel-empty.svg`. Check the real
`jar.inc.mn`/`unified-extensions.css` before reusing this table for another
version.

### 4. `cpm-fox-illustration.svg` — the "no saved passwords" empty state

| | |
|---|---|
| Drop in | `branding/vector/cpm-fox-illustration.svg` (vector) or `branding/vector/cpm-fox-illustration.png` (raster) |
| Destination | `toolkit/components/satchel/megalist/content/icons/cpm-fox-illustration.svg` (packaged as `content/global/megalist/icons/…` by `toolkit/components/satchel/jar.mn:17`) |
| Geometry | `width="204" height="182" viewBox="0 0 204 182"` (match upstream) |
| Drawn by | **three** consumers, all "you have no passwords" empty states: `about:logins` (`browser/components/aboutlogins/content/aboutLogins.html:241`, `.illustration` = `max-width: 300px; height: 209px` in `login-intro.css`, so 234x209 CSS px), and the contextual-password-manager megalist's `renderNoLoginsCard()` (`MegalistAlpha.mjs:580`) and `renderReauthPrimaryPassword()` (`MegalistAlpha.mjs:890`), both `max-width: 232px` so 204x182 |
| Currently shipped | **real artwork**: `vector/cpm-fox-illustration.png` (1409x1117 source, 468x418 committed = 2x the largest consumer), wrapped in the 204x182 slot (184,788 B) |
| Constraint | one chest illustration is the right art for all three consumers. `USE=remove-password-manager` does **not** remove the surface: it only sets `librewolf.hidePasswdmgr` and patches the app-menu entry, so `about:logins` stays reachable by URL. |

This file lives in `toolkit/`, not `browser/themes/`, so **neither `find` in the
rebranding block can reach it** — it needs its own explicit install line, exactly
as the two panel illustrations do.

### 5. `plus.svg` — the "create a new profile" card in `about:profiles`

| | |
|---|---|
| Drop in | `branding/vector/plus.svg` (vector) or `branding/vector/plus.png` (raster) |
| Destination | `browser/components/profiles/content/assets/plus.svg` |
| Geometry | **deliberately not** the upstream `width="80" height="80" viewBox="0 0 80 80"` — the slot is declared 400x272, see below |
| Drawn by | `browser/components/profiles/content/profile-card.css:71` — the `.profile-background-image` background of the `new-profile-card` in the profile selector. That is its **only** reference in the tree (the unrelated `chrome://global/skin/icons/plus.svg` is a different file) |
| Currently shipped | **real artwork**: `vector/plus.png` (1254x1254 source, 400x272 committed), wrapped in a 400x272 slot (122,776 B) |
| Constraint | see the two deviations below — both are one-line, both are recorded on purpose |

**Two deliberate deviations from upstream:**

1. **The slot geometry is 400x272, not 80x80.** This is the only slot whose
   intrinsic size is irrelevant: the file is consumed purely as a CSS
   `background-image` with `background-size: cover`, which discards the intrinsic
   size and fills the card's 200x136 box. Declaring the slot at the card's own
   1.47 aspect and 2x keeps the embedded raster at 1:1 device pixels. A slot that
   kept the native 80x80 would embed 80x80 of artwork for a 200x136 box.
2. **`new-profile-card-artwork.patch` is applied** to `profile-card.css`, changing
   `.new-profile-card .profile-background-image` from `background-size: 80px` to
   `cover`. Upstream pins it to 80px because the plus is an 80x80 glyph; without
   the patch the whole illustration would be shrunk to 80px. The sibling
   `.profile-background-image` base rule already uses `cover`, so this makes the
   new-profile card match them.

The trade-offs accepted: the `+` glyph and its `--icon-color` tint are gone (a
raster cannot inherit `fill`/`stroke` through `-moz-context-properties`), and the
card's "Create a Profile" label is now the only affordance. The square source
letterboxes into the 1.47 card — the subject trims to 228x240 inside the 400x272
canvas, so it draws at ~114px of a 200px card. Cropping instead of letterboxing
was rejected: a 1:1 source into 1.47 loses 32% of the height, which cuts the
floating avatar discs off the top.

## Raster drop-ins added for the logo and the trust chip

Two slots groups that previously had no drop-in path now take artwork from this
directory, because the generated fallback for the logo cannot work:

### `about-logo.png` / `about-logo@2x.png` / `about.png` — newtab and about dialogs

| | |
|---|---|
| Drop in | `branding/vector/about-logo.png` (raster) |
| Destination | `browser/branding/rozelynx/content/{about,about-logo,about-logo@2x}.png` |
| Geometry | 192x192, centre crop |
| Currently shipped | **real artwork**: `branding/launcher-square.png` (475x475, mean alpha 0.872) |

These three were previously always regenerated from `main/no-text.png` with no
way to substitute artwork. That mattered because `main/no-text.png` is an
opaque full-bleed scene (mean alpha **1.0**), so the generated 192x192 PNG is a
fully opaque pale square (mean luma 0.75). The newtab draws it through CSS as a
64px `background-image`, so a light content colour scheme puts a luma-0.75
square on a luma-1.0 page and the mark reads as gone. `-background none`
cannot fix this: it preserves alpha, it cannot invent it, and the source has
none. Nor can CSS — an opaque background-image hides the page behind it.

`launcher-square.png` was chosen because it is the one asset in the tree that is
both transparent at the edges and mid-tone (alpha 0.872, luma 0.581), so it
separates from both a light and a dark page. Re-drop at any resolution.

### `trust-icon-active.svg` / `trust-icon-insecure.svg` — the URL-bar trust chip

| | |
|---|---|
| Drop in | `branding/trust-icon-active.png` (secure) and `branding/trust-icon-insecure.png` (unsecure) |
| Destination | `browser/themes/shared/browser/trust-icon-{active,insecure}.svg` |
| Geometry | `viewBox="0 0 16 16"`, matching the 16x16 box `identity-block.css` gives the icon |
| Currently shipped | **real artwork** (94x89 each, mean alpha 0.403) |

`identity-block.css` selects between two near-identical stock padlocks —
`&:where(.insecure) -> trust-icon-insecure.svg` and `&.secure ->
trust-icon-active.svg` — and they were the last unmasked Firefox marks in the
chrome, because the rebranding sweep only rewrites files named
`firefox*.svg` / `fox*.svg`.

Both stock files are `context-fill` / `context-stroke` masks: the container sets
`-moz-context-properties: fill, fill-opacity, stroke` and the insecure variant
takes `stroke: var(--icon-color-critical)`. **That tinting is intentionally
discarded** here, because the replacement artwork carries its own colours.
Anyone who later wants the chip to follow the theme colour again needs real
monochrome vector art rather than a raster.

## Known gap: `window-firefox.svg` (window / taskbar / tray icon)

| | |
|---|---|
| File | `browser/themes/shared/icons/window-firefox.svg` |
| Geometry | `width="16" height="14" viewBox="0 0 16 14"` |
| Constraint | `fill="context-fill" fill-opacity="context-fill-opacity"` — a **monochrome mask** that inherits the theme's foreground colour |
| Status | **not branded.** Still upstream Fox art. Deliberately left alone. |

This slot cannot take a raster or a full-colour mark: `context-fill` is resolved
by the theme, so a placeholder would either be invisible or break light/dark
tinting. It needs real monochrome vector art at 16x14.

When replacing it, keep the upstream structure: the two `.proton` / `.nova`
`<g>` groups and the `<style>` block that switches between them on the
`browser.nova.enabled` pref. Dropping a single-path file would silently drop
Nova-theme support.

## Source images in this directory

| File | Used for | Notes |
|---|---|---|
| `main/full.png` | **nothing** — *dead since 156* | the ebuild used to render this to `content/newtab-background.png`; the identifier is gone from the 156 tree and `branding/*/content/jar.mn` has no entry for it, so no jar packaged it. 156's newtab background is the builtin addon's `--newtab-background-color` CSS variable, or a wallpaper the user picks (`browser.newtabpage.activity-stream.newtabWallpapers.wallpaper`, resolved over the Remote Settings collection `newtab-wallpapers-v2`). Neither path has a build-time branding slot. Kept as artwork. |
| `main/no-text.png` | about/logo rasters + the two remaining slot placeholders | **landscape scene, 707x460**, not a mark — see below |
| `dark/no-text.png` | `default{16,32,48,64,128}.png` | line-art icon, 454x448, ~24% mean alpha; effectively square, so the square crops are ~0px. No longer the private-browsing logo — that slot has its own artwork now. |
| `light/no-text.png` | *not referenced* | see "dead images" below |
| `main/wordmark.png`, `light/wordmark.png`, `dark/wordmark.png` | *not referenced* | see "dead images" below |
| `favicon64.png` | *not referenced* | see "dead images" below |

### The finished illustrations in `vector/`

These are the real drop-in artwork, committed at the size the build embeds them
(24-bit RGBA, `-strip`). Re-drop them at any resolution; the build resizes.

| File | Source artwork | Committed | Embedded in slot |
|---|---|---|---|
| `vector/extensions-panel-empty.png` | 1370x1148, the lynx lying among rose puzzle pieces | 354x264 (123,209 B) | 177x132 |
| `vector/cpm-fox-illustration.png` | 1409x1117, the lynx on the purple-and-brass chest | 468x418 (138,179 B) | 204x182 |
| `vector/plus.png` | 1254x1254, the standing lynx with four avatar discs | 400x272 (91,900 B) | 400x272 |

All three are cut-out illustrations (mean alpha 0.264, 0.333 and 0.410), not flat
scenes, and
all are the same finished RozeLynx style, so they are replacements for the
*generated placeholders* — not for the old rose vectors (see "Current vector
sources" below, which are a separate, still-open gap).

They ship as **24-bit RGBA**, which costs ~450 KB of base64 across the three
slots. Measured alternative: `-colors 256 PNG8` is 3.5x smaller and the difference
at display size is RMSE 0.010 (below the visible threshold on this artwork), so if
`omni.ja` size ever matters more than headroom, quantising them is a one-line
change with no visible cost.

### The square-slot crop (`main/no-text.png`)

`main/no-text.png` is a full-bleed landscape scene, 707x460. The about/logo raster
slots are square, so they take a **centre crop**: `-resize 192x192^` scales by
0.4174 to 295x192 and keeps the middle 65% of the width — 17.4% trimmed per side.
Measured on the real output: the subject (lynx, rose) is complete and unclipped;
what the crop removes is outer cloud/star/bubble decoration.

Do not "fix" this by dropping the `^`. Without it, 707x460 into a 192x192 box is
192x125 of art centred on 33px of transparent band top and bottom — a logo slot
with a third of its height empty. The letterbox is correct for the 512x512
`about-logo.svg` (a 64px consumer wastes nothing) and wrong for the 192px about
raster. If a square source or a purpose-drawn mark is wanted, add one and change
the source, not the flags.

### Dead images — do not "fix" these

* **`{main,light,dark}/wordmark.png`** — the wordmark slots (`about-wordmark.svg`,
  `firefox-wordmark.svg`) are filled from `icon/rozelynx-wordmark.svg`, not from
  these PNGs, so the PNGs are inert. They are kept as the intended source for a
  future wordmark vector, not as a packaging bug.
* **`light/no-text.png`** — 447x443, the light-mode line art. Kept for
  completeness; it is currently not wired to any slot. `dark/no-text.png` (454x448)
  covers the same slots.
* **`favicon64.png`** — 38x35, unreferenced. The 64px window icon is generated
  from `dark/no-text.png` (`default64.png`), so this file only matters if the
  intent is the *favicon64* artwork specifically at 64px. The fallback favicon
  for favicon-less pages is a separate vector slot
  (`toolkit/themes/shared/icons/defaultFavicon.svg`) which is already replaced with
  `icon/rozelynx.svg`.

### Raster artwork added 2026-09-30

Three slots now take new raster artwork, all from
`~/Documents/ByteWheel/marketing/RozeLynx/`. Re-drop at any
resolution; the build resizes and centre-crops.

| Source | Slot | Notes |
|---|---|---|
| `favicon64.png` (38x35) | `default64.png` — the 64px window/taskbar icon | crops to square, ~8% of width lost |
| `favicon64.png` (38x35) | `toolkit/themes/shared/icons/defaultFavicon.svg` — the favicon-less-pages fallback | a **raster** in an SVG slot, so it is embedded as a base64 `<image>`; both the proton and nova variants carry it so the nova UI cannot fall back to stock art |
| `launcher-square.png` (475x475, 1:1) | `/usr/share/icons/hicolor/<n>x<n>/apps/rozelynx-launcher.png`, and the `.desktop`'s `Icon=` | its own icon **name**, because `rozelynx.png` is also the notification-badge icon and the badge is wanted as the logo. Square source, so every size in the ladder is a plain downscale and nothing is cropped. This replaced `launcher.png` (707x539, landscape), which in a square slot lost about 24% of its width to a centre-crop |
| `Roze.png` (132x115) | the extension's own `icons/icon{16,32,48,64,128}.png` | cropped to 115x115 first, then to each size |

Each falls back to the previous mark when the artwork is absent, so a tree
without it installs what it installed before. The branding harness asserts
the *source* of the 64px, launcher and favicon slots, not just that each
file was written.

### Raster artwork added 2026-10-11

| Source | Slot | Notes |
|---|---|---|
| `dark-cropped-transparent.png` (447x443, transparent) | `extension/icons/pwa-fallback.png` — the PWA fallback art | shipped at native resolution and `-strip`'d, no resample |

The source is `~/Documents/hawksnestsoftware/marketing/RozeLynx/dark-cropped-transparent.png`
(the hawksnest marketing checkout; the earlier rows in this document name the
ByteWheel marketing path, which no longer exists on this machine).

This is the PWA fallback, and it is deliberately *not* wired through the
hicolor theme: a generated `.desktop` entry used to fall back to
`Icon=rozelynx`, and the theme's `scalable/apps/rozelynx.svg` slot is the
**discontinued old logo** — so a PWA without a usable icon launched with
the old logo in the launcher and the default mark in the taskbar. The
extension (`modules/pwa/background.js`, v1.0.73) now materialises a *file*
before ever emitting a theme name: the site icon, a stored candidate URL,
a live tab favicon, and then this artwork, written through the parent
(`rozelynxWindows.writeIconFile`) into `<profile>/pwa-icons/rozelynx-pwa-fallback.png`
so the entry's `Icon=` and the taskbar both get an absolute path a desktop
renders directly. The `rozelynx` theme name survives only as the last resort
of a parent that cannot write files at all, and the extension's own
`hasDesktopEntry` read-back lets the start-up reconcile pass *upgrade*
entries an earlier version left on the theme name.

Because the fallback rides inside the extension, no ebuild or distro-script
change is involved: `assemble-extension.py` copies `icons/` wholesale, so
the drop-in file name above is the whole contract.

### Current vector sources (still the old rose mark)

`icon/rozelynx.svg`, `icon/rozelynx-wordmark.svg` and `icon/rozelynx-symbolic.svg`
predate the new artwork. They are still copied over every theme fox
(`firefox*.svg`, `fox*.svg`, `foxy*.svg`, `avatar-fox*.svg` in `browser/themes`),
`defaultFavicon.svg`, `default.svg`, the app icon, and the two wordmark slots.
So the chrome still shows the **old rose** everywhere the rose is copied, and the
**new artwork** only where a raster is generated. Closing that gap means adding
real vector drop-ins for those slots, or re-authoring `icon/rozelynx.svg`.

## Raster slots generated at build time

Generated with ImageMagick in `src_prepare`; each call is a hard `die` on failure,
and a missing `magick` is itself fatal (`media-gfx/imagemagick` is a
`USE=rozelynx` `BDEPEND`). There is no fallback path that can ship unbranded
Firefox artwork.

| Destination slot | Source | Geometry |
|---|---|---|
| `default{16,32,48,64,128}.png` | `dark/no-text.png` | square, centre crop — **only these five**: `branding/*/content/jar.mn` installs exactly `icon16/32/48/64/128.png`, and `branding-common.mozbuild` installs the same five for gtk. `default22/24/256.png` exist for the Windows msix tile set, which this Linux-only ebuild never builds. |
| `content/about.png`, `content/about-logo.png`, `content/about-logo@2x.png` | `main/no-text.png` | 192x192, centre crop |
| `about.png` | `main/no-text.png` | 192x192, centre crop |
| `content/about-logo-private.png`, `content/about-logo-private@2x.png` | `private-browsing.png` (**art**, landscape 707x459, fully opaque) | 192x192 **centre crop**, which keeps 459x459 and discards about 35% of the width — by far the most aggressive crop of any slot here. `aboutPrivateBrowsing.css` sets `.logo` to `var(--size-image-xxlarge)` in both axes, so the slot really is square; a source that should not lose its edges wants to be square. Falls back to `dark/no-text.png`. |
| `content/private-wallpaper.png` | `private-background.png` (**art**, 1314x1197, the marketing `pounce-thorns.jpg` as a `-strip` PNG) | plain `cp` — no crop, no resize. The private page's own stylesheet (the `aboutPrivateBrowsing.css` append in the same block) scales it `cover`, so the source ships at native resolution and the window crop happens at paint time. Registered in `content/jar.mn` alongside the newtab wallpaper, which is an allowlist: a slot missing from it is silently dropped and its `chrome://` URL 404s. |
| `content/about-logo.svg` | `main/no-text.png` (*placeholder*) or `vector/about-logo.png` | 512x512 canvas, 960px embed |
| `themes/shared/addons/extensions-panel-empty.svg` | `vector/extensions-panel-empty.png` (**art**) or `main/no-text.png` | 177x132 slot, 354x264 raster (2x) |
| `themes/shared/addons/extensions-panel-empty-onboarding.svg` | `main/no-text.png` (*placeholder*) or `vector/extensions-panel-empty-onboarding.png` | 329x162 slot, 329x162 raster |
| `themes/shared/extensions/category-extensions.svg` | `about-addons-category.png` (**art**) | 20x20 slot, 60x60 raster (2x), contained |
| `satchel/megalist/content/icons/cpm-fox-illustration.svg` | `vector/cpm-fox-illustration.png` (**art**) or `dark/no-text.png` | 204x182 slot, 468x418 raster (2x) |
| `profiles/content/assets/plus.svg` | `vector/plus.png` (**art**) or `main/no-text.png` | 400x272 slot, 400x272 raster (2x) |

## Verifying a change

The branding lands in `browser/omni.ja`, so after a re-emerge:

```sh
unzip -l /usr/lib64/rozelynx/browser/omni.ja \
  | grep -E 'branding|extensions-panel-empty|cpm-fox-illustration|profiles/content/assets/plus'
```

The **quickest** check needs no emerge at all — each slot is named in the build
log, and the string says which of the three branches produced it:

| Log line | Meaning |
|---|---|
| `… : real vector artwork from branding/vector/<slot>` | copied verbatim; your `.svg` is live |
| `… : real raster artwork from branding/vector/<stem>.png (WxH raster in a WxH SVG)` | your `.png` is live, embedded at `WxH` |
| `… : generated placeholder (no branding/vector/<slot> or <stem>.png) (WxH raster in a WxH SVG)` | still a placeholder; the drop-in was not found |

The same three states are readable from the packaged file itself: the generated
SVG opens with a comment beginning `<!-- RozeLynx artwork:` (drop-in) or
`<!-- PLACEHOLDER` (generated).

`new-profile-card-artwork.patch` is applied with `eapply`, so a Firefox release
that renumbers `profile-card.css` fails the build with a patch hunk error rather
than silently reverting the new-profile card to an 80px thumbnail.
