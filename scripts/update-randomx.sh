#!/usr/bin/env bash
#
# Update the RandomX git subtree in deps/randomx.
#
#   scripts/update-randomx.sh [--check] [--no-verify] [REF]
#
#   REF          upstream branch, tag or full commit SHA (default: master)
#   --check      only report current vs. target and the upstream changes; exit 2 if an update exists
#   --no-verify  skip the build/test run before committing
#
# Verification happens in a temporary export (this repo's HEAD with deps/randomx replaced by REF),
# so neither the working tree nor build/Release is touched until everything has passed:
#   1. node-gyp build of the addon against REF
#   2. v1 hash vectors from the new build must equal the current build/Release (consensus check)
#   3. upstream randomx-tests (includes RandomX v2 and commitment vectors)
#   4. this repo's test suite (npm test: known-answer vectors for rx/0 + rx/2, seed pool, API)
# Only then is REF merged with `git subtree merge --squash`.
#
# Env: RANDOMX_UPSTREAM (default https://github.com/tevador/RandomX)

set -euo pipefail

UPSTREAM="${RANDOMX_UPSTREAM:-https://github.com/tevador/RandomX}"
PREFIX="deps/randomx"
# Oldest acceptable upstream commit: 7c761cf fixes wrong x86 JIT code for RandomX v2 shipped in v2.0.1.
MIN_COMMIT="7c761cf007c758056dcb6eb438a32f780f81bdbd"

CHECK_ONLY=0
VERIFY=1
REF="master"

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

for arg in "$@"; do
    case "$arg" in
        --check) CHECK_ONLY=1 ;;
        --no-verify) VERIFY=0 ;;
        -h|--help) usage 0 ;;
        -*) echo "Unknown option: $arg" >&2; usage 1 ;;
        *) REF="$arg" ;;
    esac
done

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

cd "$(git rev-parse --show-toplevel)"
[ -f binding.gyp ] && [ -d "$PREFIX" ] || die "run this inside the randomx-hashing repository"

current="$(git log -1 --grep="^git-subtree-dir: $PREFIX\$" --format=%B | sed -n 's/^git-subtree-split: //p')"
[ -n "$current" ] || die "no git-subtree-split found for $PREFIX (was it added with git subtree --squash?)"

if [ "$CHECK_ONLY" -eq 0 ] && ! { git diff --quiet && git diff --cached --quiet; }; then
    die "tracked files have uncommitted changes; commit or stash them first (git subtree needs a clean tree)"
fi

info "Fetching $REF from $UPSTREAM"
git fetch --quiet --no-tags "$UPSTREAM" "$REF" || die "could not fetch '$REF' (short SHAs can't be fetched; use a branch, tag or full SHA)"
target="$(git rev-parse 'FETCH_HEAD^{commit}')"

echo "    current: $current"
echo "    target:  $target  $(git log -1 --format='%ad %s' --date=short "$target")"

if [ "$target" = "$current" ]; then
    info "deps/randomx is already at $REF"
    exit 0
fi

if ! git merge-base --is-ancestor "$MIN_COMMIT" "$target" 2>/dev/null; then
    die "target does not contain ${MIN_COMMIT:0:7} (x86 JIT fix for RandomX v2); refusing to update"
fi

if git merge-base --is-ancestor "$current" "$target" 2>/dev/null; then
    info "Upstream changes ($(git rev-list --count "$current..$target") commits):"
    git log --oneline --no-decorate "$current..$target" | sed 's/^/    /'
    if ! git diff --quiet "$current" "$target" -- src/randomx.h; then
        info "Public API (src/randomx.h) changed:"
        git diff --stat "$current" "$target" -- src/randomx.h | sed 's/^/    /'
    fi
else
    info "Warning: target is not a descendant of the current commit (downgrade or different branch)"
fi

set_package_commit() {
    node -e '
        const fs = require("fs");
        const [file, commit, date] = process.argv.slice(1);
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        pkg.randomx = { commit, date };
        fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + "\n");
    ' "$1" "$target" "$(git log -1 --format=%ad --date=short "$target")"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
    exit 2
fi

if [ "$VERIFY" -eq 1 ]; then
    [ -d node_modules/node-addon-api ] || die "node_modules missing; run 'npm install' first (or use --no-verify)"

    tmp="$(mktemp -d "${TMPDIR:-/tmp}/randomx-update.XXXXXX")"
    keep_tmp=0
    trap '[ "$keep_tmp" -eq 1 ] || rm -rf "$tmp"' EXIT

    info "Building in $tmp"
    git archive HEAD | tar -x -C "$tmp"
    rm -rf "$tmp/$PREFIX" && mkdir -p "$tmp/$PREFIX"
    git archive "$target" | tar -x -C "$tmp/$PREFIX"
    set_package_commit "$tmp/package.json"
    ln -s "$PWD/node_modules" "$tmp/node_modules"

    if ! (cd "$tmp" && npx --yes node-gyp rebuild >build.log 2>&1); then
        keep_tmp=1
        tail -20 "$tmp/build.log" >&2
        die "build failed; full log kept at $tmp/build.log"
    fi

    vectors="$tmp/vectors.js"
    cat >"$vectors" <<'EOF'
const crypto = require('crypto');
// Native binding directly: its initContext/hash signatures are stable across addon ABI versions.
const rx = require(require('path').join(process.argv[2], 'build/Release/randomx.node'));
const seed = Buffer.from('randomx-hashing update check'.padEnd(32, '\0'));
const cases = [['light', true, 200], ['light', false, 200], ['fast', true, 2000]];
for (const [mode, enableJit, count] of cases) {
    const id = rx.initContext(seed, { mode, enableJit, threads: 8 });
    const acc = crypto.createHash('sha256');
    for (let i = 0; i < count; i++) {
        const input = crypto.createHash('sha256').update(String(i)).digest();
        acc.update(rx.hash(id, Buffer.concat([input, input.subarray(0, i % 32)])));
    }
    rx.releaseContext(id);
    console.log(`${mode}${enableJit ? '+jit' : '+interp'} ${acc.digest('hex')}`);
}
EOF

    if [ -f build/Release/randomx.node ]; then
        info "Comparing v1 hash vectors against current build/Release"
        old="$(node "$vectors" "$PWD")"
        new="$(node "$vectors" "$tmp")"
        if [ "$old" != "$new" ]; then
            keep_tmp=1
            diff <(echo "$old") <(echo "$new") >&2 || true
            die "v1 hashes changed between builds; NOT updating (export kept at $tmp)"
        fi
        echo "$new" | sed 's/^/    /'
    else
        info "No build/Release/randomx.node to compare against; skipping v1 vector comparison"
    fi

    tests="$tmp/$PREFIX/build/randomx-tests"
    if [ -x "$tests" ]; then
        info "Running upstream randomx-tests"
        if ! "$tests" >"$tmp/randomx-tests.log" 2>&1; then
            keep_tmp=1
            tail -20 "$tmp/randomx-tests.log" >&2
            die "randomx-tests failed; log kept at $tmp/randomx-tests.log"
        fi
        tail -3 "$tmp/randomx-tests.log" | sed 's/^/    /'
    fi

    info "Running npm test"
    (cd "$tmp" && npm test --silent >test.log 2>&1) || { keep_tmp=1; tail -20 "$tmp/test.log" >&2; die "npm test failed; log kept at $tmp/test.log"; }
fi

info "Merging ${target:0:7} into $PREFIX"
git subtree merge --prefix "$PREFIX" --squash "$target" -m ":arrow_up: Update RandomX to ${target:0:7} ($(git log -1 --format=%ad --date=short "$target"))

  - upstream: $UPSTREAM ($REF)
  - previous: ${current:0:7}
  - verified: $([ "$VERIFY" -eq 1 ] && echo "build, v1 vectors unchanged, randomx-tests, npm test" || echo "skipped (--no-verify)")"

# Record the commit for capabilities().randomx (compiled in from package.json by binding.gyp).
set_package_commit package.json
git commit --amend --no-edit --quiet -- package.json

info "Done. Rebuild in place with 'npm run build' (restart any process that has the addon loaded)."
