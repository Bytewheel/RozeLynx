#!/usr/bin/env bash
#
# rozelynx-distro-build.sh - distro-agnostic build for RozeLynx.
#
# RozeLynx is a patch set on top of Firefox maintained in this overlay
# (scripts/firefox-librewolf/ + www-client/firefox/files/).  The Gentoo
# build applies them via the ebuild; this script reproduces the same
# flow on any Linux distro.
#
# Stages:
#   fetch     - pull versioned/pinned sources:
#                 firefox-<ver>.source.tar.xz   build base (pinned)
#                 Gentoo firefox patchset      build fixes (pinned)
#                 LibreWolf source @ LIBREWOLF_REF
#                                               reference checkout: the
#                                               LibreWolf patches VENDORED
#                                               in this overlay (already
#                                               rebased per Firefox
#                                               version) are what gets
#                                               applied, not upstream's
#                 Floorp source @ FLOORP_REF   REFERENCE ONLY: Floorp
#                                               features are already ported
#                                               into the RozeLynx extension
#                                               + C++ code, so nothing from
#                                               the Floorp tree is applied
#                                               as a patch
#   prepare   - unpack firefox, apply Gentoo patchset, the full RozeLynx
#               sequence (configure patch, branding sweep + branding dir +
#               magick icon generation, PWA + net-iface C++ components,
#               the PAM passkey platform authenticator, the
#               extension-menus patch) and the LibreWolf privacy patch set,
#               feature-gated with the same flag names as the ebuild USE
#               flags
#   configure - generate .mozconfig (prefix/libdir/toolkit/audio/system
#               libs, rozelynx branding, telemetry off) + ./mach configure
#   build     - ./mach build
#   install   - DESTDIR staging: ./mach install + the src_install flow
#               (prefs, librewolf.cfg + local-settings.js + policies.json,
#               RozeLynx Features XPI, Lepton/SSB chrome, native messaging
#               host, icons, desktop file, launcher)
#   package   - stage artifacts:
#                 --tarball  dist/rozelynx-<ver>-<arch>.tar.xz
#                 --appimage dist/RozeLynx-<ver>-<arch>.AppImage
#                 --flatpak  dist/RozeLynx-<ver>.flatpak (needs flatpak,
#                            flatpak-builder and the pinned runtime+sdk)
#                 --snap     dist/rozelynx_<ver>_<arch>.snap (needs snapd)
#
# Versions are pinned in rozelynx-distro-versions.conf next to this
# script; override via environment or flags.
#
# Usage:
#   ./rozelynx-distro-build.sh [STAGE...] [OPTIONS]
#
# Examples:
#   ./rozelynx-distro-build.sh all --appimage --flatpak --snap
#   ./rozelynx-distro-build.sh fetch prepare configure
#   ./rozelynx-distro-build.sh --no-use clang --no-use X all --appimage
#   ./rozelynx-distro-build.sh --use pgo --no-use net-iface install
#   ./rozelynx-distro-build.sh --list-flags
#
# Requirements (checked at runtime): tar, patch, git, python3, zip,
# node (build tooling), rustc, magick (ImageMagick 7 - hard requirement
# for the RozeLynx branding, same rule as the ebuild), a C/C++ toolchain,
# nasm on x86, plus the usual system libraries (nss/nspr/icu/harfbuzz/...).
#
# Notes:
#   * The Gentoo patchset is applied because the mozconfig mirrors the
#     ebuild defaults (system libs everywhere); drop --no-use system-* if
#     you want fewer system-library dependencies.
#   * pam-passkeys links libpam into libxul (sys-libs/pam on Gentoo, pam on
#     Arch, libpam0g-dev on Debian) and needs a PAM service to verify
#     against: /etc/pam.d/rozelynx if present, else the system-auth /
#     common-auth chains (face recognition via howdy, password fallback).
#     Without a PAM stack the feature reports unavailable and WebAuthn
#     falls back to USB security keys.
#   * net-iface SO_BINDTODEVICE needs CAP_NET_RAW: granted via setcap in
#     the staged tree when running as root (xattrs survive tar + snap
#     pack). AppImage squashfs mounts are nosuid - grant cap_net_raw to
#     the extracted AppDir binary on the host if you need it.
#   * Set SOURCE_DATE_EPOCH for reproducible tarball timestamps.

set -Eeuo pipefail
umask 022

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
VERSIONS_CONF="${SELF_DIR}/rozelynx-distro-versions.conf"

# ---------------------------------------------------------------------------
# pinned-source defaults (rozelynx-distro-versions.conf), env overrides win
# ---------------------------------------------------------------------------
FIREFOX_VERSION=""
APP_VERSION=""
GENTOO_PATCHSET=""
GENTOO_PATCHSET_BASE_URI=""
FIREFOX_SOURCE_SHA512=""
GENTOO_PATCHSET_SHA512=""
LIBREWOLF_REPO=""
LIBREWOLF_REF=""
FLOORP_REPO=""
FLOORP_REF=""
APPIMAGETOOL_TAG=""
FLATPAK_RUNTIME=""
FLATPAK_RUNTIME_VERSION=""
FLATPAK_SDK=""
SNAP_BASE=""

if [[ -r ${VERSIONS_CONF} ]]; then
    # shellcheck disable=SC1090
    source "${VERSIONS_CONF}"
fi
[[ -n ${ROZELYNX_FIREFOX_VERSION:-} ]] && FIREFOX_VERSION="${ROZELYNX_FIREFOX_VERSION}"
[[ -n ${ROZELYNX_APP_VERSION:-} ]] && APP_VERSION="${ROZELYNX_APP_VERSION}"
[[ -n ${ROZELYNX_LIBREWOLF_REF:-} ]] && LIBREWOLF_REF="${ROZELYNX_LIBREWOLF_REF}"
[[ -n ${ROZELYNX_FLOORP_REF:-} ]] && FLOORP_REF="${ROZELYNX_FLOORP_REF}"

# ---------------------------------------------------------------------------
# feature flags - same names as the ebuild USE flags
# ---------------------------------------------------------------------------
ALL_FLAGS=(
    clang dbus debug eme-free hardened hwaccel jack libproxy pgo pulseaudio
    selinux sndio valgrind wayland wifi X
    system-av1 system-harfbuzz system-icu system-jpeg system-libevent
    system-libvpx system-pipewire system-png system-webp test
    gmp-autoupdate gnome-shell jpegxl jumbo-build openh264 telemetry
    wasm-sandbox
    remove-safebrowsing remove-pocket remove-password-manager remove-sponsored
    librewolf-ui extension-firewall remove-pingsender remove-openai
    webgl-permission fingerprint-fixes autoconfig-enhanced remove-ads
    privacy-ui translation-fullpage extension-uninstall-url permission-tweaks
    ui-tweaks link-preview language-packs xdg-profile newtab-fixes
    rozelynx rozelynx-debug chrome-web-store experiments external-browser
    i18n mouse-gestures qr-code pwa lepton-skin ip-protection net-iface
    download-handoff user-agent sync twofa pam-passkeys
)
# system-harfbuzz is deliberately NOT on by default: with it, the skia
# unified TU that includes Skia's harfbuzz adapter references hb_* with
# STV_HIDDEN (Skia's own #pragma GCC visibility push(hidden) sits over the
# hb headers), and libxul's -z defs link then fails on a fresh objdir -
# ld.lld ("undefined hidden symbol", the merged visibility cannot bind to
# libharfbuzz.so) and ld.bfd ("undefined reference") alike. The shipped
# v158.0.x tarballs and the emerged binary both carry VENDORED harfbuzz
# (a local `t hb_blob_destroy` inside libxul), so vendored is also the
# release lineage. --use system-harfbuzz stays available for anyone who
# wants to fight the skia visibility merge on their own toolchain.
DEFAULT_USE_ON=(
    rozelynx chrome-web-store experiments external-browser i18n mouse-gestures
    qr-code pwa lepton-skin ip-protection net-iface download-handoff
    user-agent sync twofa pam-passkeys
    remove-safebrowsing remove-pocket remove-password-manager remove-sponsored
    librewolf-ui extension-firewall remove-pingsender remove-openai
    webgl-permission fingerprint-fixes autoconfig-enhanced remove-ads
    privacy-ui translation-fullpage extension-uninstall-url permission-tweaks
    ui-tweaks link-preview xdg-profile newtab-fixes
    clang dbus hwaccel pulseaudio wayland X wifi
    system-av1 system-icu system-jpeg system-libevent
    system-libvpx system-webp
    gmp-autoupdate jpegxl jumbo-build
)
DEFAULT_USE_OFF=(
    telemetry debug eme-free hardened jack libproxy pgo selinux sndio
    valgrind test wasm-sandbox system-pipewire system-png openh264
    gnome-shell rozelynx-debug language-packs
)

declare -A USE=()
for _f in "${DEFAULT_USE_ON[@]}";  do USE["${_f}"]=1; done
for _f in "${DEFAULT_USE_OFF[@]}"; do USE["${_f}"]=0; done
unset _f

use() { [[ "${USE[${1}]:-0}" == "1" ]]; }

log()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m**\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

list_flags() {
    printf 'RozeLynx feature flags (same names as the Gentoo ebuild USE flags):\n'
    printf '\n  on by default:\n    %s\n' "${DEFAULT_USE_ON[*]}"
    printf '\n  off by default:\n    %s\n' "${DEFAULT_USE_OFF[*]}"
    printf '\nToggle with --use FLAG[,FLAG] / --no-use FLAG[,FLAG] (repeatable).\n'
    exit 0
}

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 ($2)"
}

ver_ge() {  # ver_ge A B -> exit 0 iff A >= B
    local smaller
    smaller="$(printf '%s\n' "$1" "$2" | LC_ALL=C sort -V | head -n 1)"
    [[ "$smaller" == "$2" ]]
}

is_glibc() {
    local ldd_out
    ldd_out="$(ldd --version 2>&1 | head -n 1)" || true
    [[ "${ldd_out}" != *musl* ]]
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
ROZELYNX_SRC_ROOT="${SELF_DIR}"
ROZELYNX_WORKDIR=""
PREFIX="/usr"
LIBDIR="auto"
JOBS="$(nproc 2>/dev/null || echo 2)"
DEFAULT_WAYLAND="true"
SYMLINK_FIREFOX="no"
OFFLINE="0"
STAGES=()
PKG_TARBALL="no"
PKG_APPIMAGE="no"
PKG_FLATPAK="no"
PKG_SNAP="no"

apply_use_args() {
    local arg flag known f
    for arg in "$@"; do
        flag="${arg#[-+]}"
        known=0
        for f in "${ALL_FLAGS[@]}"; do
            [[ "$f" == "${flag}" ]] && known=1
        done
        [[ ${known} -eq 1 ]] || die "unknown feature flag '${arg}' (see --list-flags)"
        case "$arg" in
            -*) USE["${flag}"]=0 ;;
            *)  USE["${flag}"]=1 ;;
        esac
    done
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        fetch|prepare|configure|build|install|package)
            STAGES+=("$1") ;;
        all)
            STAGES+=(fetch prepare configure build install) ;;
        --tarball)  PKG_TARBALL="yes" ;;
        --no-tarball) PKG_TARBALL="no" ;;
        --appimage) PKG_APPIMAGE="yes" ;;
        --flatpak)  PKG_FLATPAK="yes" ;;
        --snap)     PKG_SNAP="yes" ;;
        --package|--packages)
            shift
            [[ $# -gt 0 ]] || die "--package needs a comma-separated list (tarball,appimage,flatpak,snap)"
            IFS=, read -r -a _pkgs <<<"$1"
            for _p in "${_pkgs[@]}"; do
                case "$_p" in
                    tarball)  PKG_TARBALL="yes" ;;
                    appimage) PKG_APPIMAGE="yes" ;;
                    flatpak)  PKG_FLATPAK="yes" ;;
                    snap)     PKG_SNAP="yes" ;;
                    *) die "unknown package format '${_p}'" ;;
                esac
            done
            ;;
        --workdir)  ROZELYNX_WORKDIR="${2:?--workdir needs a path}"; shift ;;
        --src-root) ROZELYNX_SRC_ROOT="${2:?}"; shift ;;
        --jobs|-j)  JOBS="${2:?}"; shift ;;
        --prefix)   PREFIX="${2:?}"; shift ;;
        --libdir)   LIBDIR="${2:?}"; shift ;;
        --firefox)      FIREFOX_VERSION="${2:?}"; shift ;;
        --app-version)  APP_VERSION="${2:?}"; shift ;;
        --librewolf-ref) LIBREWOLF_REF="${2:?}"; shift ;;
        --floorp-ref)    FLOORP_REF="${2:?}"; shift ;;
        --use|--no-use)
            _neg="0"
            [[ "$1" == "--no-use" ]] && _neg="1"
            shift
            [[ $# -gt 0 ]] || die "--use/--no-use needs flag names (comma separated)"
            _IFS="${IFS}"; IFS=,
            read -r -a _args <<<"$1"; IFS="${_IFS}"
            if [[ ${_neg} == 1 ]]; then
                apply_use_args "${_args[@]/#/-}"
            else
                apply_use_args "${_args[@]}"
            fi
            ;;
        --symlink-firefox) SYMLINK_FIREFOX="yes" ;;
        --default-wayland=*) DEFAULT_WAYLAND="${1#*=}" ;;
        --offline) OFFLINE="1" ;;
        --list-flags|--list-features) list_flags ;;
        -h|--help) usage 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
    shift
done

# REQUIRED_USE equivalents
use X || use wayland || die "at least one of X / wayland must be enabled (--use X or --use wayland)"
if { use wayland || use wifi; } && ! use dbus; then
    die "wayland/wifi require dbus (--use dbus)"
fi
if ! use rozelynx; then
    _off=()
    for _f in chrome-web-store experiments external-browser i18n mouse-gestures \
              qr-code pwa lepton-skin ip-protection net-iface download-handoff \
              user-agent sync twofa pam-passkeys; do
        use "${_f}" && { USE["${_f}"]=0; _off+=("${_f}"); }
    done
    unset _f
    if (((${#_off[@]}))); then
        warn "rozelynx is off: forcing module flags off: ${_off[*]}"
    fi
    unset _off
fi

# src-root default: the directory containing this script. When this
# script lives at the root of the standalone rozelynx repo
# (github.com style layout), the patch tree sits under patches/ instead
# of next to the script - fall back to it so the build works from
# either layout without flags.
if [[ ${ROZELYNX_SRC_ROOT} == "${SELF_DIR}" \
      && ! -d ${SELF_DIR}/rozelynx \
      && -d ${SELF_DIR}/patches/rozelynx ]]; then
    ROZELYNX_SRC_ROOT="${SELF_DIR}/patches"
fi
SRC_ROOT="$(cd -- "${ROZELYNX_SRC_ROOT}" >/dev/null 2>&1 && pwd -P)"
[[ -d ${SRC_ROOT}/rozelynx && -d ${SRC_ROOT}/ui-patches ]] \
    || die "src root ${SRC_ROOT} does not look like the firefox-librewolf patch tree"

WORKDIR="${ROZELYNX_WORKDIR:-$PWD/rozelynx-distro-build}"
mkdir -p "${WORKDIR}"
WORKDIR="$(cd -- "${WORKDIR}" && pwd -P)"
DOWNLOADS="${WORKDIR}/downloads"
BUILD="${WORKDIR}/build"
OBJDIR="${WORKDIR}/objdir"
STAGE="${WORKDIR}/stage"
DIST="${WORKDIR}/dist"
MACH_STATE="${WORKDIR}/mach-state"
EXT_ID="rozelynx-features@bytewheel.org"
EXT_STAGE="${WORKDIR}/rozelynx-extension"
mkdir -p "${DOWNLOADS}" "${BUILD}" "${STAGE}" "${DIST}" "${MACH_STATE}"

ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64)  SNAP_ARCH=amd64 ;;
    aarch64) SNAP_ARCH=arm64 ;;
    *)       SNAP_ARCH="${ARCH}" ;;
esac
if [[ ${LIBDIR} == auto ]]; then
    LIBDIR=lib
    for _cand in lib64 lib; do
        [[ -d /usr/${_cand} ]] && { LIBDIR="${_cand}"; break; }
    done
fi
unset _cand
GNU_TRIPLET="${ARCH}-unknown-linux-gnu"

[[ -n ${FIREFOX_VERSION} ]] || die "FIREFOX_VERSION not set (edit ${VERSIONS_CONF} or pass --firefox VER)"
# The release version the browser reports and the artifacts are named
# with. Defaults to the Firefox base (plain upstream-aligned builds);
# rozelynx-only point releases bump it via rozelynx-distro-versions.conf
# (APP_VERSION) while the source pin above stays at the Firefox version.
APP_VERSION="${APP_VERSION:-${FIREFOX_VERSION}}"
MOZ_P="firefox-${FIREFOX_VERSION}"
FIREFOX_SRC_TARBALL="${MOZ_P}.source.tar.xz"
FIREFOX_SRC_URI="https://archive.mozilla.org/pub/firefox/releases/${FIREFOX_VERSION}/source/${FIREFOX_SRC_TARBALL}"
BUILD_SRC="${BUILD}/${MOZ_P}"

export MOZBUILD_STATE_PATH="${MACH_STATE}"
export CARGO_BUILD_JOBS="${JOBS}"
export MOZ_MAKE_FLAGS="-j${JOBS}"
export LC_ALL=C
# mirrors the ebuild's RUST_MIN_VER for the pinned Firefox version
: "${ROZELYNX_RUST_MIN_VER:=1.90.0}"
is_glibc || warn "non-glibc libc detected; the ebuild sets RUST_TARGET overrides for musl - this script assumes glibc"

# ---------------------------------------------------------------------------
# fetch helpers
# ---------------------------------------------------------------------------
fetch_url() {  # fetch_url URL DEST
    local url="$1" dest="$2"
    if [[ -s ${dest} ]]; then
        log "cached: $(basename "${dest}")"
        return 0
    fi
    [[ ${OFFLINE} == 1 ]] && die "offline mode: missing ${dest}"
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
        || die "need curl or wget to fetch ${url}"
    log "fetching ${url}"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 -o "${dest}.part" "${url}" && mv "${dest}.part" "${dest}" \
            || die "download failed: ${url}"
    else
        wget -O "${dest}.part" "${url}" && mv "${dest}.part" "${dest}" \
            || die "download failed: ${url}"
    fi
}

sha_check() {  # sha_check FILE sha512|sha256 VALUE
    local file="$1" algo="$2" want="$3" bin got
    [[ -n ${want} ]] || return 0
    case "${algo}" in
        sha512) bin=sha512sum ;;
        *)      bin=sha256sum ;;
    esac
    command -v "${bin}" >/dev/null 2>&1 || die "${bin} needed for checksum verification"
    got="$("${bin}" "${file}" | awk '{print $1}')"
    [[ "${got}" == "${want}" ]] || die "checksum mismatch for ${file}: got ${got}, want ${want}"
    log "checksum ok: $(basename "${file}")"
}

clone_ref() {  # clone_ref REPO REF DIR LABEL - shallow fetch of a tag, branch or commit SHA
    local repo="$1" ref="$2" dir="$3" label="$4"
    if [[ -d ${dir}/.git ]]; then
        log "  ${label} reference checkout: ${dir} @ $(git -C "${dir}" rev-parse --short=12 HEAD 2>/dev/null || echo "${ref}")"
        return 0
    fi
    log "cloning ${label} @ ${ref} (reference)"
    [[ ${OFFLINE} == 1 ]] && die "offline mode: cannot clone ${repo}"
    git init -q "${dir}"
    git -C "${dir}" remote add origin "${repo}"
    git -C "${dir}" fetch --depth 1 origin "${ref}" \
        || { rm -rf "${dir}"; die "git fetch of ${ref} from ${repo} failed - bad ${label} pin? (edit rozelynx-distro-versions.conf)"; }
    git -C "${dir}" checkout --detach FETCH_HEAD
}

# ---------------------------------------------------------------------------
# patch helpers (eapply / lw_apply_if_absent equivalents)
# ---------------------------------------------------------------------------
apply_one_patch() {  # apply_one_patch PATCHFILE [patch args...]
    local p="$1"; shift
    [[ -f ${p} ]] || die "patch not found: ${p}"
    patch --batch --no-backup-if-mismatch "$@" <"${p}" >/dev/null \
        || die "failed to apply ${p##*/}"
    log "  applied ${p##*/}"
}

lw_apply_if_absent() {  # skip when the change is already upstream
    local p="$1"
    if patch -p1 --dry-run -R -s <"${p}" >/dev/null 2>&1; then
        log "  ${p##*/} already applied upstream; skipping"
        return 0
    fi
    apply_one_patch "${p}" -p1
}

# ---------------------------------------------------------------------------
# stage: fetch
# ---------------------------------------------------------------------------
stage_fetch() {
    log "fetch stage"
    if [[ -n ${LIBREWOLF_REF} || -n ${FLOORP_REF} ]]; then
        need_cmd git "cloning the pinned reference checkouts"
    fi

    fetch_url "${FIREFOX_SRC_URI}" "${DOWNLOADS}/${FIREFOX_SRC_TARBALL}"
    sha_check "${DOWNLOADS}/${FIREFOX_SRC_TARBALL}" sha512 "${FIREFOX_SOURCE_SHA512}"

    if [[ -n ${GENTOO_PATCHSET} ]]; then
        fetch_url "${GENTOO_PATCHSET_BASE_URI}/${GENTOO_PATCHSET}" \
            "${DOWNLOADS}/${GENTOO_PATCHSET}"
        sha_check "${DOWNLOADS}/${GENTOO_PATCHSET}" sha512 "${GENTOO_PATCHSET_SHA512}"
    fi

    # LibreWolf source - pinned reference checkout.  The LibreWolf patches
    # applied below come from THIS overlay (vendored + rebased per Firefox
    # version); the upstream checkout is kept for reference, diffing and
    # rebasing sessions.  The pin is a commit SHA because upstream tags
    # lag their own releases (see rozelynx-distro-versions.conf).
    if [[ -n ${LIBREWOLF_REF} ]]; then
        clone_ref "${LIBREWOLF_REPO}" "${LIBREWOLF_REF}" \
            "${DOWNLOADS}/librewolf-source" "LibreWolf"
    fi

    # Floorp source - pinned REFERENCE ONLY.  Floorp features (PWA/SSB,
    # taskbar integration, ...) are already ported into the RozeLynx
    # extension + C++ code in this overlay; nothing from the Floorp tree
    # is applied as a patch.  Kept for reference when porting more.
    if [[ -n ${FLOORP_REF} ]]; then
        clone_ref "${FLOORP_REPO}" "${FLOORP_REF}" \
            "${DOWNLOADS}/floorp-source" "Floorp"
        log "  Floorp is reference-only - features are already ported; nothing from it is applied"
    fi
}

# ---------------------------------------------------------------------------
# stage: prepare
# ---------------------------------------------------------------------------
stage_prepare() {
    log "prepare stage"
    need_cmd tar "unpacking source"
    need_cmd patch "applying patches"
    need_cmd python3 "mach + extension assembly"
    command -v node >/dev/null 2>&1 || warn "node not found: the browser build may fail"
    command -v rustc >/dev/null 2>&1 || die "rustc not found (the ebuild pins RUST_MIN_VER, e.g. >= 1.90)"
    command -v magick >/dev/null 2>&1 \
        || die "magick (ImageMagick 7) is required to generate the RozeLynx branding - refusing to build an unbranded Firefox (same hard rule as the ebuild)"
    if ! command -v nasm >/dev/null 2>&1 && { [[ ${ARCH} == x86_64 ]] || [[ ${ARCH} == i686 ]]; }; then
        warn "nasm not found: some codec parts may fail"
    fi

    rm -rf "${BUILD_SRC}"
    log "unpacking ${FIREFOX_SRC_TARBALL}"
    tar -xJf "${DOWNLOADS}/${FIREFOX_SRC_TARBALL}" -C "${BUILD}"

    # Gentoo patchset first (same as eapply "${WORKDIR}/firefox-patches")
    if [[ -n ${GENTOO_PATCHSET} ]]; then
        local pdir="${WORKDIR}/firefox-patches"
        rm -rf "${pdir}"
        mkdir -p "${pdir}"
        tar -xJf "${DOWNLOADS}/${GENTOO_PATCHSET}" -C "${pdir}"
        # this script never enables LTO; glibc never needs the musl fixes
        find "${pdir}" -name '*-LTO-Only-enable-LTO-*.patch' -delete
        if is_glibc; then
            find "${pdir}" -name '*bgo-748849-RUST_TARGET_override.patch' -delete
            find "${pdir}" -name '*bgo-967694-musl-prctrl-exception-on-musl.patch' -delete
        fi
        local p
        while IFS= read -r -d '' p; do
            apply_one_patch "${p}" -d "${BUILD_SRC}" -p1
        done < <(find "${pdir}" -name '*.patch' -print0 | sort -z)
        # The patchset patches the vendored bindgen crate in place; cargo
        # verifies vendored files against .cargo-checksum.json at build
        # time and dies on the mismatch.  Same sed as the ebuild's
        # moz_clear_vendor_checksums bindgen.
        sed -i -e 's/\("files":{\)[^}]*/\1/' \
            "${BUILD_SRC}"/third_party/rust/bindgen/.cargo-checksum.json \
            || die "failed to clear bindgen cargo checksums"
        log "  cleared cargo checksums for the patched bindgen crate"
    fi

    # version-sensitive LibreWolf patch selection (same as src_prepare)
    local lw_ver=legacy
    if ver_ge "${FIREFOX_VERSION}" 155.0; then
        lw_ver=155
    elif ver_ge "${FIREFOX_VERSION}" 154.0; then
        lw_ver=154
    fi
    log "LibreWolf patch version selection: ${lw_ver}"

    cd "${BUILD_SRC}" || die "source tree missing: ${BUILD_SRC} (run the prepare stage first)"

    # toolchain fixes: GCC-16 libstdc++ no longer leaks the C math
    # functions into the global namespace in C++; upstream 156 has
    # unqualified calls.  Regular TUs get std::-qualified forms (the
    # siblings elsewhere are already qualified); the vendored pipewire
    # json-core.h is also included by the libwebrtc gn TUs, where glibc's
    # math.h macros precede libstdc++ cmath and would even rewrite the
    # token inside std::isnormal - so there the compiler builtins are
    # used directly, which work in both C and C++.
    apply_one_patch "${SRC_ROOT}/root-patches/media-capabilities-std-isfinite.patch" -p1
    apply_one_patch "${SRC_ROOT}/root-patches/webtransport-std-isnan.patch" -p1
    apply_one_patch "${SRC_ROOT}/root-patches/pipewire-json-math-builtins.patch" -p1

    local FILES="${SRC_ROOT}"

    # --- RozeLynx sequence (mirrors the rozelynx block of src_prepare) ---
    if use rozelynx; then
        log "RozeLynx: build configuration patch"
        apply_one_patch "${FILES}/rozelynx/mozconfig/rozelynx-configure.patch" -p1

        log "RozeLynx: about:sessionrestore newtab redesign"
        apply_one_patch "${SRC_ROOT}/root-patches/about-sessionrestore-newtab.patch" -p1

        log "RozeLynx: per-window prefers-color-scheme override"
        apply_one_patch "${SRC_ROOT}/root-patches/rozelynx-prefers-color-scheme-override.patch" -p1

        log "RozeLynx: browserAction update-transition fix"
        apply_one_patch "${FILES}/rozelynx/ext-browseraction-update-transition.patch" -p1

        log "RozeLynx: extension menus API (rozelynxQuery/Trigger)"
        apply_one_patch "${FILES}/rozelynx/dev/ext-menus-rozelynx.patch" -p1

        # MOZ_REQUIRE_SIGNING=false so distribution extensions can load
        # (the configure-patch imply_option alone is not enough - the
        # value is computed from the milestone in toolkit/moz.configure;
        # same story as the ebuild).
        local f
        while IFS= read -r f; do
            grep -q 'MOZ_REQUIRE_SIGNING' "${f}" || continue
            log "  forcing MOZ_REQUIRE_SIGNING=false in ${f#${BUILD_SRC}/}"
            sed -i \
                's/^\([[:space:]]*\)set_config("MOZ_REQUIRE_SIGNING",.*/\1set_config("MOZ_REQUIRE_SIGNING", False)/' \
                "${f}"
        done < <(find "${BUILD_SRC}"/toolkit "${BUILD_SRC}"/build "${BUILD_SRC}"/python/mozbuild \
                    -name 'moz.configure' 2>/dev/null)

        # --- full RozeLynx rebranding sweep (verbatim ebuild flow) ---
        log "RozeLynx: rebranding string sweep"
        grep -rl "Mozilla Firefox" browser/ toolkit/ 2>/dev/null | while IFS= read -r f; do
            [[ -f "${f}" ]] || continue
            sed -i -e 's/Mozilla Firefox/RozeLynx/g' -e 's/Mozilla/RozeLynx/g' "${f}" 2>/dev/null || true
        done || true
        find browser/branding browser/locales browser/components/newtab browser/components/preferences \
            \( -name '*.properties' -o -name '*.ftl' -o -name '*.json' \
               -o -name '*.html' -o -name '*.xhtml' -o -name '*.nsi' \
               -o -name 'configure.sh' \) \
            -exec sed -i \
                -e 's/"Firefox"/"RozeLynx"/g' \
                -e "s/'Firefox'/'RozeLynx'/g" \
                -e 's/Firefox Browser/RozeLynx Browser/g' \
                {} + 2>/dev/null || true
        find browser/branding -type f \
            \( -name '*.css' -o -name '*.html' -o -name '*.txt' -o -name '*.ini' \) \
            -exec sed -i \
                -e 's/Mozilla Firefox/RozeLynx/g' \
                -e 's/Mozilla/RozeLynx/g' \
                {} + 2>/dev/null || true

        local rozelynx_svg="${FILES}/rozelynx/icon/rozelynx.svg"

        # dedicated branding directory (unofficial -> rozelynx)
        log "RozeLynx: browser/branding/rozelynx"
        rm -rf browser/branding/rozelynx
        cp -a browser/branding/unofficial browser/branding/rozelynx
        sed -i \
            -e 's/^-brand-shorter-name = .*$/-brand-shorter-name = RozeLynx/' \
            -e 's/^-brand-short-name = .*$/-brand-short-name = RozeLynx/' \
            -e 's/^-brand-shortcut-name = .*$/-brand-shortcut-name = RozeLynx/' \
            -e 's/^-brand-full-name = .*$/-brand-full-name = RozeLynx/' \
            -e 's/^-brand-product-name = .*$/-brand-product-name = RozeLynx/' \
            -e 's/^-vendor-short-name = .*$/-vendor-short-name = ByteWheel/' \
            -e 's/^trademarkInfo = .*$/trademarkInfo = { "RozeLynx is a ByteWheel project" }/' \
            browser/branding/rozelynx/locales/en-US/brand.ftl
        sed -i \
            -e 's/^brandShorterName=.*$/brandShorterName=RozeLynx/' \
            -e 's/^brandShortName=.*$/brandShortName=RozeLynx/' \
            -e 's/^brandFullName=.*$/brandFullName=RozeLynx/' \
            browser/branding/rozelynx/locales/en-US/brand.properties
        sed -i \
            -e 's/^MOZ_APP_DISPLAYNAME=.*$/MOZ_APP_DISPLAYNAME=RozeLynx/' \
            -e 's/^MOZ_MACBUNDLE_ID=.*$/MOZ_MACBUNDLE_ID=rozelynx/' \
            browser/branding/rozelynx/configure.sh
        if [[ -f browser/branding/rozelynx/pref/firefox-branding.js ]]; then
            sed -i -e 's#https://nightly.mozilla.org#https://bytewheel.org/rozelynx#g' \
                browser/branding/rozelynx/pref/firefox-branding.js
        fi
        sed -i \
            -e 's/"Nightly"/"RozeLynx"/g' \
            -e 's/"Firefox Nightly"/"RozeLynx"/g' \
            browser/branding/rozelynx/branding.nsi 2>/dev/null || true

        # Firefox-branded SVGs -> RozeLynx logo
        find browser/components/newtab browser/components/firefoxview \
            \( -name 'firefox*.svg' -o -name 'fox*.svg' \) \
            -exec cp "${rozelynx_svg}" {} \; 2>/dev/null || true
        find browser/themes \
            \( -name 'firefox*.svg' -o -name 'fox*.svg' -o -name 'foxy*.svg' \
               -o -name 'avatar-fox*.svg' \) \
            -exec cp "${rozelynx_svg}" {} \; 2>/dev/null || true
        cp "${rozelynx_svg}" browser/themes/shared/privatebrowsing/favicon.svg 2>/dev/null || true
        cp "${rozelynx_svg}" browser/themes/shared/fxa/avatar-fox.svg 2>/dev/null || true
        cp "${rozelynx_svg}" browser/themes/shared/fxa/avatar-fox-circle.svg 2>/dev/null || true

        # Replace the default fallback favicon (tabs/urlbar/notifications
        # fallback: chrome://global/skin/icons/defaultFavicon.svg).
        #
        # The artwork is branding/favicon64.png - a RASTER. The slot is an SVG,
        # and a PNG cannot be dropped in its place: Gecko resolves the
        # -moz-context-properties/context-fill styling against the SVG root, and
        # a PNG there is simply not found. So the raster is embedded in a
        # hand-written SVG that keeps everything the slot is expected to have:
        # the same path, the same 16x16 viewBox, and BOTH pref-gated variants
        # (proton/nova, switched on browser.nova.enabled) so the new UI cannot
        # fall back to stock artwork.
        #
        # It is embedded rather than traced on purpose: tracing the 474x474 paw
        # up to vector invents curves that are not in the artwork, and this
        # slot is displayed at 16px where nobody can see the difference,
        # whereas the invented outline would be visible the moment anyone
        # scales it up.
        #
        # Falls back to the logo when the artwork is absent.
        local favicon64_png="${FILES}/rozelynx/branding/favicon64.png"
        if [[ -f "${favicon64_png}" && -n "$(command -v base64)" ]]; then
            local favicon64_b64
            favicon64_b64="$(base64 -w0 "${favicon64_png}")"
            cat > toolkit/themes/shared/icons/defaultFavicon.svg <<ROZELYNX_FAVICON || die "failed to write the default favicon"
<!-- RozeLynx: branding/favicon64.png embedded in the slot's SVG.
     Both variants are the same artwork; the stock file switches
     between proton and nova shapes on browser.nova.enabled, and
     keeping both means the new UI cannot fall back to stock. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16" width="16" height="16">
  <style>
    .nova { display: none; }
    @media -moz-pref("browser.nova.enabled") {
      .proton { display: none; }
      .nova { display: revert; }
    }
  </style>
  <g class="proton">
    <image x="0" y="0" width="16" height="16" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${favicon64_b64}"/>
  </g>
  <g class="nova">
    <image x="0" y="0" width="16" height="16" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${favicon64_b64}"/>
  </g>
</svg>
ROZELYNX_FAVICON
            log "    defaultFavicon.svg: branding/favicon64.png embedded (both proton/nova variants)"
        else
            warn "branding/favicon64.png absent; the fallback favicon stays the logo mark"
            cp "${rozelynx_svg}" toolkit/themes/shared/icons/defaultFavicon.svg \
                || die "failed to replace the default favicon with the logo mark"
        fi

        # Canvas background while the user overrides page colours
        # (Settings > Language and Appearance > Colors > "Override the
        # colours specified by the pages": Always). Gecko then sets
        # mUsePrefColors and ignores author colours, so every page paints
        # flat on the override background colour -- background IMAGES are
        # the one author declaration that survives, which is why the
        # override-colours work kept landing on images. The UA sheet paints
        # the shipped wallpaper on the canvas, so overridden pages read as
        # the RozeLynx cat-on-clouds scene instead of flat white.
        #
        # The gate is prefers-contrast: PreferenceSheet::Load leaves it
        # no-preference exactly while document colours are in use, and any
        # other value means the override is on (or the OS requests high
        # contrast, which also wants a calm background). Chrome documents
        # skip the override entirely (mIsChrome), so browser chrome and
        # about: pages are unaffected. The min-width guard keeps the
        # wallpaper out of small embedded frames.
        #
        # html.css is the toolkit UA sheet, so the rule reaches all web
        # content; the wallpaper itself is browser branding, resolved
        # through the global chrome registry from either jar.
        if [[ -f "${FILES}/rozelynx/branding/newtab-background.png" ]]; then
            cat >> layout/style/res/html.css <<'ROZELYNX_OVERRIDE_BG'

/* RozeLynx: branded canvas background while page colours
   are overridden (see the ebuild for the gating rationale). */
@media (prefers-contrast) and (min-width: 400px) {
  html {
    background-image: url("chrome://branding/content/newtab-background.png");
    background-size: cover;
    background-repeat: no-repeat;
    background-attachment: fixed;
  }
}
ROZELYNX_OVERRIDE_BG
            log "    override-colours canvas background appended to html.css"
        else
            warn "branding/newtab-background.png absent; overridden pages keep the flat override colour"
        fi

        # Private NEWTAB favicon: the claw, on about:newtab only.
        #
        # Scoped deliberately to about:newtab. A private window's other
        # icon-less tabs (bookmarks, sites with no favicon) must keep the
        # default mark -- the claw is a newtab signal, not a blanket "this
        # window is private" badge.
        #
        # about:newtab resolves to icon32.png in a private window too, so a
        # file swap cannot differ them; this has to be a CSS override in the
        # profile's userChrome.css (see the chrome-skin action). tabs.css
        # sets the tab icon with
        #     .tabbrowser-tab > .tab-content > .tab-icon-image { content: <icon> }
        # so the override re-points content: at the tab whose label is
        # about:newtab, and only inside a private window.
        local claw_png="${FILES}/rozelynx/branding/claw.png"
        local claw_svg="${FILES}/rozelynx/branding/privateNewtabFavicon.svg"
        if [[ ! -f "${claw_png}" || ! -f "${claw_svg}" ]]; then
            warn "branding/claw.png or privateNewtabFavicon.svg absent; private newtab keeps the paw"
        fi

        # URL-bar trust chip MODAL (the card that opens when the chip is
        # clicked). This is NOT the padlock on the chip itself. Three separate
        # sets of files are easy to confuse here; only the third is the modal:
        #
        #   trust-icon-{active,insecure}.svg   the small 16x16 padlock ON the chip
        #   breach-alert-shield-*.svg          the Nova-era modal graphic
        #   trustpanel-graphic-{enabled,warning,disabled}.svg   the legacy modal graphic
        #
        # controlcenter/panel.css selects the legacy one via a custom property keyed on
        # the popup's tracking-protection attribute:
        #   [tracking-protection="enabled"]  -> trustpanel-graphic-enabled.svg
        #   [tracking-protection="warning"]  -> trustpanel-graphic-warning.svg
        #   [tracking-protection="disabled"] -> trustpanel-graphic-disabled.svg
        # and renders it at #trustpanel-graphic-image-legacy (80x80). The padlock
        # (trust-icon-*) is deliberately left as stock artwork: replacing it is a
        # different change, and it is not what the modal uses.
        #
        # The stock trio is a context-fill mask (panel.css sets fill/stroke
        # properties and tints them per state). Embedding the raster drops that
        # tinting by design -- the artwork carries its own colours. The 80x80
        # slot geometry is kept to match its consumer, and the 94x89 source is
        # embedded at native size.
        local panel_enabled="${FILES}/rozelynx/branding/trustpanel-graphic-enabled.png"
        local panel_warning="${FILES}/rozelynx/branding/trustpanel-graphic-warning.png"
        local panel_disabled="${FILES}/rozelynx/branding/trustpanel-graphic-disabled.png"
        if [[ -f "${panel_enabled}" && -f "${panel_warning}" && -f "${panel_disabled}" ]]; then
            local panel_slot panel_src panel_b64
            for panel_slot in trustpanel-graphic-enabled trustpanel-graphic-warning trustpanel-graphic-disabled; do
                case ${panel_slot} in
                    trustpanel-graphic-enabled) panel_src="${panel_enabled}" ;;
                    trustpanel-graphic-warning) panel_src="${panel_warning}" ;;
                    *) panel_src="${panel_disabled}" ;;
                esac
                panel_b64="$(base64 -w0 "${panel_src}")" || die "failed to encode ${panel_src}"
                cat > "browser/themes/shared/identity-block/${panel_slot}.svg" <<ROZELYNX_PANEL || die "failed to write ${panel_slot}"
<!-- RozeLynx: branding/${panel_slot}.png embedded in the slot's SVG, replacing
     the stock shield for the matching tracking-protection state of the
     URL-bar trust panel. Context-fill tinting is intentionally dropped:
     the artwork carries its own colours. Slot geometry stays 100x100 to
     match #trustpanel-graphic-image-legacy. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
  <image x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${panel_b64}"/>
</svg>
ROZELYNX_PANEL
                log "    ${panel_slot}.svg: real raster artwork from branding/${panel_slot}.png"
            done
        else
            warn "branding/trustpanel-graphic-*.png absent; the trust panel keeps its stock shields"
        fi

        # --- branding rasters (magick is a hard requirement) ---
        local branding_src="${FILES}/rozelynx/branding"
        local branding_dir="browser/branding/rozelynx"
        log "RozeLynx: generating branding icons"

        rozelynx_install_vector_slot() {
            local slot="$1" dest="$2" svg_w="$3" svg_h="$4" embed_w="$5" src="$6"
            local embed_h="${7-}"
            local stem="${slot%.svg}"
            local real="${branding_src}/vector/${slot}"
            local real_png="${branding_src}/vector/${stem}.png"
            local raster="${src}" origin
            local fit_h extent_w extent_h
            if [[ -f "${real}" ]]; then
                cp "${real}" "${dest}" || die "failed to install vector branding ${slot}"
                log "    ${slot}: real vector artwork (branding/vector/${slot})"
                return 0
            fi
            if [[ -n "${embed_h}" ]]; then
                fit_h="${embed_h}"; extent_w="${embed_w}"; extent_h="${embed_h}"
            else
                fit_h="${svg_h}"; extent_w="${svg_w}"; extent_h="${svg_h}"
            fi
            if [[ -f "${real_png}" ]]; then
                raster="${real_png}"
                origin="real raster artwork (branding/vector/${stem}.png)"
            else
                origin="generated placeholder (no real artwork for this slot yet)"
            fi
            local b64
            b64="$(magick "${raster}" -resize "${embed_w}x${fit_h}" -background none \
                -gravity center -extent "${extent_w}x${extent_h}" -strip png:- | base64 -w0)" \
                || die "failed to rasterise ${slot}"
            [[ -n "${b64}" ]] || die "empty raster generated for ${slot}"
            cat >"${dest}" <<EOF || die "failed to write ${slot}"
<?xml version="1.0" encoding="UTF-8"?>
<!-- RozeLynx artwork slot ${slot}: ${extent_w}x${extent_h} raster in a ${svg_w}x${svg_h} SVG.
     Drop a real vector named ${slot} (or ${stem}.png) into the overlay
     branding/vector/ dir to replace this generated file. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svg_w}" height="${svg_h}" viewBox="0 0 ${svg_w} ${svg_h}">
  <image x="0" y="0" width="${svg_w}" height="${svg_h}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${b64}"/>
</svg>
EOF
            log "    ${slot}: ${origin}"
        }

        # Branding raster set: default{16,32,48,64,128}.png. Only these five
        # are packaged (content/jar.mn installs exactly icon16/32/48/64/128.png,
        # and branding-common.mozbuild installs the same five for gtk); the
        # stock default22/24/256.png are kept untouched - they belong to the
        # Windows msix tile set this Linux build never packages.
        #
        # default64.png is the one size the favicon64 artwork renders rather
        # than the line art the other four share: it is the correct source for
        # the 22/24/256 slots should packaging ever change, and it documents
        # the original intent of the window-icon ladder.
        #
        # NOTE: every one of these five is then overwritten by the paw.png
        # block immediately below, since the newtab tab icon resolves to the
        # same files. Last writer wins.
        #
        # Falls back to dark/no-text.png when the artwork is absent, so a
        # tree without it still builds the same icon set it built before.
        local size pf
        local favicon64_src="${branding_src}/favicon64.png"
        for size in 16 32 48 64 128; do
            local icon_src="${branding_src}/dark/no-text.png"
            if [ "${size}" = 64 ] && [ -f "${favicon64_src}" ]; then
                icon_src="${favicon64_src}"
            fi
            magick "${icon_src}" -background none \
                -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" \
                "${branding_dir}/default${size}.png" \
                || die "failed to generate ${size}px chrome icon"
        done

        # The newtab favicon (branding/paw.png) shares these very slots:
        # browser.js assigns about:newtab its icon from gPageIcons ->
        # "chrome://branding/content/icon32.png" -> ../default32.png, so the
        # same files carrying the window icon also carry the newtab tab icon.
        # There is no separate newtab icon file in the branding set.
        #
        # This MUST come after the loop above. Generating paw.png into these
        # paths earlier in the sequence did nothing at all: the loop overwrote
        # every one, which is why the bookmark mark changed but neither newtab
        # mark did. Applied last, paw is the final writer for these five slots.
        # Only the five packaged sizes are touched; 22/24/256 are not built on
        # this platform.
        local paw_src="${branding_src}/paw.png"
        if [ -f "${paw_src}" ]; then
            # paw.png is square (474x474), so "^" plus -extent is a no-op crop;
            # the treatment matches the surrounding calls either way.
            for size in 16 32 48 64 128; do
                magick "${paw_src}" -background none \
                    -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" \
                    "${branding_dir}/default${size}.png" \
                    || die "failed to generate ${size}px newtab favicon"
            done
            log "    newtab favicon: branding/paw.png -> default{16,32,48,64,128}.png"
        else
            warn "branding/paw.png absent; newtab favicon keeps the dark/no-text mark"
        fi
        cp "${rozelynx_svg}" "${branding_dir}/default.svg" || true

        # The LAUNCHER icon is separate artwork from the window icons above:
        # branding/launcher-square.png is the app's launcher mark, not the
        # line art the default* set shares. It gets its own name
        # (rozelynx-launcher) at install time rather than overwriting
        # rozelynx.png, because that name is also the notification-badge icon
        # and the badge is wanted as the logo.
        #
        # The source is launcher-square.png (475x475, 1:1). The earlier
        # launcher.png was 707x539 - landscape - and in a square slot the
        # centre-crop discarded about 24% of its width. The square artwork
        # removes that: both the resize and the extent are exact, so the
        # ladder is a downscale with no content discarded. The "^" geometry is
        # kept anyway so a non-square source dropped in later is still
        # centre-cropped rather than letterboxed - what every other slot in
        # this script does.
        #
        # Skipped, not fatal, when the artwork is absent: a tree without it
        # installs exactly what it installed before.
        local launcher_src="${branding_src}/launcher-square.png"
        if [[ -f "${launcher_src}" ]]; then
            for size in 16 24 32 48 64 128 256 512; do
                magick "${launcher_src}" -background none \
                    -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" \
                    "${branding_dir}/launcher${size}.png" \
                    || die "failed to generate ${size}px launcher icon"
            done
        else
            warn "branding/launcher-square.png absent; the launcher icon stays the logo mark"
        fi

        # About dialog + newtab/about logo rasters (192px). These three raster
        # slots drive about:newtab and about:*, and unlike every vector slot in
        # this script they had no drop-in: they were always regenerated from
        # main/no-text.png. That mattered because main/no-text.png is a
        # full-bleed OPAQUE scene (mean alpha 1.0), so the generated 192x192
        # PNG is an opaque pale square. The newtab draws it through CSS as a
        # 64px background-image, so a light content colour scheme leaves a
        # luma-0.75 square on a luma-1.0 background and the RozeLynx mark
        # reads as gone.
        #
        # Fixing that needs artwork with transparency and enough contrast to
        # read on both a light and a dark background - no CSS change can,
        # because an opaque background-image hides the page behind it. So
        # these slots accept a drop-in now, the same way the vector slots
        # always have:
        #   branding/vector/about-logo.png  -- the 1x and @2x and about.png art
        # A vector of the same name still wins for about-logo.svg, which is a
        # different destination. Until artwork is dropped in, the generated
        # placeholder is unchanged, so a tree without it installs what it did.
        mkdir -p "${branding_dir}/content"
        local logo_raster_dropin="${branding_src}/vector/about-logo.png"
        for pf in about.png about-logo.png about-logo@2x.png; do
            if [[ -f "${logo_raster_dropin}" ]]; then
                magick "${logo_raster_dropin}" -background none \
                    -resize 192x192^ -gravity center -extent 192x192 \
                    "${branding_dir}/content/${pf}" \
                    || die "failed to install ${logo_raster_dropin} as content/${pf}"
            else
                magick "${branding_src}/main/no-text.png" -background none \
                    -resize 192x192^ -gravity center -extent 192x192 \
                    "${branding_dir}/content/${pf}" \
                    || die "failed to generate ${branding_dir}/content/${pf}"
            fi
        done
        magick "${branding_src}/main/no-text.png" -background none \
            -resize 192x192^ -gravity center -extent 192x192 \
            "${branding_dir}/about.png" \
            || die "failed to generate about.png"

        # About:privatebrowsing (the logo beside the app title, above the
        # search bar). branding/private-browsing.png is artwork specific to
        # this slot.
        #
        # The slot is genuinely square - aboutPrivateBrowsing.css sets .logo to
        # var(--size-image-xxlarge) in BOTH axes - and the source is 707x459,
        # so the usual centre-crop keeps 459x459 and discards about 35% of the
        # width. That is by far the most aggressive crop of any slot here and
        # it is worth an eye: if detail near the left or right edge matters,
        # the source wants to be square (like branding/launcher-square.png
        # was). Falls back to the dark line art, as the other slots do.
        local private_src="${branding_src}/private-browsing.png"
        if [[ ! -f "${private_src}" ]]; then
            private_src="${branding_src}/dark/no-text.png"
            warn "branding/private-browsing.png absent; the private-browsing logo stays the line art"
        fi
        for pf in about-logo-private.png about-logo-private@2x.png; do
            magick "${private_src}" -background none \
                -resize 192x192^ -gravity center -extent 192x192 \
                "${branding_dir}/content/${pf}" \
                || die "failed to generate ${branding_dir}/content/${pf}"
        done

        # Newtab wallpaper. branding/newtab-background.png (the cat-on-clouds
        # scene WITHOUT the wordmark - branding/main/no-text.png; the wordmark
        # is a separate element beside the 96px logo, so the background must
        # not carry text) is the RozeLynx newtab background and had no way in:
        # the newtab paints
        #     body { background-image: var(--newtab-wallpaper, ""),
        #                        linear-gradient(to right, var(--newtab-wallpaper-color, ""), ...) }
        # and --newtab-wallpaper is assigned at RUNTIME from the Remote Settings
        # "newtab-wallpapers-v2" catalogue (activity-stream.bundle.js), so
        # there is no build-time slot that can populate it.
        #
        # So the body rule is rewritten directly, with the shipped art inlined
        # as a chrome:// URL. The wallpaper wins over the gradient when set, so
        # --newtab-wallpaper-color keeps working for users who pick a colour
        # with no wallpaper; only the image layer is replaced. The rule is
        # appended after upstream's body block so source order settles it,
        # with equal specificity (body) rather than !important.
        #
        # Override-colors is what made this visible: it forces
        # --newtab-background-color and the surrounding palette, which left a
        # flat colour where the RozeLynx art should be. Both stylesheets get it.
        local newtab_bg="${FILES}/rozelynx/branding/newtab-background.png"
        if [[ -f "${newtab_bg}" ]]; then
            cp "${newtab_bg}" "${branding_dir}/content/newtab-background.png" \
                || die "failed to install the newtab wallpaper"
            # jar.mn is a strict ALLOWLIST: a file that is not listed there is
            # silently dropped from browser.jar, with no warning. So dropping
            # art into branding/content/ is not enough -- it must be
            # registered, or chrome://branding/content/<name> 404s at runtime
            # while the CSS that references it looks perfectly correct. That
            # is exactly how the wallpaper and the tint logo both failed to
            # appear.
            local brand_jar="${branding_dir}/content/jar.mn"
            if [[ -f "${brand_jar}" ]]; then
                local bname
                for bname in newtab-background.png newtab-logo-tint.svg private-wallpaper.png; do
                    grep -q "content/branding/${bname}\$" "${brand_jar}" || \
                        printf '    content/branding/%s\n' "${bname}" >> "${brand_jar}" \
                        || die "failed to register ${bname} in ${brand_jar}"
                done
                log "    registered newtab assets in content/jar.mn"
            else
                die "branding jar.mn not found at ${brand_jar}"
            fi
            local bcss
            for bcss in browser/extensions/newtab/css/activity-stream.css \
                browser/extensions/newtab/css/nova/activity-stream.css
            do
                [[ -f "${bcss}" ]] || continue
            perl -0pi -e 's|(\nbody \{[^}]*?background-image: var\(--newtab-wallpaper[^}]*?\n\})|$1\n\n/* RozeLynx: shipped newtab wallpaper (branding/main/no-text.png: the\n   cat-on-clouds scene without the wordmark -- the wordmark is a separate\n   element beside the 96px logo, so the background carries no text). */\nbody {\n  background-image: url("chrome://branding/content/newtab-background.png");\n}|s' \
                "${bcss}" 2>/dev/null || true
            log "    newtab wallpaper: branding/main/no-text.png (${bcss##*/})"
            done
        else
            warn "branding/newtab-background.png absent; the newtab keeps its flat background"
        fi

        # Newtab logo tintability. This is a CSS change, not an art change.
        #
        # browser/extensions/newtab/css/activity-stream.css draws the newtab
        # logo as a background-image of a raster:
        #     .logo-and-wordmark .logo {
        #       background: image-set(url(".../about-logo.png"), ...);
        #     }
        # A background-image has no fill hook, so that mark cannot be
        # recoloured and carries whatever colour was baked into the PNG. The
        # wordmark beside it does not have this problem: it is an SVG with
        # -moz-context-properties: fill and fill: var(--newtab-wordmark-color).
        # So with Appearance's "Override colors" enabled, the page repaints,
        # the wordmark follows the theme, and the logo either clashes or
        # disappears against it -- while still being a full-colour raster.
        #
        # The fix is to route the logo through the same mechanism: a monochrome
        # silhouette SVG (branding/vector/newtab-logo-tint.svg, traced from the
        # alpha channel of dark-cropped-transparent.png) with fill="context-fill",
        # plus -moz-context-properties: fill on the rule so Gecko substitutes the
        # consumer's colour. Both the legacy and nova stylesheets get it.
        local tint_svg="${branding_src}/vector/newtab-logo-tint.svg"
        if [[ -f "${tint_svg}" ]]; then
            cp "${tint_svg}" "${branding_dir}/content/newtab-logo-tint.svg" \
                || die "failed to install the newtab tint logo"

            # Private NEWTAB favicon (the claw). Staged into the source tree
            # here, before the packaging step runs - a new source file has to
            # exist BEFORE packaging, and staging it at install time silently
            # produced nothing.
            #
            # themes/shared/jar.inc.mn is the allowlist that governs this
            # directory (browser/themes/linux/jar.mn pulls it in with
            # "#include ../shared/jar.inc.mn"). Registering the file in
            # linux/jar.mn instead does nothing: that file's % line maps
            # browser/themes/linux/ into the skin, and the ../shared/ entries
            # there are the exception, not the rule.
            local claw_svg_stage="${FILES}/rozelynx/branding/privateNewtabFavicon.svg"
            if [[ -f "${claw_svg_stage}" ]]; then
                # The claw becomes the about:privatebrowsing tab icon. This is
                # the slot that actually decides what a private window's
                # newtab shows: browser.js gPageIcons maps
                #     "about:privatebrowsing":
                #         "chrome://browser/skin/privatebrowsing/favicon.svg"
                # and a private window's newtab IS about:privatebrowsing, not
                # about:newtab. The generic logo copied over this slot earlier
                # in this function is what kept showing as the "old favicon".
                # Last writer wins, same as the paw/default*.png ordering.
                # The slot is registered upstream, so no jar.mn surgery is
                # needed and chrome://browser/skin/privatebrowsing/favicon.svg
                # resolves by construction.
                cp "${claw_svg_stage}" \
                    "browser/themes/shared/privatebrowsing/favicon.svg" \
                    || die "failed to install the claw as the private newtab favicon"

                # Still stage the identity-block copy too: the profile's
                # privateNewtabChrome.css rule (see the chrome-skin action)
                # historically pointed there, and the file is harmless to
                # ship. Registering it in shared/jar.inc.mn is the allowlist
                # that governs themes/shared (a file not listed there is
                # silently dropped, with no warning).
                cp "${claw_svg_stage}" \
                    "browser/themes/shared/identity-block/privateNewtabFavicon.svg" \
                    || die "failed to stage the private newtab favicon"
                local skin_inc="browser/themes/shared/jar.inc.mn"
                [[ -f "${skin_inc}" ]] \
                    || die "shared theme jar.inc.mn not found at ${skin_inc}"
                grep -q 'identity-block/privateNewtabFavicon.svg' "${skin_inc}" || \
                    printf '    skin/classic/browser/identity-block/privateNewtabFavicon.svg   (../shared/identity-block/privateNewtabFavicon.svg)\n' \
                    >> "${skin_inc}" \
                    || die "failed to register the private newtab favicon"
                log "    private newtab favicon: branding/claw.png -> privatebrowsing/favicon.svg"
            else
                warn "branding/privateNewtabFavicon.svg absent; private newtab keeps the paw mark"
            fi

        # Private newtab page (about:privatebrowsing) wallpaper + logo
        # removal. The pounce-through-the-thorns scene
        # (branding/private-background.png, the marketing pounce-thorns.jpg
        # converted to a -strip PNG at its native 1314x1197 - no resize:
        # the page CSS scales it cover, so committing fewer pixels would
        # just commit blur) becomes the page background, mirroring the
        # non-private newtab's cat-on-clouds wallpaper, and the
        # logo-and-wordmark row is removed outright: the 96px
        # about-private-browsing logo would sit as a mark stamped on the
        # scene, and the "RozeLynx" wordmark (firefox-wordmark.svg tinted
        # with currentColor -- purplish on the private page's dark
        # canvas) is stray text on top of it. Hiding the row (not just
        # its children) also takes the row's margin-bottom with it.
            local private_wallpaper="${branding_src}/private-background.png"
            if [[ -f "${private_wallpaper}" ]]; then
                cp "${private_wallpaper}" \
                    "${branding_dir}/content/private-wallpaper.png" \
                    || die "failed to install the private page wallpaper"
                local priv_css="browser/themes/shared/privatebrowsing/aboutPrivateBrowsing.css"
                [[ -f "${priv_css}" ]] \
                    || die "aboutPrivateBrowsing.css not found at ${priv_css}"
                cat >> "${priv_css}" <<'ROZELYNX_PRIVATE_PAGE'

/* RozeLynx: pounce-thorns as the page wallpaper; the
   logo-and-wordmark row is removed -- the branding
   reads from the wallpaper, not from a mark on top.
   cover scales the 1314x1197 source to the window
   without distortion, cropping the overflow rather
   than stretching it. The crop is CENTRED, unlike
   the non-private newtab's 0% 0% anchor: the
   scene's subject sits mid-frame, and on a wide
   window cover crops vertically -- the top-left
   anchor inherited from the cat art framed the
   upper part of the scene. Centring pans the
   viewing angle down to the subject. */
body {
  background-image: url("chrome://branding/content/private-wallpaper.png");
  background-size: cover;
  background-repeat: no-repeat;
  background-position: center;
  background-attachment: fixed;
}
.logo-and-wordmark {
  display: none;
}
ROZELYNX_PRIVATE_PAGE
                log "    private newtab page: private-background.png (pounce-thorns) wallpaper, logo row removed"
            else
                warn "branding/private-background.png absent; the private page keeps its flat background"
            fi
            local ncss
            for ncss in browser/extensions/newtab/css/activity-stream.css \
                browser/extensions/newtab/css/nova/activity-stream.css
            do
                [[ -f "${ncss}" ]] || continue
                # Point the rule at the tintable SVG. Matched on the full
                # upstream declaration including the trailing semicolon; the
                # image-set() and its @2x variant both disappear, because the
                # SVG scales itself.
                sed -i \
                    -e 's|background: image-set(url("chrome://branding/content/about-logo.png"), url("chrome://branding/content/about-logo@2x.png") 2x) no-repeat center;|background: url("chrome://branding/content/newtab-logo-tint.svg") no-repeat center;|' \
                    "${ncss}" 2>/dev/null || true
            # Append the context-properties declaration to the same rule. Done
            # with a targeted append rather than a rewrite so the surrounding
            # upstream block (display/size) is left untouched.
            perl -0pi -e 's|(\.logo-and-wordmark \.logo \{[^}]*?)\n\}|$1\n  -moz-context-properties: fill;\n  fill: var(--newtab-wordmark-color);\n}|s' \
                "${ncss}" 2>/dev/null || true
            # Size the pair to the private newtab's logo-and-wordmark
            # (aboutPrivateBrowsing.css: a var(--size-image-xxlarge) = 96px
            # logo and a 172x96 wordmark). The non-private logo had drifted:
            # upstream's 64px box got the full-bleed tint silhouette, which
            # reads far larger than the mark inside the private page's scene
            # art, and nova hid the wordmark entirely so the mark stood
            # alone. Matching the private page's numbers fixes both.
            #
            # Each substitution is scoped to a whole rule and anchored at
            # line start, so prefixed variants (.classic-enabled ...) keep
            # their selector, and only the size numbers inside the block
            # are rewritten. The classic small-screen variants are moved
            # with it so a narrow window does not fall back to the old pair.
            perl -0pi -e 's|^(\s*\.logo-and-wordmark \.logo \{)([^}]*?)(\})|my ($h,$b,$t)=($1,$2,$3); $b =~ s/\b64px\b/96px/g; "$h$b$t"|gem' \
                "${ncss}" 2>/dev/null || true
            perl -0pi -e 's|^(\s*\.classic-enabled \.logo-and-wordmark \.logo \{)([^}]*?)(\})|my ($h,$b,$t)=($1,$2,$3); $b =~ s/\b64px\b/96px/g; "$h$b$t"|gem' \
                "${ncss}" 2>/dev/null || true
            perl -0pi -e 's|^(\s*\.logo-and-wordmark \.wordmark \{)([^}]*?)(\})|my ($h,$b,$t)=($1,$2,$3); $b =~ s/\b105px\b/172px/g; $b =~ s/\b64px\b/96px/g; "$h$b$t"|gem' \
                "${ncss}" 2>/dev/null || true
            perl -0pi -e 's|^(\s*\.classic-enabled \.logo-and-wordmark \.wordmark \{)([^}]*?)(\})|my ($h,$b,$t)=($1,$2,$3); $b =~ s/\b100px\b/172px/g; $b =~ s/\b64px\b/96px/g; "$h$b$t"|gem' \
                "${ncss}" 2>/dev/null || true
            # The wordmark text is hidden in BOTH layouts: the wallpaper
            # carries the branding, and the "RozeLynx" wordmark
            # (firefox-wordmark.svg tinted with the theme colour) read as
            # stray purplish text on top of it. The nova variant is spelled
            # out because upstream shows the wordmark there inside wide
            # container queries, and a plain .wordmark rule would lose on
            # specificity to the .nova-enabled selectors.
            cat >> "${ncss}" <<'ROZELYNX_NEWTAB_WORDMARK'

/* RozeLynx: the wallpaper carries the branding; no wordmark
   text on top of it, in either layout. */
.logo-and-wordmark .wordmark,
.nova-enabled .logo-and-wordmark .wordmark {
  display: none;
}
ROZELYNX_NEWTAB_WORDMARK
            log "    newtab logo: 96px, wordmark text hidden (${ncss##*/})"
            done
        else
            warn "branding/vector/newtab-logo-tint.svg absent; the newtab logo stays a full-colour raster"
        fi

        # about-logo.svg is the vector slot that the initial profile
        # selector (about:profiles) draws, plus a few other chrome
        # surfaces. Copying the old rose SVG over it here is exactly why
        # the new artwork kept not appearing there, so this slot gets the
        # drop-in-or-placeholder treatment: the newest PNG art is
        # embedded until a real vector is dropped into branding/vector/.
        # embed width 960 gives 3x headroom over the largest consumer (the
        # 320x320 .logo that profile-selector-logo-size.patch introduces
        # below), so the slot is sharp at its new size instead of
        # upscaling a 192px embed. The slot canvas stays 512x512 to match
        # upstream.
        rozelynx_install_vector_slot about-logo.svg \
            "${branding_dir}/content/about-logo.svg" 512 512 960 \
            "${branding_src}/main/no-text.png" \
            || die "failed to install the about-logo.svg branding slot"
        # Grow the consumer to match: upstream sizes .logo at 64px, which
        # leaves a full illustration unreadable.
        apply_one_patch "${branding_src}/profile-selector-logo-size.patch" -p1
        # The unified-extensions panel's empty state (the toolbar
        # extensions button with nothing to list) takes its
        # illustration from CSS "content: url(...)" on the <img> in
        # customizableui/content/panelUI.inc.xhtml, picked by a class,
        # so there are two slots and both carried Fox art. The two
        # states are mutually exclusive, so the finished "lynx with
        # puzzle pieces" artwork goes in the empty state only, where its
        rozelynx_install_vector_slot extensions-panel-empty.svg \
            browser/themes/shared/addons/extensions-panel-empty.svg \
            177 132 354 "${branding_src}/main/no-text.png" 264 \
            || die "failed to install the extensions-panel-empty branding slot"
        rozelynx_install_vector_slot extensions-panel-empty-onboarding.svg \
            browser/themes/shared/addons/extensions-panel-empty-onboarding.svg \
            329 162 329 "${branding_src}/main/no-text.png" \
            || die "failed to install the extensions-panel-empty-onboarding branding slot"

        # The "Add-ons" heading icon in the about:addons sidebar
        # (categories-box.mjs sets it as the Extensions category's
        # iconsrc). Deliberately CONTAINED on its 20x20 canvas and padded
        # onto a transparent background rather than cropped: at 20px a
        # crop would cut the mark, where letterboxing keeps it whole.
        # The source is 341x283, so it letterboxes to 60x49 centred in
        # 60x60 (2x on a 20px icon).
        local addons_cat_src="${branding_src}/about-addons-category.png"
        if [[ -f "${addons_cat_src}" ]]; then
            rozelynx_install_vector_slot category-extensions.svg \
                toolkit/themes/shared/extensions/category-extensions.svg \
                20 20 60 \
                "${addons_cat_src}" 60 \
                || die "failed to install the about:addons sidebar icon"
        else
            warn "branding/about-addons-category.png absent; the about:addons sidebar icon stays stock"
        fi

        # The empty "no saved logins" state of about:logins (and of the
        # contextual-password-manager megalist, which shares the asset)
        # draws cpm-fox-illustration.svg. It lives in toolkit/, so neither
        # `find` in the rebranding block above can reach it and it needs
        # its own install line like the two panel illustrations. All
        # three consumers are "you have no passwords" empty states, so
        # one treasure-chest illustration is the right art for all of
        # them; 468x418 is 2x of the largest consumer.
        rozelynx_install_vector_slot cpm-fox-illustration.svg \
            toolkit/components/satchel/megalist/content/icons/cpm-fox-illustration.svg \
            204 182 468 "${branding_src}/dark/no-text.png" 418 \
            || die "failed to install the about:logins empty-state illustration"

        # assets/plus.svg is the new-profile card's background in
        # about:profiles (profile-card.css, and its only reference in the
        # tree). Upstream it is an 80x80 "currentColor" plus glyph drawn at
        # "background-size: 80px"; branding/vector/plus.png replaces it with
        # the finished "create a new profile" artwork and
        # new-profile-card-artwork.patch switches that card to the
        # "background-size: cover" its sibling cards already use, so the
        # illustration fills the 200x136 card instead of floating in it at
        # 80px. Losing the tint and the "+" affordance is deliberate: the
        # card's label ("Create a Profile") carries the affordance, and a
        # raster cannot inherit fill/stroke from -moz-context-properties.
        # Unlike every other slot, the intrinsic geometry here is NOT the
        # upstream 80x80: the file is only ever consumed as a CSS
        # background-image with background-size: cover, which discards the
        # intrinsic size and fills the card box, so the slot is declared at
        # the card's own 1.47 aspect and 2x (400x272) to stay sharp.
        rozelynx_install_vector_slot plus.svg \
            browser/components/profiles/content/assets/plus.svg \
            400 272 400 "${branding_src}/main/no-text.png" 272 \
            || die "failed to install the new-profile card illustration"

        apply_one_patch "${branding_src}/new-profile-card-artwork.patch" -p1
        cp "${FILES}/rozelynx/icon/rozelynx-wordmark.svg" \
            "${branding_dir}/content/about-wordmark.svg" || true
        cp "${FILES}/rozelynx/icon/rozelynx-wordmark.svg" \
            "${branding_dir}/content/firefox-wordmark.svg" || true
    fi

    # --- rozelynx-debug: neutralise RecommendedPreferences.applyPreferences ---
    if use rozelynx-debug && use rozelynx; then
        local dbg
        for dbg in \
            remote/cdp/CDP.sys.mjs \
            remote/components/Marionette.sys.mjs \
            remote/components/RemoteAgent.sys.mjs \
            remote/webdriver-bidi/WebDriverBiDi.sys.mjs \
        ; do
            [[ -f "${dbg}" ]] || continue
            sed -i \
                's/\(^\s*\)\(lazy\.RecommendedPreferences\.applyPreferences\)/\1\/\/\2/' \
                "${dbg}" || die "failed to patch ${dbg}"
        done
    fi

    # --- PWA Linux taskbar C++ component ---
    if use pwa && use rozelynx; then
        log "RozeLynx: PWA Linux taskbar C++ component"
        local pwa_src="${FILES}/rozelynx/cpp/pwa-linux-taskbar"
        mkdir -p browser/components/ssb/linux browser/modules/pwa
        cp "${pwa_src}/RozeLynxLinuxTaskbar.h" \
           "${pwa_src}/RozeLynxLinuxTaskbar.cpp" \
           "${pwa_src}/nsIRozeLynxLinuxTaskbar.idl" \
           "${pwa_src}/moz.build" \
           browser/components/ssb/linux/
        cp "${pwa_src}/SsbCommandLineHandler.sys.mjs" \
           "${pwa_src}/ExternalLinkCommandLineHandler.sys.mjs" \
           browser/modules/pwa/
        if [[ -f browser/modules/moz.build ]] && ! grep -q 'EXTRA_JS_MODULES.pwa' browser/modules/moz.build; then
            cat >> browser/modules/moz.build <<'PWAMODULES'
# RozeLynx PWA + external-link command-line handlers
EXTRA_JS_MODULES.pwa += [
    "pwa/ExternalLinkCommandLineHandler.sys.mjs",
    "pwa/SsbCommandLineHandler.sys.mjs",
]
PWAMODULES
        fi
        if [[ -f browser/components/moz.build ]] && ! grep -q 'ssb/linux' browser/components/moz.build; then
            cat >> browser/components/moz.build <<'PWAMOZ'
# RozeLynx PWA taskbar support
if CONFIG["MOZ_WIDGET_TOOLKIT"] == "gtk":
    DIRS += ["ssb/linux"]
XPCOM_MANIFESTS += ["ssb/components.conf"]
PWAMOZ
        fi
        cp "${pwa_src}/components.conf" browser/components/ssb/
    fi

    # --- net-iface: per-profile/container/tab interface pinning ---
    if use net-iface && use rozelynx; then
        log "RozeLynx: netiface C++ component + patches"
        local ni_src="${FILES}/rozelynx/cpp/net-iface"
        mkdir -p netwerk/base/rozelynx-netiface
        cp "${ni_src}/"*.cpp "${ni_src}/"*.h "${ni_src}/"*.idl \
           "${ni_src}/"*.conf "${ni_src}/moz.build" \
           netwerk/base/rozelynx-netiface/
        sed -i '/"url-classifier",/a\    "base/rozelynx-netiface",' netwerk/moz.build
        # Same version-conditional necko patch as the ebuild's src_prepare:
        # the plain net-iface-necko.patch carries the pre-157 hunks, the
        # -157/-158 follow-ups are the full self-contained rework rebased
        # per Firefox major (upstream signature drift: FromUnspecEntry
        # gained aFromStaleCache in 158).
        if ver_ge "${FIREFOX_VERSION}" 158.0; then
            apply_one_patch "${ni_src}/net-iface-necko-158.patch" -p1
        elif ver_ge "${FIREFOX_VERSION}" 157.0; then
            apply_one_patch "${ni_src}/net-iface-necko-157.patch" -p1
        else
            apply_one_patch "${ni_src}/net-iface-necko.patch" -p1
        fi
        # RozeLynx v14: WebRTC ICE follows the interface assignment
        # (SO_BINDTODEVICE on the mtransport sockets, bound STUN/TURN DNS,
        # socket-process tab-map replica, per-interface host candidates).
        apply_one_patch "${ni_src}/net-iface-webrtc.patch" -p1
        apply_one_patch "${ni_src}/net-iface-provider-host-native-fix.patch" -p1
        apply_one_patch "${ni_src}/net-iface-ext-dns.patch" -p1
        apply_one_patch "${ni_src}/net-iface-sessionrestore.patch" -p1
    fi

    # --- pam-passkeys: local WebAuthn platform authenticator (PAM: howdy
    # face authentication first, account password fallback) ---
    if use pam-passkeys && use rozelynx; then
        log "RozeLynx: PAM passkey platform authenticator (howdy + password)"
        local pp_src="${FILES}/rozelynx/cpp/webauthn-pam"
        mkdir -p dom/webauthn/rozelynx-pam
        cp "${pp_src}/"*.cpp "${pp_src}/"*.h "${pp_src}/moz.build" \
           dom/webauthn/rozelynx-pam/
        apply_one_patch "${pp_src}/webauthn-pam-service.patch" -p1
        apply_one_patch "${pp_src}/webauthn-pam-prompt-helper.patch" -p1
        apply_one_patch "${pp_src}/webauthn-pam-static-prefs.patch" -p1
    fi

    # --- download-handoff: browser-side hand-off engine (engine + gate +
    # Settings > General editor + ext: relay bridge) ---
    if use download-handoff && use rozelynx; then
        log "RozeLynx: download hand-off C++ component + exthandler hook"
        local dh_src="${FILES}/rozelynx/cpp/download-handoff"
        mkdir -p uriloader/exthandler/rozelynx-handoff
        cp "${dh_src}/"*.cpp "${dh_src}/"*.h "${dh_src}/"*.idl \
           "${dh_src}/"*.conf "${dh_src}/moz.build" \
           uriloader/exthandler/rozelynx-handoff/
        sed -i '/"exthandler",/a\    "exthandler/rozelynx-handoff",' \
            uriloader/moz.build
        # The interception point: nsExternalHelperAppService::OnStartRequest
        # asks the service BEFORE any save UI or temp file exists, and
        # only cancels when a handler ACCEPTS - a declined hand-off falls
        # through to the browser's own flow with nothing lost.
        apply_one_patch "${dh_src}/handoff-exthandler.patch" -p1
        # Settings > General > Download hand-off: the handler editor.
        # Same prefs, about:config stays the source of truth. The jar.mn
        # registration is a sed, not a patch hunk: the anchor line's
        # position differs between patch orders (the ebuild's environment
        # moves it), and a context-free insert after main.js is stable in
        # both.
        apply_one_patch "${dh_src}/handoff-prefs-general.patch" -p1
        cp "${dh_src}/rozelynx-handoff.js" \
           "${dh_src}/rozelynx-handoff.inc.xhtml" \
           browser/components/preferences/
        sed -i \
            -e '/content\/browser\/preferences\/main.js/a\   content/browser/preferences/rozelynx-handoff.js' \
            -e '/content\/browser\/preferences\/main.js/a\   content/browser/preferences/rozelynx-handoff.inc.xhtml' \
            browser/components/preferences/jar.mn
    fi

    # --- sync: rozelynxsync:// magic-link scheme handler ---
    if use sync && use rozelynx; then
        log "RozeLynx: sync magic-link scheme (rozelynxsync:)"
        local sy_src="${FILES}/rozelynx/cpp/sync-scheme"
        mkdir -p netwerk/base/rozelynx-sync
        cp "${sy_src}/"*.cpp "${sy_src}/"*.h "${sy_src}/"*.conf \
           "${sy_src}/moz.build" netwerk/base/rozelynx-sync/
        sed -i '/"url-classifier",/a\    "base/rozelynx-sync",' \
            netwerk/moz.build
    fi

    # --- LibreWolf-style privacy patches (vendored in this overlay) ---
    local LW="${SRC_ROOT}"
    local any_lw_patch=0

    if ! use telemetry && ! use rozelynx; then
        apply_one_patch "${LW}/disable-data-reporting-at-compile-time.patch" -p1
        any_lw_patch=1
    fi
    if use remove-safebrowsing; then
        apply_one_patch "${LW}/stop-undesired-requests.patch" -p1
        any_lw_patch=1
    fi
    if use remove-password-manager; then
        apply_one_patch "${LW}/hide-passwordmgr.patch" -p1
        any_lw_patch=1
    fi
    if use librewolf-ui; then
        apply_one_patch "${LW}/pref-pane-small.patch" -p1
        apply_one_patch "${LW}/librewolf-l10n.patch" -p1
        cp "${LW}/librewolf.js" browser/components/preferences/librewolf.js
        cp "${LW}/librewolf.inc.xhtml" browser/components/preferences/librewolf.inc.xhtml
        cp "${LW}/librewolf.css" browser/themes/shared/preferences/librewolf.css
        cp "${LW}/category-librewolf.svg" browser/themes/shared/preferences/category-librewolf.svg
        any_lw_patch=1
    fi
    use extension-firewall && { apply_one_patch "${LW}/rs-blocker.patch" -p1; any_lw_patch=1; }
    use remove-pingsender && { apply_one_patch "${LW}/remove-pingsender.patch" -p1; any_lw_patch=1; }
    if use remove-openai; then
        # 158: toolkit/content/license.html is gone (generated from the
        # LICENSES moz.build declarations now); remove-openai-158 swaps
        # the license.html hunk for the ml/moz.build LICENSED_UNDER one.
        if ver_ge "${FIREFOX_VERSION}" 158.0; then
            apply_one_patch "${LW}/remove-openai-158.patch" -p1
        else
            apply_one_patch "${LW}/remove-openai.patch" -p1
        fi
        any_lw_patch=1
    fi
    use webgl-permission && { apply_one_patch "${LW}/webgl-permission.patch" -p1; any_lw_patch=1; }
    if use fingerprint-fixes; then
        apply_one_patch "${LW}/fpp-canvas-fix.patch" -p1
        if [[ ${lw_ver} == legacy ]]; then
            apply_one_patch "${LW}/fix-canvas-extraction-permission.patch" -p1
        else
            log "  skipping fix-canvas-extraction-permission.patch (upstreamed in 154)"
        fi
        any_lw_patch=1
    fi
    if use autoconfig-enhanced; then
        apply_one_patch "${LW}/autoconfig-setEnv.patch" -p1
        apply_one_patch "${LW}/profile-directory.patch" -p1
        any_lw_patch=1
    fi
    if use remove-ads; then
        apply_one_patch "${LW}/ui-patches/remove-cfrprefs.patch" -p1
        apply_one_patch "${LW}/urlbarprovider-interventions.patch" -p1
        any_lw_patch=1
    fi
    # Sponsored suggestions (Firefox Suggest AMP) default ON for several
    # regions by a startup default-branch rewrite in QuickSuggest.sys.mjs
    # (SUGGEST_PREFS["suggest.quicksuggest.sponsored"].defaultValues), so the
    # librewolf.cfg pref alone loses the race and the flag needs the source
    # patch.  Two shapes: 157+ carries the EU-157 spread; 156 does not; below
    # 156 the table layout is unverified, so the patch is skipped (the cfg
    # lockPref still removes the ads there) rather than risk prepare.
    if use remove-sponsored; then
        if ver_ge "${FIREFOX_VERSION}" 158.0; then
            apply_one_patch "${LW}/remove-sponsored-158.patch" -p1
            any_lw_patch=1
        elif ver_ge "${FIREFOX_VERSION}" 156.0; then
            apply_one_patch "${LW}/remove-sponsored.patch" -p1
            any_lw_patch=1
        else
            warn "  remove-sponsored: no verified QuickSuggest patch shape below 156 - cfg lockPref only"
        fi
    fi
    if use privacy-ui; then
        apply_one_patch "${LW}/ui-patches/privacy-preferences.patch" -p1
        apply_one_patch "${LW}/ui-patches/hide-default-browser.patch" -p1
        lw_apply_if_absent "${LW}/ui-patches/hide-default-browser-alwayscheck.patch"
        if [[ ${lw_ver} == legacy ]]; then
            apply_one_patch "${LW}/ui-patches/hide-finish-setup-bookmark.patch" -p1
        else
            apply_one_patch "${LW}/ui-patches/hide-finish-setup-bookmark-154.patch" -p1
        fi
        apply_one_patch "${LW}/ui-patches/remove-organization-policy-banner.patch" -p1
        any_lw_patch=1
    fi
    if use translation-fullpage; then
        apply_one_patch "${LW}/fullpage-translations.patch" -p1
        if [[ ${lw_ver} == legacy ]]; then
            apply_one_patch "${LW}/fullpage-translations-utils-153.patch" -p1
        else
            apply_one_patch "${LW}/fullpage-translations-utils-154.patch" -p1
        fi
        apply_one_patch "${LW}/fullpage-translations-customization.patch" -p1
        apply_one_patch "${SRC_ROOT}/rozelynx/fullpage-translations-reliability.patch" -p1
        any_lw_patch=1
    fi
    use extension-uninstall-url && { apply_one_patch "${LW}/extensions-setUninstallURL.patch" -p1; any_lw_patch=1; }
    if use permission-tweaks; then
        apply_one_patch "${LW}/eme-permission.patch" -p1
        apply_one_patch "${LW}/lw-permissions.patch" -p1
        apply_one_patch "${LW}/ui-patches/allow_cookies_for_site.patch" -p1
        if [[ ${lw_ver} == legacy ]]; then
            apply_one_patch "${LW}/ui-patches/allow_cookies_for_site-trustpanel-153.patch" -p1
        else
            apply_one_patch "${LW}/ui-patches/allow_cookies_for_site-trustpanel-154.patch" -p1
        fi
        apply_one_patch "${LW}/limit-access.patch" -p1
        any_lw_patch=1
    fi
    if use ui-tweaks; then
        if [[ ${lw_ver} == legacy ]]; then
            apply_one_patch "${LW}/ui-patches/firefox-view.patch" -p1
        else
            log "  skipping firefox-view.patch (upstreamed in 154)"
        fi
        apply_one_patch "${LW}/ui-patches/handlers.patch" -p1
        # 158: net-error-card.mjs wrapped the img-container in an
        # ILLUSTRATION_ENABLED conditional - neterror-158 is rebased for it.
        if ver_ge "${FIREFOX_VERSION}" 158.0; then
            apply_one_patch "${LW}/ui-patches/neterror-158.patch" -p1
        else
            apply_one_patch "${LW}/ui-patches/neterror.patch" -p1
        fi
        apply_one_patch "${LW}/ui-patches/pref-naming.patch" -p1
        apply_one_patch "${LW}/ui-patches/home-preferences.patch" -p1
        apply_one_patch "${LW}/ui-patches/trustpanel.patch" -p1
        apply_one_patch "${LW}/ui-patches/website-appearance-ui-rfp.patch" -p1
        any_lw_patch=1
    fi
    use link-preview && { apply_one_patch "${LW}/link-preview.patch" -p1; any_lw_patch=1; }
    if use language-packs; then
        apply_one_patch "${LW}/languages.patch" -p1
        apply_one_patch "${LW}/remove-language-packs.patch" -p1
        any_lw_patch=1
    fi
    if use xdg-profile; then
        apply_one_patch "${LW}/xdg-dir.patch" -p1
        if [[ ${lw_ver} == legacy ]]; then
            apply_one_patch "${LW}/xdg-dir-153.patch" -p1
        else
            apply_one_patch "${LW}/xdg-dir-154.patch" -p1
        fi
        any_lw_patch=1
    fi
    use newtab-fixes && { apply_one_patch "${LW}/newtab-fix.patch" -p1; any_lw_patch=1; }

    [[ ${any_lw_patch} -eq 1 ]] && log "LibreWolf privacy patch set applied (any_lw_patch=${any_lw_patch})"

    # --- build-system seds (tail of src_prepare) ---
    log "build-system job-count seds"
    sed -i -e "s/multiprocessing.cpu_count()/${JOBS}/" \
        build/moz.configure/lto-pgo.configure 2>/dev/null || true
    sed -i -e "s/multiprocessing.cpu_count()/${JOBS}/" \
        third_party/chromium/build/toolchain/get_cpu_count.py 2>/dev/null || true
    sed -i -e "s/multiprocessing.cpu_count()/${JOBS}/" \
        third_party/python/gyp/pylib/gyp/input.py 2>/dev/null || true

    log "removing pre-built third-party objects"
    find third_party -type f \( -name '*.so' -o -name '*.o' \) -delete >/dev/null || true

    local _v
    for _v in glslopt encoding_rs; do
        local ck="third_party/rust/${_v}/.cargo-checksum.json"
        if [[ -f ${ck} ]]; then
            sed -i -e 's/\("files":{\)[^}]*/\1/' "${ck}"
        fi
    done

    # optional Mozilla API keys (enable safebrowsing/location services)
    [[ -n ${ROZELYNX_API_KEY_GOOGLE:-} ]] && printf '%s' "${ROZELYNX_API_KEY_GOOGLE}" > api-google.key
    [[ -n ${ROZELYNX_API_KEY_LOCATION:-} ]] && printf '%s' "${ROZELYNX_API_KEY_LOCATION}" > api-location.key
    [[ -n ${ROZELYNX_API_KEY_MOZILLA:-} ]] && printf '%s' "${ROZELYNX_API_KEY_MOZILLA}" > api-mozilla.key

    # rozelynx point release: the app version can be bumped past the pinned
    # Firefox base (APP_VERSION, e.g. 158.0.1 on firefox-158.0) for
    # rozelynx-only fixes. application.ini, the omnijar version bits and
    # every update check derive from these two files; the Gecko milestone
    # (config/milestone.txt) stays at the base version.
    if [[ ${APP_VERSION} != "${FIREFOX_VERSION}" ]]; then
        printf '%s\n' "${APP_VERSION}" > browser/config/version.txt
        printf '%s\n' "${APP_VERSION}" > browser/config/version_display.txt
        log "  rozelynx point release: app version ${APP_VERSION} on firefox ${FIREFOX_VERSION}"
    fi

    log "prepare complete: ${BUILD_SRC}"
}

# ---------------------------------------------------------------------------
# stage: configure
# ---------------------------------------------------------------------------
stage_configure() {
    log "configure stage"
    cd "${BUILD_SRC}" || die "source tree missing: ${BUILD_SRC} (run the prepare stage first)"

    # clang requested but missing -> fall back to gcc rather than die
    if use clang && ! command -v clang >/dev/null 2>&1; then
        warn "USE=clang is on but clang is not installed - falling back to the system compiler"
        USE[clang]=0
    fi
    # rust minimum (mirrors the ebuild's RUST_MIN_VER; override with
    # ROZELYNX_RUST_MIN_VER if the pinned Firefox needs something else)
    local _rustc_ver
    if ! command -v rustc >/dev/null 2>&1; then
        die "rustc not found (RozeLynx ${FIREFOX_VERSION} needs rustc >= ${ROZELYNX_RUST_MIN_VER})"
    fi
    _rustc_ver="$(rustc --version 2>/dev/null | awk '{print $2}')"
    ver_ge "${_rustc_ver}" "${ROZELYNX_RUST_MIN_VER}" \
        || die "rustc ${_rustc_ver} is too old: RozeLynx ${FIREFOX_VERSION} needs rustc >= ${ROZELYNX_RUST_MIN_VER} (override with ROZELYNX_RUST_MIN_VER if you know better)"
    if use clang; then
        export CC=clang CXX=clang++
        export AR=llvm-ar NM=llvm-nm RANLIB=llvm-ranlib
    fi

    local MC="${WORKDIR}/mozconfig"
    local ac_opts=()
    add_ac() { ac_opts+=("$@"); }

    add_ac "--enable-application=browser"
    add_ac "--enable-project=browser"
    add_ac "--allow-addon-sideload"
    add_ac "--disable-cargo-incremental"
    add_ac "--disable-crashreporter"
    add_ac "--disable-disk-remnant-avoidance"
    add_ac "--disable-geckodriver"
    add_ac "--disable-install-strip"
    add_ac "--disable-legacy-profile-creation"
    add_ac "--disable-parental-controls"
    add_ac "--disable-strip"
    add_ac "--disable-updater"
    add_ac "--enable-negotiateauth"
    add_ac "--enable-new-pass-manager"
    add_ac "--enable-packed-relative-relocs"
    add_ac "--enable-system-policies"
    add_ac "--host=${GNU_TRIPLET}"
    add_ac "--target=${GNU_TRIPLET}"
    add_ac "--prefix=${PREFIX}"
    add_ac "--libdir=${PREFIX}/${LIBDIR}"
    add_ac "--without-ccache"
    add_ac "--with-intl-api"
    add_ac "--with-system-ffi"
    add_ac "--with-system-gbm"
    add_ac "--with-system-libdrm"
    add_ac "--with-system-nspr"
    add_ac "--with-system-nss"
    add_ac "--with-system-pixman"
    add_ac "--with-system-zlib"
    add_ac "--with-unsigned-addon-scopes=app,system"

    if use rozelynx; then
        add_ac "--with-app-name=rozelynx"
        add_ac "--with-app-basename=rozelynx"
        add_ac "--with-branding=browser/branding/rozelynx"
        add_ac "--disable-official-branding"
        add_ac "--disable-release"
        add_ac "--enable-update-channel=rozelynx"
    fi

    use system-av1 && add_ac "--with-system-av1"
    use system-harfbuzz && add_ac "--with-system-harfbuzz"
    use system-icu && add_ac "--with-system-icu"
    use system-jpeg && add_ac "--with-system-jpeg"
    use system-libevent && add_ac "--with-system-libevent"
    use system-libvpx && add_ac "--with-system-libvpx"
    use system-pipewire && add_ac "--with-system-pipewire"
    use system-png && add_ac "--with-system-png"
    use system-webp && add_ac "--with-system-webp"
    if ! use wasm-sandbox; then
        add_ac "--without-wasm-sandboxed-libraries"
        use system-harfbuzz && add_ac "--with-system-graphite2"
    fi
    use jpegxl || add_ac "--disable-jxl"

    use dbus && add_ac "--enable-dbus"
    use libproxy && add_ac "--enable-libproxy"
    use valgrind && add_ac "--enable-valgrind"
    use wifi && add_ac "--enable-necko-wifi"

    case "${ARCH}" in
        x86_64|aarch64) add_ac "--enable-rust-simd" ;;
    esac
    if use valgrind; then
        add_ac "--disable-sandbox"
    else
        add_ac "--enable-sandbox"
    fi

    if use X && use wayland; then
        add_ac "--enable-default-toolkit=cairo-gtk3-x11-wayland"
    elif use wayland; then
        add_ac "--enable-default-toolkit=cairo-gtk3-wayland-only"
    else
        add_ac "--enable-default-toolkit=cairo-gtk3-x11-only"
    fi

    # audio backends (same composition logic as the ebuild)
    local backends=""
    use jack && backends+="jack,"
    use sndio && backends+="sndio,"
    use pulseaudio && backends+="pulseaudio,"
    use pulseaudio || backends+="alsa,"
    add_ac "--enable-audio-backends=${backends%,}"

    use jumbo-build || add_ac "--disable-unified-build"

    if use debug; then
        add_ac "--disable-optimize"
        add_ac "--enable-debug-symbols"
        add_ac "--enable-jemalloc"
        add_ac "--enable-real-time-tracing"
    else
        add_ac "--disable-real-time-tracing"
        add_ac "--disable-debug-symbols"
        add_ac "--enable-optimize=-O2"
    fi

    if use clang && command -v ld.lld >/dev/null 2>&1; then
        add_ac "--enable-linker=lld"
    elif ! use clang && command -v mold >/dev/null 2>&1; then
        add_ac "--enable-linker=mold"
    fi
    if use pgo; then
        warn "pgo: this script runs a plain ./mach build (no profile generation wired up) - continuing without PGO"
        add_ac "--disable-pgo"
    fi
    if [[ ${ARCH} == x86_64 || ${ARCH} == i686 ]]; then
        add_ac "--enable-elf-hack=relr"
    fi

    if use test; then
        add_ac "--enable-tests"
    else
        add_ac "--disable-tests"
    fi

    if [[ -s api-google.key ]]; then
        add_ac "--with-google-safebrowsing-api-keyfile=${BUILD_SRC}/api-google.key"
    fi
    if [[ -s api-location.key ]]; then
        add_ac "--with-google-location-service-api-keyfile=${BUILD_SRC}/api-location.key"
    fi
    if [[ -s api-mozilla.key ]]; then
        add_ac "--with-mozilla-api-keyfile=${BUILD_SRC}/api-mozilla.key"
    fi
    if command -v llvm-config >/dev/null 2>&1; then
        add_ac "--with-libclang-path=$(llvm-config --libdir)"
    fi

    # relocatable rpath: $ORIGIN works for system installs, AppImage,
    # Flatpak (/app) and snap ($SNAP) alike because the libs sit next to the
    # binary.  The $ORIGIN must be single-quoted: mach configure (156+)
    # shell-splits LDFLAGS with mozshellutil, which rejects unquoted
    # metacharacters (MetaCharacterException), and the build system's
    # make_quote(shell_quote()) pipeline re-quotes it correctly at link time.
    export LDFLAGS="${LDFLAGS:-} -Wl,-rpath,'\$ORIGIN' -Wl,--enable-new-dtags"

    {
        echo "mk_add_options MOZ_OBJDIR=${OBJDIR}"
        echo "ac_add_options XARGS=/usr/bin/xargs"
        local o
        for o in "${ac_opts[@]}"; do
            echo "ac_add_options ${o}"
        done
        if ! use telemetry; then
            echo "mk_add_options MOZ_CRASHREPORTER=0"
            echo "mk_add_options MOZ_DATA_REPORTING=0"
            echo "mk_add_options MOZ_SERVICES_HEALTHREPORT=0"
            echo "mk_add_options MOZ_TELEMETRY_REPORTING=0"
        fi
    } > "${MC}"

    echo
    echo "=========================================================="
    echo "RozeLynx ${FIREFOX_VERSION} mozconfig (${MC})"
    cat "${MC}"
    echo "=========================================================="
    echo

    export MOZCONFIG="${MC}"
    export MOZ_NOSPAM=1
    # default: let mach manage its own venv from the tree's pinned lockfiles;
    # set ROZELYNX_MACH_PYTHON=none to force the system python instead.
    if [[ -n ${ROZELYNX_MACH_PYTHON:-} ]]; then
        export MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE="${ROZELYNX_MACH_PYTHON}"
    fi
    ./mach configure || die "mach configure failed"
}

# ---------------------------------------------------------------------------
# stage: build
# ---------------------------------------------------------------------------
stage_build() {
    log "build stage"
    cd "${BUILD_SRC}" || die "source tree missing: ${BUILD_SRC} (run the prepare stage first)"
    export MOZCONFIG="${WORKDIR}/mozconfig"
    if ! use X; then
        export GDK_BACKEND=wayland
    fi
    ./mach build || die "mach build failed"
    log "build complete: ${OBJDIR}/dist/bin/rozelynx"
}

# ---------------------------------------------------------------------------
# stage: install (DESTDIR staging + src_install port)
# ---------------------------------------------------------------------------
render_launcher() {  # render_launcher TEMPLATE OUT PREFIX_EXPR LIBDIR WAYLAND
    local tmpl="$1" out="$2" prefix_expr="$3" libdir="$4" wayland="$5"
    sed \
        -e "s#^\(\(export \)\{0,1\}PREFIX=\).*#\1\"${prefix_expr}\"#" \
        -e "s#^\(\(export \)\{0,1\}DEFAULT_WAYLAND=\).*#\1\"${wayland}\"#" \
        -e "s#^\(MOZ_LAUNCHER=\).*#\1\"\${PREFIX}/${libdir}/rozelynx/rozelynx\"#" \
        -e "s#^\(\(export \)\{0,1\}ROZELYNX_VERSION=\).*#\1\"${APP_VERSION}\"#" \
        -e "s#^\(\(export \)\{0,1\}ROZELYNX_BUILD=\).*#\1\"$(date -u +%Y-%m-%d)\"#" \
        -e 's#^\(export \)\{0,1\}MOZ_USER_DIR=.*#export MOZ_USER_DIR="${MOZ_USER_DIR:-${HOME}/.config/rozelynx}"#' \
        "${tmpl}" > "${out}"
    chmod 0755 "${out}"
}

stage_install() {
    log "install stage"
    cd "${BUILD_SRC}" || die "source tree missing: ${BUILD_SRC} (run the prepare stage first)"
    export MOZCONFIG="${WORKDIR}/mozconfig"
    need_cmd zip "packaging the RozeLynx Features XPI"

    rm -rf "${STAGE}"
    mkdir -p "${STAGE}"

    log "mach install -> ${STAGE}"
    DESTDIR="${STAGE}" ./mach install || die "mach install failed"

    local FIVE="${STAGE}${PREFIX}/${LIBDIR}/rozelynx"
    [[ -d ${FIVE} ]] || die "mach install did not create ${FIVE} (mozconfig prefix mismatch?)"
    local PREFS_DIR="${FIVE}/browser/defaults/preferences"
    mkdir -p "${PREFS_DIR}"

    # rozelynx-bin -> rozelynx
    if [[ -f ${FIVE}/rozelynx-bin ]]; then
        rm -f "${FIVE}/rozelynx-bin"
        ln -s rozelynx "${FIVE}/rozelynx-bin"
    fi
    if [[ -f ${FIVE}/llvm-symbolizer ]]; then
        rm -f "${FIVE}/llvm-symbolizer"
    fi

    # distribution.ini (RozeLynx-flavoured, not Gentoo's)
    mkdir -p "${FIVE}/distribution"
    cat > "${FIVE}/distribution/distribution.ini" <<EOF
[Global]
id=rozelynx
version=${APP_VERSION}
about=RozeLynx Web Browser by ByteWheel

[Preferences]
app.distributor="bytewheel"
app.distributor.channel="rozelynx"
EOF

    log "installing RozeLynx system preferences"
    cp "${SRC_ROOT}/rozelynx/prefs/rozelynx-prefs.js" "${PREFS_DIR}/"

    # combined default prefs, per flag
    local DEFAULT_PREFS="${PREFS_DIR}/rozelynx-default-prefs.js"
    : > "${DEFAULT_PREFS}"
    if ! use telemetry; then
        cat >>"${DEFAULT_PREFS}" <<'EOF'
pref("toolkit.telemetry.unified", false);
pref("toolkit.telemetry.enabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("app.shield.optoutstudies.enabled", false);
pref("app.normandy.enabled", false);
pref("app.normandy.api_url", "");
EOF
    fi
    if ! use gmp-autoupdate; then
        cat >>"${DEFAULT_PREFS}" <<'EOF'
pref("media.gmp-gmpopenh264.autoupdate", false);
pref("media.gmp-widevinecdm.autoupdate", false);
EOF
    fi
    if use system-harfbuzz; then
        echo 'sticky_pref("gfx.font_rendering.graphite.enabled", true);' >>"${DEFAULT_PREFS}"
    fi
    if use hwaccel; then
        if use wayland; then
            echo 'pref("gfx.x11-egl.force-enabled", false);' >>"${DEFAULT_PREFS}"
        else
            echo 'pref("gfx.x11-egl.force-enabled", true);' >>"${DEFAULT_PREFS}"
        fi
        local _t
        for _t in vaapitest vulkantest; do
            if [[ -x ${OBJDIR}/dist/bin/${_t} ]]; then
                install -Dm0755 "${OBJDIR}/dist/bin/${_t}" "${FIVE}/${_t}"
            fi
        done
    fi
    if use remove-safebrowsing; then
        cat >>"${DEFAULT_PREFS}" <<'EOF'
pref("browser.safebrowsing.malware.enabled", false);
pref("browser.safebrowsing.phishing.enabled", false);
pref("browser.safebrowsing.downloads.enabled", false);
EOF
    fi
    if use remove-pocket; then
        cat >>"${DEFAULT_PREFS}" <<'EOF'
pref("extensions.pocket.enabled", false);
pref("extensions.pocket.api", "");
pref("extensions.pocket.site", "");
EOF
    fi
    if use remove-password-manager; then
        cat >>"${DEFAULT_PREFS}" <<'EOF'
pref("librewolf.hidePasswdmgr", true);
pref("signon.rememberSignons", false);
pref("signon.autofillForms", false);
pref("signon.generation.enabled", false);
EOF
    fi

    # LibreWolf autoconfig settings
    local any_lw=0 fl
    for fl in remove-safebrowsing remove-pocket remove-password-manager \
              remove-sponsored librewolf-ui extension-firewall remove-pingsender \
              remove-openai webgl-permission fingerprint-fixes autoconfig-enhanced \
              remove-ads privacy-ui translation-fullpage extension-uninstall-url \
              permission-tweaks ui-tweaks link-preview language-packs xdg-profile \
              newtab-fixes; do
        if use "${fl}"; then any_lw=1; fi
    done
    if [[ ${any_lw} -eq 1 ]]; then
        log "installing LibreWolf settings (librewolf.cfg + autoconfig)"
        mkdir -p "${FIVE}/defaults/pref"
        cp "${SRC_ROOT}/local-settings.js" "${FIVE}/defaults/pref/"
        cp "${SRC_ROOT}/librewolf.cfg" "${FIVE}/"
    fi
    if [[ ${any_lw} -eq 1 && ! -f ${FIVE}/distribution/policies.json ]]; then
        # policies.json carries the LibreWolf defaults + (below) the
        # force-installed RozeLynx Features extension registration
        cp "${SRC_ROOT}/policies.json" "${FIVE}/distribution/"
    fi

    # --- RozeLynx Features extension ---
    if use rozelynx; then
        log "assembling RozeLynx Features extension"
        local modules=()
        use chrome-web-store && modules+=(chrome-web-store)
        use experiments && modules+=(experiments)
        use external-browser && modules+=(external-browser)
        use i18n && modules+=(i18n)
        use mouse-gestures && modules+=(mouse-gestures)
        use qr-code && modules+=(qr-code)
        use pwa && modules+=(pwa external-link)
        use lepton-skin && modules+=(lepton-skin)
        use ip-protection && modules+=(ip-protection)
        use net-iface && modules+=(net-iface)
        # The download hand-off ENGINE is browser code now (Settings >
        # General, uriloader/exthandler/rozelynx-handoff/); the extension
        # carries only the ext:<id> relay that delivers download messages
        # to other extensions and keeps the installed-extensions probe
        # pref current.
        use download-handoff && modules+=(handoff-relay)
        use user-agent && modules+=(user-agent)
        use sync && modules+=(sync)
        log "  extension modules: ${modules[*]:-<none>}"

        if [[ ${#modules[@]} -gt 0 ]]; then
            rm -rf "${EXT_STAGE}"
            python3 "${SRC_ROOT}/rozelynx/extension/assemble-extension.py" \
                --extension-dir "${SRC_ROOT}/rozelynx/extension" \
                --output-dir "${EXT_STAGE}" \
                --enable "$(IFS=,; printf '%s' "${modules[*]}")" \
                || die "extension assembly failed"

            local ext_xpi="${WORKDIR}/${EXT_ID}.xpi"
            rm -f "${ext_xpi}"
            (cd "${EXT_STAGE}" && zip -qr "${ext_xpi}" .) || die "failed to create XPI"
            local ext_dir="${FIVE}/distribution/extensions"
            mkdir -p "${ext_dir}"
            rm -rf "${ext_dir}/${EXT_ID}"
            install -m0644 "${ext_xpi}" "${ext_dir}/${EXT_ID}.xpi"

            local pol="${FIVE}/distribution/policies.json"
            if [[ ! -f ${pol} ]]; then
                printf '{\n  "policies": {}\n}\n' > "${pol}"
            fi
            python3 - "${pol}" "${FIVE}/distribution/extensions/${EXT_ID}.xpi" <<'PYEOF'
import json, sys
pol_path, xpi_path = sys.argv[1], sys.argv[2]
with open(pol_path) as f:
    p = json.load(f)
es = p.setdefault("policies", {}).setdefault("ExtensionSettings", {})
es["rozelynx-features@bytewheel.org"] = {
    "installation_mode": "force_installed",
    "install_url": "file://" + xpi_path,
}
with open(pol_path, "w") as f:
    json.dump(p, f, indent=4)
PYEOF
            log "  registered ${EXT_ID} (force_installed) in policies.json"
        fi

        # --- RozeLynx 2FA: the separate two-factor extension ---
        # A whole extension of its own (TOTP/HOTP vault, otpauth:// capture,
        # page autofill), not a features-module: it owns secrets, its
        # storage is passphrase-encrypted, and it can be installed or
        # removed without touching the rest.
        if use twofa; then
            log "assembling RozeLynx 2FA extension"
            local TFA_ID="rozelynx-2fa@bytewheel.org"
            local tfa_stage="${WORKDIR}/rozelynx-2fa-extension"
            rm -rf "${tfa_stage}"
            cp -a "${SRC_ROOT}/rozelynx/extension-2fa" "${tfa_stage}"
            rm -rf "${tfa_stage}/README.md"
            local tfa_xpi="${WORKDIR}/${TFA_ID}.xpi"
            rm -f "${tfa_xpi}"
            (cd "${tfa_stage}" && zip -qr "${tfa_xpi}" .) || die "failed to create the 2FA XPI"
            local ext_dir="${FIVE}/distribution/extensions"
            mkdir -p "${ext_dir}"
            install -m0644 "${tfa_xpi}" "${ext_dir}/${TFA_ID}.xpi"

            local pol="${FIVE}/distribution/policies.json"
            if [[ ! -f ${pol} ]]; then
                printf '{\n  "policies": {}\n}\n' > "${pol}"
            fi
            python3 - "${pol}" "${FIVE}/distribution/extensions/${TFA_ID}.xpi" <<'PYEOF'
import json, sys
pol_path, xpi_path = sys.argv[1], sys.argv[2]
with open(pol_path) as f:
    p = json.load(f)
es = p.setdefault("policies", {}).setdefault("ExtensionSettings", {})
es["rozelynx-2fa@bytewheel.org"] = {
    "installation_mode": "force_installed",
    "install_url": "file://" + xpi_path,
}
with open(pol_path, "w") as f:
    json.dump(p, f, indent=4)
PYEOF
            log "  registered ${TFA_ID} (force_installed) in policies.json"
        fi

        # Lepton skin chrome CSS
        if use lepton-skin; then
            log "installing Lepton skin CSS"
            mkdir -p "${FIVE}/browser/defaults/rozelynx" \
                     "${FIVE}/browser/defaults/profile/chrome"
            cp "${SRC_ROOT}/rozelynx/skins/lepton/css/leptonChrome.css" \
               "${SRC_ROOT}/rozelynx/skins/lepton/css/rozelynxLepton.css" \
               "${FIVE}/browser/defaults/rozelynx/"
            cp "${SRC_ROOT}/rozelynx/skins/lepton/css/leptonChrome.css" \
               "${SRC_ROOT}/rozelynx/skins/lepton/css/rozelynxLepton.css" \
               "${FIVE}/browser/defaults/profile/chrome/"
            cat >"${FIVE}/browser/defaults/profile/chrome/userChrome.css" <<'EOF'
/* RozeLynx Lepton skin - default chrome for new profiles.
 * Enable on an existing profile:
 *   about:config -> toolkit.legacyUserProfileCustomizations.stylesheets = true
 *   cp this file + the imported sheets to <profile>/chrome/userChrome.css
 */
@import url("leptonChrome.css");
@import url("rozelynxLepton.css");
EOF
        fi

        # SSB (PWA) window chrome
        if use pwa; then
            mkdir -p "${FIVE}/browser/defaults/rozelynx" \
                     "${FIVE}/browser/defaults/profile/chrome"
            cp "${SRC_ROOT}/rozelynx/skins/ssb/ssbChrome.css" \
               "${FIVE}/browser/defaults/rozelynx/"
            cp "${SRC_ROOT}/rozelynx/skins/ssb/ssbChrome.css" \
               "${FIVE}/browser/defaults/profile/chrome/"
            local _uc="${FIVE}/browser/defaults/profile/chrome/userChrome.css"
            touch "${_uc}"
            grep -q 'ssbChrome.css' "${_uc}" || echo '@import url("ssbChrome.css");' >>"${_uc}"
        fi

        # Private-NEWTAB favicon rule (claw mark). Installed unconditionally
        # and imported from every seeded userChrome.css, alongside any SSB
        # import: a private tab should read as private whether or not any
        # skin is on.
        #
        # It cannot be shipped inside omni.ja: browser chrome CSS is only
        # read from the profile. It is installed into browser/defaults/rozelynx
        # (where the host's chrome-skin action finds it via SKIN_FILES) and
        # into the seeded default profile's chrome dir, importing by bare
        # filename. Only the claw artwork it references is a packaged skin
        # file hit by chrome:// URL.
        if [[ -f "${SRC_ROOT}/rozelynx/branding/privateNewtabChrome.css" ]]; then
            mkdir -p "${FIVE}/browser/defaults/rozelynx" \
                     "${FIVE}/browser/defaults/profile/chrome"
            cp "${SRC_ROOT}/rozelynx/branding/privateNewtabChrome.css" \
               "${FIVE}/browser/defaults/rozelynx/"
            cp "${SRC_ROOT}/rozelynx/branding/privateNewtabChrome.css" \
               "${FIVE}/browser/defaults/profile/chrome/"
            local _ucc="${FIVE}/browser/defaults/profile/chrome/userChrome.css"
            touch "${_ucc}"
            grep -q 'privateNewtabChrome.css' "${_ucc}" || \
                echo '@import url("privateNewtabChrome.css");' >>"${_ucc}"
            log "  private-NEWTAB favicon rule installed (claw)"
        else
            warn "branding/privateNewtabChrome.css absent; private newtab keeps the paw mark"
        fi

        # native messaging host + external launcher
        if use external-browser || use mouse-gestures; then
            log "installing RozeLynx native messaging host"
            install -m0755 "${SRC_ROOT}/rozelynx/host/rozelynx-host" \
                           "${SRC_ROOT}/rozelynx/host/open-external" \
                           "${FIVE}/"
            install -m0644 "${SRC_ROOT}/rozelynx/host/browsers.sh" "${FIVE}/"

            local nmh="${STAGE}${PREFIX}/${LIBDIR}/mozilla/native-messaging-hosts"
            mkdir -p "${nmh}"
            sed -e "s#@PATH@#${PREFIX}/${LIBDIR}/rozelynx/rozelynx-host#" \
                "${SRC_ROOT}/rozelynx/host/rozelynx.json" \
                > "${nmh}/rozelynx_host.json"
            if [[ ${LIBDIR} != lib ]]; then
                mkdir -p "${STAGE}${PREFIX}/lib/mozilla/native-messaging-hosts"
                cp "${nmh}/rozelynx_host.json" \
                   "${STAGE}${PREFIX}/lib/mozilla/native-messaging-hosts/"
            fi

            # x-scheme-handler/rozelynx-ext handler (rozelynx-default sorts
            # first in mimeinfo.cache -> GIO default)
            mkdir -p "${STAGE}${PREFIX}/share/applications"
            sed -e "s#@EXEC@#${PREFIX}/${LIBDIR}/rozelynx/open-external#" \
                -e 's#^Icon=.*#Icon=rozelynx#' \
                "${SRC_ROOT}/rozelynx/host/rozelynx-open-external.desktop" \
                > "${STAGE}${PREFIX}/share/applications/rozelynx-default.desktop"
        fi

        # --- icons ---
        log "installing icons"
        local icon_root="${BUILD_SRC}/browser/branding/rozelynx"
        if [[ ! -d ${icon_root} ]] \
           || [[ -z $(find "${icon_root}" -maxdepth 1 -name 'default*.png' 2>/dev/null) ]]; then
            warn "RozeLynx branding icons missing; falling back to official Firefox branding"
            icon_root="${BUILD_SRC}/browser/branding/official"
        fi
        local icon size icon_size dest
        while IFS= read -r -d '' icon; do
            size="${icon%.png}"
            size="${size##*/default}"
            dest="${STAGE}${PREFIX}/share/icons/hicolor/${size}x${size}/apps/rozelynx.png"
            mkdir -p "${dest%/*}"
            cp "${icon}" "${dest}"
        done < <(find "${icon_root}" -maxdepth 1 -name 'default*.png' -print0)

        # The launcher ladder, under its own name (rozelynx-launcher) so the
        # notification badge keeps rozelynx.png (the paw) as the logo. Any
        # size src_prepare did not render is skipped rather than fatal, and
        # the .desktop falls back per icon-theme rules.
        local launcher_icon
        while IFS= read -r -d '' launcher_icon; do
            size="${launcher_icon%.png}"
            size="${size##*/launcher}"
            dest="${STAGE}${PREFIX}/share/icons/hicolor/${size}x${size}/apps/rozelynx-launcher.png"
            mkdir -p "${dest%/*}"
            cp "${launcher_icon}" "${dest}"
        done < <(find "${icon_root}" -maxdepth 1 -name 'launcher*.png' -print0)

        mkdir -p "${STAGE}${PREFIX}/share/icons/hicolor/scalable/apps" \
                 "${STAGE}${PREFIX}/share/icons/hicolor/symbolic/apps"
        # The scalable theme icon (hicolor scalable/apps/rozelynx.svg) is what
        # the Icon=rozelynx theme name resolves to - the .desktop's own icon,
        # the notification badge fallback, and the PWA module's last-resort
        # Icon= for a site whose own icon could not be materialised. Copying
        # icon/rozelynx.svg (the old rose vector) there put the discontinued
        # logo on every one of those surfaces, which is exactly the mismatch
        # the PWA ladder exists to hide. So the scalable slot is GENERATED
        # from branding/paw.png (the same mark the PNG ladder carries),
        # base64-embedded the same way defaultFavicon.svg embeds favicon64:
        # no committed base64 blob, re-droppable at any resolution, and the
        # theme name and the PNG ladder can no longer disagree. icon/rozelynx
        # .svg stays what the in-chrome rebranding sweep copies (a separate,
        # still-open vector gap).
        local theme_png="${SRC_ROOT}/rozelynx/branding/paw.png"
        if [[ -f "${theme_png}" && -n "$(command -v base64)" ]]; then
            local theme_b64
            theme_b64="$(base64 -w0 "${theme_png}")"
            cat > "${STAGE}${PREFIX}/share/icons/hicolor/scalable/apps/rozelynx.svg" <<ROZELYNX_THEME_ICON || die "failed to write the scalable theme icon"
<!-- RozeLynx: branding/paw.png embedded as the hicolor scalable theme icon.
     The PNG ladder under hicolor/<n>x<n>/apps/rozelynx.png carries the same
     artwork, so every Icon=rozelynx consumer and every size agree. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="474" height="474" viewBox="0 0 474 474">
  <image x="0" y="0" width="474" height="474" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${theme_b64}"/>
</svg>
ROZELYNX_THEME_ICON
            log "    scalable theme icon: branding/paw.png -> scalable/apps/rozelynx.svg (replaces the old rose vector)"
        else
            warn "branding/paw.png absent; the scalable theme icon stays the old rose vector"
            cp "${SRC_ROOT}/rozelynx/icon/rozelynx.svg" \
               "${STAGE}${PREFIX}/share/icons/hicolor/scalable/apps/rozelynx.svg"
        fi
        cp "${SRC_ROOT}/rozelynx/icon/rozelynx-symbolic.svg" \
           "${STAGE}${PREFIX}/share/icons/hicolor/symbolic/apps/rozelynx-symbolic.svg"
        # the org.bytewheel.* alias the appimage flow re-uses
        ln -sf /usr/share/icons/hicolor/scalable/apps/rozelynx.svg \
            "${STAGE}${PREFIX}/share/icons/hicolor/symbolic/apps/org.bytewheel.rozelynx-symbolic.svg"

        # --- desktop file + launcher ---
        log "installing desktop file + launcher"
        mkdir -p "${STAGE}${PREFIX}/share/applications" "${STAGE}${PREFIX}/bin"
        # mach install leaves usr/bin/<app> as a symlink to the ABSOLUTE
        # /usr/<libdir>/rozelynx/rozelynx path; writing the real launcher
        # through it would escape the staging tree (and clobber a live
        # system file when running as root).  Remove it first.
        rm -f "${STAGE}${PREFIX}/bin/rozelynx"
        # The desktop entry's Icon= is the LAUNCHER mark
        # (rozelynx-launcher, the hicolor ladder rendered from
        # branding/launcher-square.png - the square re-cut of the marketing
        # launcher.png art), NOT the theme name rozelynx: that name is the
        # notification-badge icon and the PWA module's last-resort Icon=,
        # and its ladder carries the paw. One name per mark, so the app
        # launcher shows the launcher art while the badge stays the paw.
        sed -e 's#^Icon=.*#Icon=rozelynx-launcher#' \
            "${SRC_ROOT}/rozelynx/icon/rozelynx.desktop" \
            > "${STAGE}${PREFIX}/share/applications/rozelynx.desktop"
        if use sync; then
            # The OS half of the magic-link handoff: clicking a
            # rozelynxsync:// link in any other app launches RozeLynx with
            # it, the in-browser half (netwerk/base/rozelynx-sync/) hands
            # it to the extension's sync module. Registered only when the
            # scheme handler is compiled in.
            sed -i \
                -e 's#^MimeType=\(.*\)$#MimeType=\1x-scheme-handler/rozelynxsync;#' \
                "${STAGE}${PREFIX}/share/applications/rozelynx.desktop"
        fi
        render_launcher "${SRC_ROOT}/rozelynx/icon/rozelynx-r1.sh" \
            "${STAGE}${PREFIX}/bin/rozelynx" \
            "${PREFIX}" "${LIBDIR}" "${DEFAULT_WAYLAND}"
        if [[ ${SYMLINK_FIREFOX} == yes ]]; then
            ln -sf rozelynx "${STAGE}${PREFIX}/bin/firefox"
        fi
    fi

    # pam-passkeys: ship the PAM service example with the staged tree
    if use pam-passkeys && use rozelynx; then
        install -Dm0644 "${SRC_ROOT}/rozelynx/cpp/webauthn-pam/rozelynx.pam" \
            "${STAGE}${PREFIX}/share/doc/rozelynx/pam.d/rozelynx"
    fi

    # net-iface CAP_NET_RAW (xattrs survive tar --xattrs and snap pack)
    if use net-iface && [[ -x ${FIVE}/rozelynx ]]; then
        if [[ ${EUID} -eq 0 ]] && command -v setcap >/dev/null 2>&1; then
            setcap cap_net_raw+ep "${FIVE}/rozelynx" \
                && log "granted cap_net_raw to ${FIVE}/rozelynx" \
                || warn "setcap failed (staging filesystem may not support xattrs)"
        else
            warn "net-iface: run as root (or after install): setcap cap_net_raw+ep ${PREFIX}/${LIBDIR}/rozelynx/rozelynx"
        fi
    fi

    log "stage tree complete: ${STAGE} (${PREFIX}/${LIBDIR}/rozelynx)"
}

# ---------------------------------------------------------------------------
# stage: package
# ---------------------------------------------------------------------------
stage_package() {
    log "package stage"
    if [[ ${PKG_TARBALL} != yes && ${PKG_APPIMAGE} != yes \
          && ${PKG_FLATPAK} != yes && ${PKG_SNAP} != yes ]]; then
        warn "no package format selected (--tarball/--appimage/--flatpak/--snap)"
        return 0
    fi
    [[ -d ${STAGE}${PREFIX}/${LIBDIR}/rozelynx ]] \
        || die "staging tree missing - run the install stage first"

    if [[ ${PKG_TARBALL} == yes ]]; then
        local out="${DIST}/rozelynx-${APP_VERSION}-${ARCH}.tar.xz"
        log "packaging tarball: ${out}"
        (cd "${STAGE}" && tar --xattrs --xattrs-include='*.*' -cJf "${out}" usr) \
            || die "tarball packaging failed"
        log "  done: ${out}"
    fi

    if [[ ${PKG_APPIMAGE} == yes ]]; then
        pkg_appimage
    fi
    if [[ ${PKG_FLATPAK} == yes ]]; then
        pkg_flatpak
    fi
    if [[ ${PKG_SNAP} == yes ]]; then
        pkg_snap
    fi
}

pkg_appimage() {
    need_cmd magick "AppImage icon generation"
    local tool=""
    if command -v appimagetool >/dev/null 2>&1; then
        tool="appimagetool"
    else
        local dl="${DOWNLOADS}/appimagetool-${ARCH}.AppImage"
        fetch_url \
            "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_TAG}/appimagetool-${ARCH}.AppImage" \
            "${dl}"
        chmod +x "${dl}"
        tool="${dl}"
    fi

    local appdir="${WORKDIR}/appimage/AppDir"
    rm -rf "${appdir}"
    mkdir -p "${appdir}"
    log "packaging AppImage (AppDir: ${appdir})"

    cp -a "${STAGE}${PREFIX%/}/." "${appdir}/"

    # launcher resolves $APPDIR (exported by the AppImage runtime)
    sed -e 's#^\(\(export \)\{0,1\}PREFIX=\).*#\1"${APPDIR%/}/usr"#' \
        -e "s#^\(MOZ_LAUNCHER=\).*#\1\"\${PREFIX}/${LIBDIR}/rozelynx/rozelynx\"#" \
        -e 's#^\(export \)\{0,1\}MOZ_USER_DIR=.*#export MOZ_USER_DIR="${MOZ_USER_DIR:-${HOME}/.config/rozelynx}"#' \
        "${appdir}${PREFIX}/bin/rozelynx" > "${appdir}${PREFIX}/bin/rozelynx.tmp"
    mv "${appdir}${PREFIX}/bin/rozelynx.tmp" "${appdir}${PREFIX}/bin/rozelynx"
    chmod 0755 "${appdir}${PREFIX}/bin/rozelynx"

    cat >"${appdir}/AppRun" <<'EOF'
#!/bin/sh
# RozeLynx AppImage entry point
HERE="$(dirname "$(readlink -f "$0")")"
export APPDIR="${APPDIR:-$HERE}"
export PATH="${APPDIR}/usr/bin:${PATH}"
export MOZ_DBUS_REMOTE=1
exec "${APPDIR}/usr/bin/rozelynx" "$@"
EOF
    chmod 0755 "${appdir}/AppRun"

    cp "${appdir}${PREFIX}/share/applications/rozelynx.desktop" "${appdir}/rozelynx.desktop"
    cp "${appdir}${PREFIX}/share/icons/hicolor/scalable/apps/rozelynx.svg" "${appdir}/rozelynx.svg" 2>/dev/null || true
    magick "${BUILD_SRC}/browser/branding/rozelynx/default128.png" \
        -resize 256x256 "${appdir}/rozelynx.png" 2>/dev/null \
        || cp "${appdir}${PREFIX}/share/icons/hicolor/128x128/apps/rozelynx.png" "${appdir}/rozelynx.png"

    local out="${DIST}/RozeLynx-${APP_VERSION}-${ARCH}.AppImage"
    log "running appimagetool (${tool})"
    ARCH_APPIMAGE_EXTRACT_AND_RUN=1 "${tool}" "${appdir}" "${out}" \
        || die "appimagetool failed"
    log "  done: ${out}"
    if use net-iface; then
        warn "net-iface in an AppImage: squashfs mounts are nosuid - file capabilities do not apply; grant cap_net_raw to the extracted binary if you need interface pinning"
    fi
    if use pam-passkeys; then
        warn "pam-passkeys in an AppImage: /etc/pam.d of the host is reachable, but the bundled libpam stack may miss the howdy module - check with 'howdy test' on the host; USB security keys always work"
    fi
    return 0
}

pkg_flatpak() {
    need_cmd flatpak-builder "packaging flatpak"
    need_cmd flatpak "packaging flatpak"

    if ! flatpak info "${FLATPAK_SDK}//${FLATPAK_RUNTIME_VERSION}" >/dev/null 2>&1 \
       || ! flatpak info "${FLATPAK_RUNTIME}//${FLATPAK_RUNTIME_VERSION}" >/dev/null 2>&1; then
        warn "flatpak runtime/sdk not installed"
        warn "install first:  flatpak install flathub ${FLATPAK_SDK}//${FLATPAK_RUNTIME_VERSION} ${FLATPAK_RUNTIME}//${FLATPAK_RUNTIME_VERSION}"
        die "cannot build flatpak without the pinned runtime + sdk"
    fi

    local fbdir="${WORKDIR}/flatpak"
    local payload_root="${WORKDIR}/flatpak-payload"
    rm -rf "${fbdir}" "${payload_root}"
    mkdir -p "${fbdir}"
    log "packaging flatpak (app org.bytewheel.rozelynx, runtime ${FLATPAK_RUNTIME}//${FLATPAK_RUNTIME_VERSION})"

    # payload: staged usr tree re-rendered for /app
    cp -a "${STAGE}${PREFIX%/}/." "${payload_root}/"
    sed -e 's#^\(\(export \)\{0,1\}PREFIX=\).*#\1"/app"#' \
        -e "s#^\(MOZ_LAUNCHER=\).*#\1\"/app/${LIBDIR}/rozelynx/rozelynx\"#" \
        -e 's#^\(export \)\{0,1\}MOZ_USER_DIR=.*#export MOZ_USER_DIR="${MOZ_USER_DIR:-${HOME}/.config/rozelynx}"#' \
        "${payload_root}/bin/rozelynx" > "${payload_root}/bin/rozelynx.tmp"
    mv "${payload_root}/bin/rozelynx.tmp" "${payload_root}/bin/rozelynx"
    chmod 0755 "${payload_root}/bin/rozelynx"
    mv "${payload_root}/share/applications/rozelynx.desktop" \
       "${payload_root}/share/applications/org.bytewheel.rozelynx.desktop"
    local payload="${fbdir}/rozelynx-${APP_VERSION}-payload.tar.xz"
    (cd "${payload_root}" && tar -cJf "${payload}" .) || die "payload tar failed"

    # howdy face authentication (pam-passkeys) needs the camera
    local pam_extra_finish_args=""
    if use pam-passkeys; then
        pam_extra_finish_args=","$'\n'"    \"--device=all\""
        warn "pam-passkeys in a flatpak: --device=all grants the camera for howdy; the PAM stack is still the runtime's - face auth may be unavailable and only the password prompt works"
    fi

    cat >"${fbdir}/org.bytewheel.rozelynx.json" <<EOF
{
  "app-id": "org.bytewheel.rozelynx",
  "runtime": "${FLATPAK_RUNTIME}",
  "runtime-version": "${FLATPAK_RUNTIME_VERSION}",
  "sdk": "${FLATPAK_SDK}",
  "command": "rozelynx",
  "finish-args": [
    "--share=ipc",
    "--share=network",
    "--socket=wayland",
    "--socket=fallback-x11",
    "--socket=pulseaudio",
    "--device=dri",
    "--filesystem=xdg-download",
    "--talk-name=org.freedesktop.Notifications",
    "--talk-name=org.freedesktop.portal.*"${pam_extra_finish_args}
  ],
  "modules": [
    {
      "name": "rozelynx",
      "buildsystem": "simple",
      "sources": [
        {
          "type": "archive",
          "path": "${payload}",
          "dest": "payload"
        }
      ],
      "build-commands": [
        "cp -a payload/bin/. /app/bin/",
        "cp -a payload/${LIBDIR}/. /app/${LIBDIR}/",
        "cp -a payload/lib/mozilla/. /app/lib/mozilla/ || true",
        "cp -a payload/share/. /app/share/"
      ]
    }
  ]
}
EOF

    local repo="${fbdir}/repo"
    log "flatpak-builder"
    flatpak-builder --force-clean --repo="${repo}" \
        "${fbdir}/build" "${fbdir}/org.bytewheel.rozelynx.json" \
        || die "flatpak-builder failed"

    local out="${DIST}/RozeLynx-${APP_VERSION}.flatpak"
    log "flatpak build-bundle"
    flatpak build-bundle "${repo}" "${out}" org.bytewheel.rozelynx \
        || die "flatpak build-bundle failed"
    log "  done: ${out}"
    warn "flatpak: native messaging manifests are registered under the runtime /usr; the RozeLynx native messaging host may need the runtime's /usr/lib/mozilla path or a flatpak-specific registration"
}

pkg_snap() {
    need_cmd magick "snap icon generation"
    local primedir="${WORKDIR}/snap/prime"
    rm -rf "${WORKDIR}/snap"
    mkdir -p "${primedir}"
    log "packaging snap (base ${SNAP_BASE})"

    cp -a "${STAGE}${PREFIX%/}/." "${primedir}/"

    # launcher resolves $SNAP (exported by snapd at runtime)
    sed -e 's#^\(\(export \)\{0,1\}PREFIX=\).*#\1"${SNAP%/}/usr"#' \
        -e "s#^\(MOZ_LAUNCHER=\).*#\1\"\${PREFIX}/${LIBDIR}/rozelynx/rozelynx\"#" \
        -e 's#^\(export \)\{0,1\}MOZ_USER_DIR=.*#export MOZ_USER_DIR="${MOZ_USER_DIR:-${HOME}/.config/rozelynx}"#' \
        "${primedir}/usr/bin/rozelynx" > "${primedir}/usr/bin/rozelynx.tmp"
    mv "${primedir}/usr/bin/rozelynx.tmp" "${primedir}/usr/bin/rozelynx"
    chmod 0755 "${primedir}/usr/bin/rozelynx"

    mkdir -p "${primedir}/meta/gui/icons"
    cat >"${primedir}/meta/snap.yaml" <<EOF
name: rozelynx
version: "${APP_VERSION}"
summary: RozeLynx Web Browser
description: |
  RozeLynx: a Firefox-based browser by ByteWheel with Floorp-derived
  features and LibreWolf-style privacy hardening.  Built from pinned
  sources by the ByteWheel overlay distro-agnostic build script.
arch: ${SNAP_ARCH}
grade: stable
confinement: strict
base: ${SNAP_BASE}
apps:
  rozelynx:
    command: usr/bin/rozelynx
    desktop: meta/gui/rozelynx.desktop
    plugs:
      - desktop
      - desktop-legacy
      - x11
      - wayland
      - opengl
      - network
      - network-bind
      - network-observe
      - pulseaudio
      - audio-playback
      - removable-media
      - browser-support
      - upower-observe
EOF
    cp "${primedir}/usr/share/applications/rozelynx.desktop" \
       "${primedir}/meta/gui/rozelynx.desktop"
    magick "${primedir}/usr/share/icons/hicolor/128x128/apps/rozelynx.png" \
        -resize 256x256 "${primedir}/meta/gui/icons/rozelynx.png" 2>/dev/null \
        || cp "${primedir}/usr/share/icons/hicolor/128x128/apps/rozelynx.png" \
              "${primedir}/meta/gui/icons/rozelynx.png"

    local out="${DIST}/rozelynx_${APP_VERSION}_${SNAP_ARCH}.snap"
    if command -v snap >/dev/null 2>&1 && snap pack --help >/dev/null 2>&1; then
        log "snap pack"
        snap pack "${primedir}" "${DIST}" || die "snap pack failed"
    elif command -v mksquashfs >/dev/null 2>&1; then
        warn "snapd CLI unavailable; using mksquashfs fallback (file capabilities NOT preserved)"
        mksquashfs "${primedir}" "${out}" -noappend -comp xz -all-root \
            || die "mksquashfs failed"
    else
        die "neither 'snap pack' nor mksquashfs is available"
    fi
    if [[ ! -f ${out} ]]; then
        out="$(ls -1 "${DIST}"/rozelynx_*.snap 2>/dev/null | head -n 1 || true)"
    fi
    [[ -n ${out} ]] && log "  done: ${out}"
    if use net-iface; then
        warn "net-iface in a strict snap: file capabilities are dropped by the confinement stack; run the binary unconfined or grant CAP_NET_RAW via a snap layout/daemon"
    fi
    if use pam-passkeys; then
        warn "pam-passkeys in a strict snap: PAM service files and the howdy module live outside the sandbox - local passkeys will likely fail verification and fall back to USB security keys"
    fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    local s ran_install=0
    if [[ ${#STAGES[@]} -eq 0 ]]; then
        STAGES+=(fetch prepare configure build install)
    fi
    # `all` fills STAGES explicitly, so the package append used to live
    # inside the empty-STAGES branch above - where `all --tarball` never
    # reached it and the packaging flags were silently ignored: a full
    # build "succeeded" and left the previous dist/ tarball untouched.
    # Append package whenever a format was asked for, regardless of how
    # the stage list was built (the format checks stay inside the stage).
    if [[ ${PKG_TARBALL} == yes || ${PKG_APPIMAGE} == yes \
          || ${PKG_FLATPAK} == yes || ${PKG_SNAP} == yes ]]; then
        STAGES+=(package)
    fi
    for s in "${STAGES[@]}"; do
        case "$s" in
            fetch)    stage_fetch ;;
            prepare)  stage_prepare ;;
            configure) stage_configure ;;
            build)    stage_build ;;
            install)  stage_install; ran_install=1 ;;
            package)
                if [[ ${ran_install} -eq 0 ]]; then
                    warn "package without a fresh install in this run - staging may be stale"
                fi
                stage_package ;;
        esac
    done
    log "all requested stages complete"
}

main