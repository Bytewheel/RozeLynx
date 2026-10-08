#!/usr/bin/env bash
# sync-from-hawksnest.sh - refresh this repository's patch mirror from
# the hawksnest Gentoo overlay (the development source of truth).
#
# Mirrored (byte-identical):
#   patches/            the firefox-librewolf patch tree: LibreWolf
#                       patches + settings at the top level, ui-patches/,
#                       root-patches/, and the full rozelynx/ tree
#                       (branding, cpp components, extension, host,
#                       mozconfig, prefs, skins, toolchain)
#   gentoo/firefox-template.ebuild    the patched ebuild template
#   rozelynx-distro-build.sh          the distro-agnostic build script
#   rozelynx-distro-versions.conf     the pinned-source config
#
# NOT mirrored (hawksnest plumbing / dev-only): apply.sh, generate_ebuilds
# plumbing, metadata.xml fragments, plans/, tests/ (they assert the
# portage mirror layout), *.bak files, and the rozelynx README (this
# repo's root README.md is the project README).
#
# Usage:
#   ./sync-from-hawksnest.sh [SRC]
#   HAWKNEST_SRC=/var/db/repos/hawksnest ./sync-from-hawksnest.sh
#
# Default SRC is the Documents overlay; the portage mirror at
# /var/db/repos/hawksnest is used as fallback when it exists and the
# Documents one does not.

set -euo pipefail

die() { printf '** %s\n' "$*" >&2; exit 1; }
log() { printf ':: %s\n' "$*"; }

DST="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

_src_candidates=(
    "${1:-${HAWKNEST_SRC:-}}"
    "$HOME/Documents/hawksnestsoftware/hawksnest-gentoo-overlay"
    "/var/db/repos/hawksnest"
)
SRC=""
for _c in "${_src_candidates[@]}"; do
    [[ -n ${_c} ]] || continue
    if [[ -d ${_c}/scripts/firefox-librewolf/rozelynx \
          && -d ${_c}/scripts/firefox-librewolf/ui-patches ]]; then
        SRC="${_c}/scripts/firefox-librewolf"
        break
    fi
done
[[ -n ${SRC} ]] || die "no hawksnest overlay found (looked for scripts/firefox-librewolf under the candidates) - pass the path as the first argument"

log "source: ${SRC}"
log "destination: ${DST}"

# --- the patch tree ---------------------------------------------------------
# top level: LibreWolf patches + settings (settings files and every
# *.patch; excludes the hawksnest plumbing listed in the header)
rsync -a --delete \
    --exclude='apply.sh' \
    --exclude='firefox-template.ebuild' \
    --exclude='metadata-*.xml' \
    --exclude='rebuild-omni.py' \
    --exclude='*.bak' \
    --exclude='/plans/' \
    --exclude='/tests/' \
    --exclude='/ui-patches/' \
    --exclude='/root-patches/' \
    --exclude='/rozelynx/' \
    --exclude='/rozelynx-distro-build.sh' \
    --exclude='/rozelynx-distro-versions.conf' \
    --exclude='/README.md' \
    "${SRC}/" "${DST}/patches/"

rsync -a --delete --exclude='*.bak' \
    "${SRC}/ui-patches/" "${DST}/patches/ui-patches/"
rsync -a --delete --exclude='*.bak' \
    "${SRC}/root-patches/" "${DST}/patches/root-patches/"
rsync -a --delete --exclude='*.bak' --exclude='/README.md' \
    "${SRC}/rozelynx/" "${DST}/patches/rozelynx/"

# --- gentoo ebuild template -------------------------------------------------
mkdir -p "${DST}/gentoo"
cp "${SRC}/firefox-template.ebuild" "${DST}/gentoo/firefox-template.ebuild"

# --- distro-agnostic build + pins ------------------------------------------
cp "${SRC}/rozelynx-distro-build.sh" "${DST}/rozelynx-distro-build.sh"
cp "${SRC}/rozelynx-distro-versions.conf" "${DST}/rozelynx-distro-versions.conf"
chmod +x "${DST}/rozelynx-distro-build.sh"

log "mirror refreshed - review with: git -C ${DST} status --short"