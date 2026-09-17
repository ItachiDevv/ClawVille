#!/usr/bin/env bash
# Host-only operator installation. Never execute this script in tests or CI.
# Frozen spec: .claude/plans/doordash-cli-integration.md section 3.4.
# Does not run dd-cli or the vendor's install.sh.
set +x
set -euo pipefail
umask 077

die() { printf 'Error: %s\n' "$1" >&2; exit 1; }
usage() {
  printf 'Usage: %s --version 0.2.4 [--runtime-uid UID] [--runtime-gid GID]\n' "$0"
}

VERSION=''
# apps/api/Dockerfile does not override the base image's root runtime user.
# Set these arguments to the actual container ids if the deployment overrides it.
RUNTIME_UID=0
RUNTIME_GID=0
while (($#)); do
  case "$1" in
    --version|--runtime-uid|--runtime-gid)
      (($# >= 2)) || die "Missing value for $1"
      case "$1" in
        --version) VERSION=$2 ;;
        --runtime-uid) RUNTIME_UID=$2 ;;
        --runtime-gid) RUNTIME_GID=$2 ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument" ;;
  esac
done

# 1. Require root, the dedicated download credential, and an explicit version.
[[ $EUID -eq 0 ]] || die 'Run this script as root on the host.'
[[ -z ${CI:-} ]] || die 'This script must not run in CI.'
[[ -n ${DDCLI_GITHUB_TOKEN:-} ]] || die 'DDCLI_GITHUB_TOKEN is required.'
[[ -n $VERSION ]] || die '--version is required.'
[[ $RUNTIME_UID =~ ^[0-9]+$ && $RUNTIME_GID =~ ^[0-9]+$ ]] || die 'Runtime ids must be numeric.'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die 'The pinned bundle requires Linux x86_64.'

# SHA-256 of the original v0.2.4 release archive, verified against its downloaded
# .sha256 sidecar on itachi222, 2026-09-16. Never trust a fresh remote checksum
# instead of this reviewed pin; new versions require a reviewed script change.
case "$VERSION" in
  0.2.4) EXPECTED_SHA256='37eec0c72bcb663aaf9759ea098d49d9c02266bb895cbbfbadeae41866608dd4' ;;
  *) die 'No reviewed checksum exists for this version.' ;;
esac
for tool in gh sha256sum tar flock mktemp install mv ln chown chmod find; do
  command -v "$tool" >/dev/null || die "Required host tool is absent: $tool"
done

ROOT=/opt/ddcli
DEST="$ROOT/$VERSION"
BUNDLE="dd-cli-v$VERSION-linux-amd64"
[[ ! -L $ROOT ]] || die '/opt/ddcli must not be a symlink.'
install -d -o root -g root -m 0755 "$ROOT"
exec 9>"$ROOT/.install.lock"
flock -x 9
[[ ! -e $DEST && ! -L $DEST ]] || die 'The version directory already exists; use the documented rollback symlink instead.'
[[ ! -e $ROOT/current || -L $ROOT/current ]] || die 'The current path must be a symlink.'
[[ ! -L /var/lib/ddcli && ! -L /var/lib/ddcli/tmp ]] || die 'Runtime scratch paths must not be symlinks.'

WORK=$(mktemp -d "$ROOT/.install.XXXXXXXX")
cleanup() {
  # WORK is exclusively the mktemp directory under our fixed installation root.
  case "$WORK" in "$ROOT"/.install.*) rm -rf -- "$WORK" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$WORK/download" "$WORK/extract"

# 2. Scope the PAT to this gh invocation. Never change the gh keyring account.
GH_TOKEN="$DDCLI_GITHUB_TOKEN" gh release download "v$VERSION" \
  --repo doordash-oss/doordash-cli --pattern '*linux-amd64*' \
  --dir "$WORK/download"
unset DDCLI_GITHUB_TOKEN
ARCHIVE="$WORK/download/$BUNDLE.tar.gz"
[[ -f $ARCHIVE && ! -L $ARCHIVE ]] || die 'The expected release archive is absent.'

# 3. Check the pinned archive before inspecting or extracting its contents.
printf '%s  %s\n' "$EXPECTED_SHA256" "$ARCHIVE" | sha256sum --check --status \
  || die 'Archive checksum mismatch.'

# 4. Reject unsafe archive paths and entry types, then preserve the WHOLE bundle.
tar -tzf "$ARCHIVE" >"$WORK/members"
while IFS= read -r member; do
  member=${member%/}
  case "$member" in
    "$BUNDLE"|"$BUNDLE/"|"$BUNDLE/"*) ;;
    *) die 'Archive member is outside the expected bundle.' ;;
  esac
  case "/$member/" in
    *'/../'*|*'/./'*|*'//'*) die 'Archive contains an unsafe path.' ;;
  esac
done <"$WORK/members"
# The reviewed archive contains only regular files and directories, no links.
LC_ALL=C tar -tvzf "$ARCHIVE" >"$WORK/member-types"
while IFS= read -r member; do
  [[ ${member:0:1} == '-' || ${member:0:1} == d ]] || die 'Archive contains an unsupported entry type.'
done <"$WORK/member-types"
tar -xzf "$ARCHIVE" --no-same-owner --no-same-permissions -C "$WORK/extract"
TREE="$WORK/extract/$BUNDLE"
[[ -f $TREE/$BUNDLE && -d $TREE/_internal ]] || die 'The PyInstaller launcher or _internal directory is absent.'
mv -- "$TREE/$BUNDLE" "$TREE/dd-cli"

# 6. Harden before the step 5 flip, so current never exposes a writable tree.
chown -R root:root "$TREE"
find "$TREE" -type d -exec chmod 0755 {} +
find "$TREE" -type f -exec chmod 0644 {} +
chmod 0755 "$TREE/dd-cli"
chmod -R a-w "$TREE"
mv -T -- "$TREE" "$DEST"

# 7. HOME and its derived TMPDIR are private and writable by the runtime user.
install -d -o "$RUNTIME_UID" -g "$RUNTIME_GID" -m 0700 /var/lib/ddcli /var/lib/ddcli/tmp

# 5. Rename a new symlink on the same filesystem: current changes atomically.
ln -s "$DEST" "$WORK/current"
mv -Tf -- "$WORK/current" "$ROOT/current"

# 8. The mount maps current's CONTENTS to /opt/ddcli inside the container.
# Thus DD_CLI_BIN=/opt/ddcli/dd-cli has its adjacent _internal directory.
printf 'Installed dd-cli %s. No dd-cli command ran.\n' "$VERSION"
printf 'Add these exact Coolify persistent-storage mappings:\n'
printf '/opt/ddcli/current  ->  /opt/ddcli:ro\n'
printf '/var/lib/ddcli      ->  /var/lib/ddcli:rw\n'
printf 'Runtime scratch owner: %s:%s; mode: 0700.\n' "$RUNTIME_UID" "$RUNTIME_GID"
printf 'Restart the API container after each symlink flip so its bind mount resolves the new directory.\n'
