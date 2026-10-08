#!/bin/bash
# make-srcinfo.sh - generate a package's .SRCINFO without makepkg.
#
# `makepkg --printsrcinfo` is the canonical generator, but this repo is
# developed on Gentoo, so this is a faithful reimplementation of it for
# single-package PKGBUILDs: same keys, same values, same file layout.
# (.SRCINFO parsing is key-based; attribute order is not significant.)
#
# usage: make-srcinfo.sh <dir containing PKGBUILD> [> <dir>/.SRCINFO]
#
# Does NOT run pkgver()/build()/package(): like makepkg --printsrcinfo,
# the literal pkgver/pkgrel from the PKGBUILD are what get printed.

set -euo pipefail

prog=${0##*/}

if (( $# != 1 )) || [[ ! -f $1/PKGBUILD ]]; then
    echo "usage: ${prog} <dir containing PKGBUILD>" >&2
    exit 64
fi

# the environment makepkg provides when sourcing a PKGBUILD
export CARCH=${CARCH:-$(uname -m)}
export srcdir=$(cd -- "$1" && pwd -P)

(
    cd "${srcdir}"

    # defaults for every attribute SRCINFO can carry, so the emitters can
    # test emptiness instead of dealing with unset variables; the PKGBUILD
    # assignment that follows each one overwrites it
    pkgbase= pkgdesc= pkgver= pkgrel= epoch= url= changelog= install=
    arch=() license=() groups=() makedepends=() checkdepends=() depends=()
    optdepends=() provides=() conflicts=() replaces=() backup=() options=()
    noextract=() source=() validpgpkeys=() md5sums=() sha1sums=()
    sha224sums=() sha256sums=() sha384sums=() sha512sums=() b2sums=()

    source ./PKGBUILD

    if [[ -z ${pkgname:-} ]]; then
        echo "${prog}: PKGBUILD sets no pkgname" >&2
        exit 1
    fi
    if [[ $(declare -p pkgname 2>/dev/null) == "declare -a"* ]] \
       && (( ${#pkgname[@]} > 1 )); then
        # per-package attributes come from package_*() overrides; this
        # helper does not run them
        echo "${prog}: split packages are not supported - use makepkg --printsrcinfo on an Arch box" >&2
        exit 1
    fi

    scalar() {  # scalar KEY VARNAME
        local key=$1 var=$2
        local v=${!var:-}
        if [[ -n ${v} ]]; then
            printf '\t%s = %s\n' "${key}" "${v}"
        fi
    }
    array() {   # array KEY VARNAME
        local key=$1 var=$2
        local -n ref=${var}
        local v
        if (( ${#ref[@]} )); then
            for v in "${ref[@]}"; do
                printf '\t%s = %s\n' "${key}" "${v}"
            done
        fi
    }
    details() {
        scalar pkgdesc pkgdesc
        scalar pkgver pkgver
        scalar pkgrel pkgrel
        scalar epoch epoch
        scalar url url
        scalar changelog changelog
        scalar install install
        array arch arch
        array license license
        array groups groups
        array makedepends makedepends
        array checkdepends checkdepends
        array depends depends
        array optdepends optdepends
        array provides provides
        array conflicts conflicts
        array replaces replaces
        array backup backup
        array options options
        array noextract noextract
        array source source
        array validpgpkeys validpgpkeys
        array md5sums md5sums
        array sha1sums sha1sums
        array sha224sums sha224sums
        array sha256sums sha256sums
        array sha384sums sha384sums
        array sha512sums sha512sums
        array b2sums b2sums
    }

    printf 'pkgbase = %s\n' "${pkgbase:-${pkgname}}"
    details
    printf '\n'
    printf 'pkgname = %s\n' "${pkgname}"
    printf '\n'
)