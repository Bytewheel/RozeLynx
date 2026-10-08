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
    download-handoff
)
DEFAULT_USE_ON=(
    rozelynx chrome-web-store experiments external-browser i18n mouse-gestures
    qr-code pwa lepton-skin ip-protection net-iface download-handoff
    remove-safebrowsing remove-pocket remove-password-manager remove-sponsored
    librewolf-ui extension-firewall remove-pingsender remove-openai
    webgl-permission fingerprint-fixes autoconfig-enhanced remove-ads
    privacy-ui translation-fullpage extension-uninstall-url permission-tweaks
    ui-tweaks link-preview xdg-profile newtab-fixes
    clang dbus hwaccel pulseaudio wayland X wifi
    system-av1 system-harfbuzz system-icu system-jpeg system-libevent
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
        --firefox)  FIREFOX_VERSION="${2:?}"; shift ;;
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
              qr-code pwa lepton-skin ip-protection net-iface download-handoff; do
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
        cp "${rozelynx_svg}" toolkit/themes/shared/icons/defaultFavicon.svg

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

        local size pf
        for size in 16 32 48 64 128; do
            magick "${branding_src}/dark/no-text.png" \
                -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" \
                "${branding_dir}/default${size}.png" \
                || die "failed to generate ${size}px chrome icon"
        done
        cp "${rozelynx_svg}" "${branding_dir}/default.svg" || true

        mkdir -p "${branding_dir}/content"
        for pf in about.png about-logo.png about-logo@2x.png; do
            magick "${branding_src}/main/no-text.png" \
                -resize 192x192^ -gravity center -extent 192x192 \
                "${branding_dir}/content/${pf}" \
                || die "failed to generate ${branding_dir}/content/${pf}"
        done
        magick "${branding_src}/main/no-text.png" \
            -resize 192x192^ -gravity center -extent 192x192 \
            "${branding_dir}/about.png" \
            || die "failed to generate about.png"
        for pf in about-logo-private.png about-logo-private@2x.png; do
            magick "${branding_src}/dark/no-text.png" \
                -resize 192x192^ -gravity center -extent 192x192 \
                "${branding_dir}/content/${pf}" \
                || die "failed to generate ${branding_dir}/content/${pf}"
        done

        rozelynx_install_vector_slot about-logo.svg \
            "${branding_dir}/content/about-logo.svg" 512 512 192 \
            "${branding_src}/main/no-text.png"
        rozelynx_install_vector_slot extensions-panel-empty.svg \
            browser/themes/shared/addons/extensions-panel-empty.svg \
            177 132 354 "${branding_src}/main/no-text.png" 264
        rozelynx_install_vector_slot extensions-panel-empty-onboarding.svg \
            browser/themes/shared/addons/extensions-panel-empty-onboarding.svg \
            329 162 329 "${branding_src}/main/no-text.png"
        rozelynx_install_vector_slot cpm-fox-illustration.svg \
            toolkit/components/satchel/megalist/content/icons/cpm-fox-illustration.svg \
            204 182 468 "${branding_src}/dark/no-text.png" 418
        rozelynx_install_vector_slot plus.svg \
            browser/components/profiles/content/assets/plus.svg \
            400 272 400 "${branding_src}/main/no-text.png" 272

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
        apply_one_patch "${ni_src}/net-iface-necko.patch" -p1
        apply_one_patch "${ni_src}/net-iface-provider-host-native-fix.patch" -p1
        apply_one_patch "${ni_src}/net-iface-ext-dns.patch" -p1
        apply_one_patch "${ni_src}/net-iface-sessionrestore.patch" -p1
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
    use remove-openai && { apply_one_patch "${LW}/remove-openai.patch" -p1; any_lw_patch=1; }
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
        apply_one_patch "${LW}/ui-patches/neterror.patch" -p1
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
    add_ac "--disable-wmf"
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
    use pulseaudio && backends+="pulse,"
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
    # Flatpak (/app) and snap ($SNAP) alike because the libs sit next to
    # the binary.
    export LDFLAGS="${LDFLAGS:-} -Wl,-rpath,\$ORIGIN -Wl,--enable-new-dtags"

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
        -e "s#^\(\(export \)\{0,1\}ROZELYNX_VERSION=\).*#\1\"${FIREFOX_VERSION}\"#" \
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
version=${FIREFOX_VERSION}
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
        use download-handoff && modules+=(download-handoff)
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
        mkdir -p "${STAGE}${PREFIX}/share/icons/hicolor/scalable/apps" \
                 "${STAGE}${PREFIX}/share/icons/hicolor/symbolic/apps"
        cp "${SRC_ROOT}/rozelynx/icon/rozelynx.svg" \
           "${STAGE}${PREFIX}/share/icons/hicolor/scalable/apps/rozelynx.svg"
        cp "${SRC_ROOT}/rozelynx/icon/rozelynx-symbolic.svg" \
           "${STAGE}${PREFIX}/share/icons/hicolor/symbolic/apps/rozelynx-symbolic.svg"

        # --- desktop file + launcher ---
        log "installing desktop file + launcher"
        mkdir -p "${STAGE}${PREFIX}/share/applications" "${STAGE}${PREFIX}/bin"
        sed -e 's#^Icon=.*#Icon=rozelynx#' \
            "${SRC_ROOT}/rozelynx/icon/rozelynx.desktop" \
            > "${STAGE}${PREFIX}/share/applications/rozelynx.desktop"
        render_launcher "${SRC_ROOT}/rozelynx/icon/rozelynx-r1.sh" \
            "${STAGE}${PREFIX}/bin/rozelynx" \
            "${PREFIX}" "${LIBDIR}" "${DEFAULT_WAYLAND}"
        if [[ ${SYMLINK_FIREFOX} == yes ]]; then
            ln -sf rozelynx "${STAGE}${PREFIX}/bin/firefox"
        fi
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
        local out="${DIST}/rozelynx-${FIREFOX_VERSION}-${ARCH}.tar.xz"
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

    local out="${DIST}/RozeLynx-${FIREFOX_VERSION}-${ARCH}.AppImage"
    log "running appimagetool (${tool})"
    ARCH_APPIMAGE_EXTRACT_AND_RUN=1 "${tool}" "${appdir}" "${out}" \
        || die "appimagetool failed"
    log "  done: ${out}"
    if use net-iface; then
        warn "net-iface in an AppImage: squashfs mounts are nosuid - file capabilities do not apply; grant cap_net_raw to the extracted binary if you need interface pinning"
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
    local payload="${fbdir}/rozelynx-${FIREFOX_VERSION}-payload.tar.xz"
    (cd "${payload_root}" && tar -cJf "${payload}" .) || die "payload tar failed"

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
    "--talk-name=org.freedesktop.portal.*"
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

    local out="${DIST}/RozeLynx-${FIREFOX_VERSION}.flatpak"
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
version: "${FIREFOX_VERSION}"
summary: RozeLynx Web Browser
description: |
  RozeLynx: a Firefox-based browser by ByteWheel with Floorp-derived
  features and LibreWolf-style privacy hardening.  Built from pinned
  sources by the hawksnest overlay distro-agnostic build script.
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

    local out="${DIST}/rozelynx_${FIREFOX_VERSION}_${SNAP_ARCH}.snap"
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
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    local s ran_install=0
    if [[ ${#STAGES[@]} -eq 0 ]]; then
        STAGES+=(fetch prepare configure build install)
        if [[ ${PKG_TARBALL} == yes || ${PKG_APPIMAGE} == yes \
              || ${PKG_FLATPAK} == yes || ${PKG_SNAP} == yes ]]; then
            STAGES+=(package)
        fi
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