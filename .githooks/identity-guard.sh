#!/bin/sh
# identity-guard: refuse to commit or push anything that identifies the owner.
#
# This repo is PUBLIC. Twice its whole history had to be rewritten because a
# commit carried a real name, an email, home paths, machine names or an
# employer. A rewrite cannot recall what forks and caches already copied, so
# the only real fix is to never publish it.
#
# Checks: the author/committer must be the public GitHub identity below, and
# no added line, file path or commit message may match the deny-list.
#
# The deny-list lives OUTSIDE the repo, because it is itself identifying:
#   ~/.config/pan/identity-denylist   (or $PAN_IDENTITY_DENYLIST)
# One extended regex per line, matched case-insensitively; # starts a comment.
# A missing list is a hard failure, not a skip: a guard that silently stops
# guarding reads as protection while providing none.
#
# Enable per clone:  git config core.hooksPath .githooks

ALLOWED_NAME="Tereseus"
ALLOWED_EMAIL="19315896+Tereseus@users.noreply.github.com"
LIST="${PAN_IDENTITY_DENYLIST:-$HOME/.config/pan/identity-denylist}"

# Third-party code vendored under node_modules is not the owner's and quotes
# real people by name (sqlite3.c does), so it is not scanned.
VENDOR=':(exclude)*node_modules*'

fail() { printf 'identity-guard: %s\n' "$*" >&2; exit 1; }

[ -s "$LIST" ] || fail "deny-list missing at $LIST - refusing. Create it (see .githooks/identity-guard.sh)."
PAT=$(tr -d '\r' < "$LIST" | grep -vE '^[[:space:]]*(#|$)' | paste -sd'|' -)
[ -n "$PAT" ] || fail "deny-list at $LIST has no patterns - refusing."

# stdin: text to check. $1: what it is, for the error.
check_text() {
  hits=$(grep -inaE -- "$PAT" | head -5)
  [ -z "$hits" ] || fail "$1 contains identifying text:
$hits
Remove it, or if it is genuinely not about you, narrow the deny-list pattern."
}

check_ident() {  # $1 label, $2 "Name <email>"
  [ "$2" = "$ALLOWED_NAME <$ALLOWED_EMAIL>" ] || fail "$1 is '$2', must be '$ALLOWED_NAME <$ALLOWED_EMAIL>'.
Fix: git config user.name $ALLOWED_NAME && git config user.email $ALLOWED_EMAIL"
}

case "$1" in
  pre-commit)
    check_ident author    "$(git var GIT_AUTHOR_IDENT    | sed 's/ [0-9]* [-+][0-9]*$//')"
    check_ident committer "$(git var GIT_COMMITTER_IDENT | sed 's/ [0-9]* [-+][0-9]*$//')"
    git diff --cached --name-only --diff-filter=AR -- . "$VENDOR" | check_text "a staged file path" || exit 1
    git diff --cached -U0 --no-color --no-ext-diff -- . "$VENDOR" | grep -a '^+' | grep -av '^+++' | check_text "the staged changes" || exit 1
    ;;
  commit-msg)
    grep -av '^#' "$2" | check_text "the commit message" || exit 1
    ;;
  pre-push)
    zero=0000000000000000000000000000000000000000
    while read -r lref lsha rref rsha; do
      [ "$lsha" = "$zero" ] && continue                    # deleting a ref
      if [ "$rsha" = "$zero" ] || ! git cat-file -e "$rsha" 2>/dev/null; then
        range="$lsha --not --remotes"                      # new ref or rewritten history
      else
        range="$rsha..$lsha"
      fi
      # GitHub itself commits web-UI edits and merges as this committer.
      git log --format='%an <%ae>%n%cn <%ce>' $range | sort -u | grep -vx 'GitHub <noreply@github.com>' | while read -r who; do
        check_ident "a commit being pushed to $rref has identity" "$who"
      done || exit 1
      git log -p -U0 --no-color --no-ext-diff --format='%B' $range -- . "$VENDOR" | grep -av '^-' | check_text "the commits being pushed to $rref" || exit 1
    done
    ;;
  *) fail "unknown mode '$1'" ;;
esac
exit 0
