#!/bin/sh
# RozeLynx browser wrapper script
# Based on Gentoo's firefox-r1.sh

PREFIX="/usr"
DEFAULT_WAYLAND="true"

# Set RozeLynx-specific environment
export ROZELYNX_VERSION="155.0"
export ROZELYNX_BUILD="2026-09-13"

MOZ_LAUNCHER="${PREFIX}/lib64/rozelynx/rozelynx"


##
## Enable Wayland backend?
##
if [ "${DEFAULT_WAYLAND}" = "true" ] && [ -z "${MOZ_DISABLE_WAYLAND}" ]; then
  if [ -n "${WAYLAND_DISPLAY}" ]; then
    export MOZ_ENABLE_WAYLAND=1
  fi
fi

##
## Use D-Bus remote always. This is what lets a second instance hand its
## command line (and any --external-link* flags) over to an already-running
## instance, so external link clicks land as a new tab in the right profile
## instead of spawning a new window or the profile selector.
##
export MOZ_DBUS_REMOTE=1

# Use correct profile directory
# xdg-profile USE flag + Name=rozelynx means Firefox looks in
# ~/.config/rozelynx/. The ebuild postinst symlinks this to
# ~/.config/roselynx/ if the old profile directory exists.
# MOZ_USER_DIR override: only set if user explicitly wants a custom path.
if [ -n "${MOZ_USER_DIR}" ]; then
  export MOZ_USER_DIR
fi

##
## Session-bus bridge.
##
## /usr/lib64/rozelynx/rozelynx carries cap_net_raw=ep (netiface interface
## pinning), so the kernel sets AT_SECURE for every RozeLynx process and
## GLib deliberately refuses to honour DBUS_SESSION_BUS_ADDRESS for
## setuid-style processes (g_dbus_address_get_for_bus_sync). GLib still
## falls back to $XDG_RUNTIME_DIR/bus, so mirror the session socket there.
## dbus-run-session (and friends) put the socket under /tmp where GLib's
## fallback cannot find it; without this bridge the browser gets no session
## bus at all: no D-Bus remote name, no MPRIS/notifications/portals, and
## external-link handoff dies with "RozeLynx is already running".
##
rozelynx_bridge_session_bus() {
  local runtime_dir sock
  runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  [ -n "${runtime_dir}" ] || return 0
  case "${DBUS_SESSION_BUS_ADDRESS:-}" in
    unix:path=*) ;;
    *) return 0 ;;
  esac
  sock="${DBUS_SESSION_BUS_ADDRESS#unix:path=}"
  sock="${sock%%;*}"
  sock="${sock%%,*}"
  [ -n "${sock}" ] || return 0
  [ "${sock}" = "${runtime_dir}/bus" ] && return 0
  # A real user-bus socket already lives there: leave it alone.
  [ -e "${runtime_dir}/bus" ] && [ ! -L "${runtime_dir}/bus" ] && return 0
  ln -sfn "${sock}" "${runtime_dir}/bus" 2>/dev/null || true
}
rozelynx_bridge_session_bus

##
## External-link interception: when invoked as `rozelynx <url>` by another
## program (xdg-open, mail clients, ...), open the RozeLynx profile /
## network-interface chooser instead of starting a new instance. The chooser
## tab is placed in an already-running profile window when possible; the
## target profile decides via the built-in D-Bus remote handoff which
## instance receives the command line.
##
ROZELYNX_PROFILE_ROOT="${MOZ_USER_DIR:-${HOME}/.config/rozelynx}/bytewheel/rozelynx"

# A profile directory is "running" when its `lock` symlink (host:+PID)
# points at a live process.
rozelynx_is_profile_running() {
  local lock pid
  lock="${1}/lock"
  [ -L "${lock}" ] || return 1
  pid="$(readlink "${lock}")"
  pid="${pid##*:}"
  pid="${pid#+}"
  [ -n "${pid}" ] && [ -d "/proc/${pid}" ]
}

# Determine if the currently-running instance receives the command line via
# D-Bus remote, and if so, which profile directory it hosts.
rozelynx_intercept_external_link() {
  local url="$1"
  local default_dir target dir dirname

  # Scan profile directories for a running instance rather than requiring
  # profiles.ini. This handles setups with multiple profiles or custom layouts.
  target=""
  
  # Check default profile directory first
  if [ -d "${ROZELYNX_PROFILE_ROOT}" ]; then
    # Look for running profile in the root dir
    for dir in "${ROZELYNX_PROFILE_ROOT}"/*/; do
      [ -d "${dir}" ] || continue
      case "${dir}" in
        */Profile\ Groups/) continue ;;
      esac
      [ -f "${dir}/prefs.js" ] || continue
      if rozelynx_is_profile_running "${dir}"; then
        dirname="${dir%/}"
        target="${dirname##*/}"
        break
      fi
    done
  fi

  # If no running profile found, default to the first profile directory
  # that has a prefs.js (used as fallback for launching a new instance)
  [ -n "${target}" ] || {
    for dir in "${ROZELYNX_PROFILE_ROOT}"/*/; do
      [ -d "${dir}" ] || continue
      case "${dir}" in
        */Profile\ Groups/) continue ;;
      esac
      [ -f "${dir}/prefs.js" ] || continue
      target="${dir%/}"
      target="${target##*/}"
      break
    done
  }

  [ -n "${target}" ] || return 1

  # -profile <absdir> is used (rather than -P <name/path>) because it does
  # not require the target to be listed in profiles.ini — profiles created
  # by the Profile Manager live in the store only.
  exec "${MOZ_LAUNCHER}" "-profile" "${ROZELYNX_PROFILE_ROOT}/${target}" \
    "--external-link" "${url}"
}

# Intercept only a bare `http(s)://` / `ftp://` arg with no control flags.
# ROZELYNX_OPEN_PICKER=0 (set by the native host for internal launches)
# bypasses the chooser so handoffs never loop back here.
if [ "${ROZELYNX_OPEN_PICKER:-1}" = "1" ] && [ "$#" -eq 1 ]; then
  case "$1" in
    http://*|https://*|ftp://*) rozelynx_intercept_external_link "$1" ;;
  esac
fi

# Always pass --external-link so the command-line handler in the launched
# instance processes the URL as an external link (chooser or tab creation),
# even when no running profile was found and we launched a fresh instance.
export MOZ_USER_DIR="/home/burningserenity/.config/rozelynx"
exec "${MOZ_LAUNCHER}" "--external-link" "$@"
