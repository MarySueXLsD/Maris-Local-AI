#!/usr/bin/env bash
# Installs Maris on Linux with the right package for this computer:
#   Debian, Ubuntu, Mint, Pop!_OS and other apt systems (x64)  -> the .deb
#   Fedora, openSUSE, RHEL and other dnf/zypper systems (x64)  -> the .rpm
#   anything else, and ARM64 computers                        -> the AppImage, in ~/Applications
# The download is checked against the release's SHA256SUMS.txt before anything is installed.
#
#   curl -fsSL https://github.com/__REPO__/releases/latest/download/install-maris-linux.sh | bash
#
# scripts/release-files.cjs fills in the version and repository when it adds this file to a release.
# MARIS_INSTALL_DRY_RUN=1 only says what it would do.
set -euo pipefail

VERSION="__VERSION__"
REPO="__REPO__"
BASE="https://github.com/$REPO/releases/download/v$VERSION"
DRY="${MARIS_INSTALL_DRY_RUN:-}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Maris was not installed: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  Linux) ;;
  *) fail "this installer is for Linux. Get Maris for $(uname -s) from https://github.com/$REPO/releases/latest" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=ARM64 ;;
  *) fail "there is no Maris for $(uname -m) processors yet." ;;
esac

# deb and rpm packages exist for x64; ARM64 uses the AppImage.
kind=appimage
if [ "$arch" = x64 ]; then
  if has apt-get && has dpkg; then
    kind=deb
  elif has dnf || has zypper || has yum; then
    kind=rpm
  fi
fi

case "$kind" in
  deb) file="Maris-$VERSION-Linux-x64-Debian-Ubuntu.deb" ;;
  rpm) file="Maris-$VERSION-Linux-x64-Fedora-openSUSE.rpm" ;;
  *) file="Maris-$VERSION-Linux-$arch.AppImage" ;;
esac

say "Maris $VERSION for this computer: $file"
if [ -n "$DRY" ]; then
  say "(dry run: would download $BASE/$file, check it and install it as $kind)"
  exit 0
fi

has sha256sum || fail "sha256sum is missing (it is part of coreutils)."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fetch() {
  if has curl; then
    curl -fL --progress-bar -o "$2" "$1"
  elif has wget; then
    wget -q --show-progress -O "$2" "$1"
  else
    fail "curl or wget is needed to download Maris."
  fi
}

fetch "$BASE/$file" "$tmp/$file" || fail "could not download $file."
fetch "$BASE/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt" || fail "could not download the checksum list."
want="$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS.txt")"
got="$(sha256sum "$tmp/$file" | awk '{ print $1 }')"
[ -n "$want" ] && [ "$want" = "$got" ] || fail "the download does not match its SHA-256 in SHA256SUMS.txt."
say "Checked: the SHA-256 matches."

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

case "$kind" in
  deb)
    # apt reads the file as its own user; a copy it can read avoids a warning.
    chmod 644 "$tmp/$file"
    chmod 755 "$tmp"
    sudo_cmd apt-get install -y "$tmp/$file"
    say "Maris $VERSION is installed. Start it from your applications menu, or run: maris"
    ;;
  rpm)
    if has dnf; then
      sudo_cmd dnf install -y "$tmp/$file"
    elif has zypper; then
      sudo_cmd zypper --non-interactive install --allow-unsigned-rpm "$tmp/$file"
    else
      sudo_cmd yum install -y "$tmp/$file"
    fi
    say "Maris $VERSION is installed. Start it from your applications menu, or run: maris"
    ;;
  *)
    dest="$HOME/Applications"
    mkdir -p "$dest" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
    install -m 755 "$tmp/$file" "$dest/Maris.AppImage"
    fetch "https://raw.githubusercontent.com/$REPO/v$VERSION/resources/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/maris.png" || true
    cat >"$HOME/.local/share/applications/maris.desktop" <<DESKTOP
[Desktop Entry]
Name=Maris
Comment=Private local AI assistant
Exec="$dest/Maris.AppImage" %U
Icon=maris
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=Maris
DESKTOP
    has update-desktop-database && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    say "Maris $VERSION is installed in $dest/Maris.AppImage and in your applications menu."
    # AppImages need FUSE 2, which newer Ubuntu releases leave out.
    if ! (ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'); then
      say "If it does not start, install FUSE 2 first (Ubuntu and Debian: sudo apt install libfuse2t64, or libfuse2 on older releases)."
    fi
    ;;
esac
