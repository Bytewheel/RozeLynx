#!/bin/bash
# publish-bin.sh - publish the rozelynx-bin AUR package end to end.
#
# Runs after `./rozelynx-distro-build.sh all --tarball` has produced
# dist/rozelynx-<ver>-<arch>.tar.xz (a multi-hour build). Steps:
#
#   1. pin pkgver + the tarball sha256 into arch/rozelynx-bin/PKGBUILD
#   2. regenerate arch/rozelynx-bin/.SRCINFO (arch/make-srcinfo.sh)
#   3. publish a v<ver> GitHub Release with the tarball asset (gh)
#   4. copy the package files into the AUR clone, commit, push
#
# usage: arch/publish-bin.sh <tarball> [aur-clone-dir]
#   tarball        the dist/ output to publish (or a path to one anywhere)
#   aur-clone-dir  an existing clone of ssh://aur@aur.archlinux.org/rozelynx-bin.git
#                  (default /storage/src/rozelynx-bin)
#
# Prerequisites:
#   * gh authenticated against github.com:  gh auth login
#   * push rights on the AUR: an SSH key registered at
#     https://aur.archlinux.org/ (passphrase prompts work; agent-only auth
#     needs the agent key to be registered - export SSH_AUTH_SOCK and, if
#     ~/.ssh/config pins a file key with IdentitiesOnly,
#     GIT_SSH_COMMAND="ssh -o IdentitiesOnly=no")
#
# The PKGBUILD stays sha256sums=('SKIP') + a TODO note until this script
# pins it; never push rozelynx-bin with a source URL that 404s.

set -euo pipefail

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(cd -- "${SELF_DIR}/.." && pwd -P)

die() { echo "publish-bin.sh: $*" >&2; exit 1; }
log()  { printf 'publish-bin.sh: %s\n' "$*"; }

if [[ $# -lt 1 || $# -gt 2 ]]; then
    die "usage: publish-bin.sh <tarball> [aur-clone-dir]"
fi
tarball=$1
aur_clone=${2:-/storage/src/rozelynx-bin}

command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) not found"
gh auth status >/dev/null 2>&1 || die "gh not authenticated - run: gh auth login"
[[ -f ${tarball} ]] || die "tarball not found: ${tarball} (build it first: ./rozelynx-distro-build.sh all --tarball)"
[[ -d ${aur_clone}/.git ]] || die "not an AUR git clone: ${aur_clone} (clone ssh://aur@aur.archlinux.org/rozelynx-bin.git)"

base=${tarball##*/}
if [[ ! ${base} =~ ^rozelynx-(.+)-(x86_64|aarch64)\.tar\.xz$ ]]; then
    die "not a dist tarball name: ${base} (want rozelynx-<ver>-<arch>.tar.xz)"
fi
ver=${BASH_REMATCH[1]}
arch=${BASH_REMATCH[2]}
export CARCH=${arch}
[[ $(uname -m) == "${arch}" ]] \
    || log "warning: tarball arch ${arch} != uname -m $(uname -m)"

sha=$(sha256sum "${tarball}" | awk '{print $1}')
log "tarball ${base}: sha256 ${sha}"

pkgbuild_dir="${REPO_ROOT}/arch/rozelynx-bin"

# 1. pin pkgver + sha256 into the repo PKGBUILD (drop the SKIP TODO note)
sed -i \
    -e "s/^pkgver=.*/pkgver=${ver}/" \
    -e "s/^sha256sums=.*/sha256sums=('${sha}')/" \
    -e "/# TODO: the release is not published yet/d" \
    "${pkgbuild_dir}/PKGBUILD"
log "pinned arch/rozelynx-bin/PKGBUILD: pkgver=${ver} sha256sums=${sha}"

# 2. regenerate .SRCINFO
"${SELF_DIR}/make-srcinfo.sh" "${pkgbuild_dir}" > "${pkgbuild_dir}/.SRCINFO"
log "regenerated arch/rozelynx-bin/.SRCINFO"

# 3. GitHub Release with the tarball asset
(
    cd "${REPO_ROOT}"
    gh release create "v${ver}" \
        --title "RozeLynx ${ver}" \
        --notes "RozeLynx ${ver} prebuilt tarball: a staged usr/ tree built
against glibc by rozelynx-distro-build.sh (Firefox ${ver} + the RozeLynx
patch set; see the repository README).

Note: this build enables the Wayland-only GTK toolkit (built on a
Wayland-only host). It needs a Wayland session; for X11/X11-only
setups, build from source via the rozelynx-git AUR package, which
defaults to the x11+wayland toolkit.

Install via the rozelynx-bin AUR package, or unpack as root:
    tar -xJf ${base} -C /
" \
        "${tarball}#rozelynx-${ver}-${arch}.tar.xz"
)
log "published GitHub release v${ver} with asset ${base}"

# 4. copy into the AUR clone, commit, push
for f in PKGBUILD .SRCINFO rozelynx-bin.install LICENSE; do
    cp "${pkgbuild_dir}/${f}" "${aur_clone}/${f}"
done
git -C "${aur_clone}" add PKGBUILD .SRCINFO rozelynx-bin.install LICENSE
git -C "${aur_clone}" commit -m "rozelynx-bin ${ver}-1: pin prebuilt release (sha256 ${sha:0:16}...)"
git -C "${aur_clone}" push
log "pushed rozelynx-bin to the AUR: https://aur.archlinux.org/packages/rozelynx-bin"