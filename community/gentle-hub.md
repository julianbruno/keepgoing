# List Keepgoing on Gentle Hub

Use the `gentle-hub-project` GitHub topic: Keepgoing is a community project for stock Pi. The [Hub join instructions](https://gentlemanprogramming.com/gentle-hub/#join) do not require an npm release, submission form, or catalog pull request. The README badge is attribution, not an opt-in.

## Before opting in

Publish the **reviewed, installable extension** to the public repository’s `main` branch first. A documentation-only push is not a release. Check the public installation instructions and run the package tests on the exact release candidate. Use a branch descended from public `main`, not a branch containing private commit history or task notes; do not force-push.

From a clone of `julianbruno/keepgoing`, run this read-only preflight for the 1.0.0 launch (Bash, Git, Node.js, GitHub CLI). It fetches the public branch, checks visibility, and reads files from that commit, not your working directory:

```bash
(
  set -eu -o pipefail
  repo=julianbruno/keepgoing
  test "$(gh api "repos/$repo" --jq .visibility)" = public
  git fetch --no-tags "https://github.com/$repo.git" refs/heads/main
  release=$(git rev-parse FETCH_HEAD)
  git show "$release:package.json" | node -e '
    const p = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (p.name !== "pi-keepgoing" || p.version !== "1.0.0" ||
        !p.pi?.extensions?.includes("./extensions/keepgoing.ts")) process.exit(1);'
  for path in extensions/keepgoing.ts src/inhibitor.ts src/recovery.ts docs/install.md; do
    git cat-file -e "$release:$path"
  done
  printf 'Public release files present at %s\n' "$release"
)
```

If the check fails, **stop**. Do not add the topic to announce a partial release. A passing check verifies file presence and package identity, not runtime behavior.

## Opt in and verify

Only after the release and preflight pass, add the topic without replacing existing topics:

```bash
gh repo edit julianbruno/keepgoing --add-topic gentle-hub-project
gh api repos/julianbruno/keepgoing/topics --jq '.names[]'
```

Alternatively, add the topic under **About → Topics** on GitHub. Confirm `gentle-hub-project` is visible there, then look for `julianbruno/keepgoing` in the [Hub project listing](https://gentlemanprogramming.com/gentle-hub/). Discovery is eventual: applying the topic does not confirm indexing or endorsement.
