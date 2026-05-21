# GitHub Support Ticket — Purge cached pre-rewrite blobs + PR refs

Submit at: https://support.github.com/contact/personal-data-removal

(Use the **"Personal data removal"** form, OR if the topic doesn't fit, use **"Other"** with the subject below.)

---

## Subject

Purge cached pre-rewrite blobs and PR refs after `git filter-repo` history rewrite — repo `ItachiDevv/ClawVille`

---

## Body

Hi GitHub Support,

I have completed multiple `git filter-repo`-based history rewrites and force-pushed `master` to remove identifiers and a private internal-tooling directory from past commits. The repository is:

**https://github.com/ItachiDevv/ClawVille**

Following your guidance at https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository, I am writing to request that GitHub purge the cached unreachable objects so the rewritten history is the only fetchable state.

### What I have already done

- Force-pushed `master` to the rewritten history. Current `master` HEAD: `03b651a526b3b3dbcac13aeed6c2e8049ebe898d` (876 commits).
- Three distinct rewrites were performed in sequence:
  1. **Identifier rewrite** — replaced legacy domain identifiers across file contents, commit messages, and file paths via `--replace-text` + `--replace-message` + `--path-rename`. Result: 0 hits anywhere on master post-rewrite.
  2. **Directory removal** — used `--invert-paths --path .claude/` to remove an internal-tooling directory (agent definitions, planning docs, session memory, internal reports) from every commit. The directory should not have been tracked publicly. Result: 0 paths under `.claude/` in any commit on master.
  3. **Commit-message neutralization** — used `--message-callback` to replace commit subjects/bodies that referenced the rewrite process itself (those subjects had inadvertently telegraphed what the previous two passes did). All affected commits now have neutral conventional-commit messages.
- Deleted the local pre-rewrite backup branch + tag and ran `git reflog expire --expire=now --all && git gc --prune=now`.
- Confirmed via `git ls-remote origin` that `master` is the only branch on the remote.

### What still leaks pre-rewrite content

- **78 pull-request refs** (`refs/pull/1/head` through `refs/pull/78/head`) — these are GitHub-managed snapshot refs from closed PRs. They still point at the **original pre-rewrite commit SHAs**, which means anyone running:
  ```
  git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
  ```
  can fetch back the entire unredacted history. Specifically the PR refs surface ALL of:
  1. **The legacy identifiers in code, file paths, and SQL** — every file with the old domain term in its content or filename (e.g. old route filenames, schema files, types, function/variable names, migration SQL like the deleted `0007_pets_to_avatars.sql`, the deleted plan doc `pets-to-avatar-rewrite.md`, etc.).
  2. **The entire `.claude/` directory at every historical state** — agent definitions, planning documents, internal session memory, audit/break-it reports, internal SKILL files. ~176 distinct files across the directory's history.
  3. **The original commit subjects + bodies** that telegraphed the rewrite process itself (e.g. messages mentioning `/break-it adversarial probe`, `Phase 1X of avatars→avatar rename`, `untrack .claude/`, `Co-Authored-By: Claude`, etc.). These were neutralized on master in rewrite (3) but still persist in PR refs unedited.
- **Cached unreachable objects** in GitHub's storage tier that are no longer reachable from any current ref but are still served if explicitly requested by SHA.

### What I am asking for

Per the linked docs, GitHub Support has the ability to:

1. Run server-side garbage collection on this repository to purge unreachable objects.
2. Collapse or invalidate the cached PR refs so they no longer return pre-rewrite content.

Please apply both for `ItachiDevv/ClawVille` so the post-rewrite history is the only fetchable state.

### Why

Two distinct reasons:

1. **Rebrand.** The earlier identifiers were used during early development and are no longer associated with the project's current name or scope. I rewrote the history rather than renaming forward so future contributors and external observers see a consistent post-rebrand record.

2. **Internal-tooling exposure.** A `.claude/` directory containing agent definitions, internal planning docs, session memory, and audit reports was tracked publicly during early development. It should never have been pushed. The directory is now gitignored and removed from every commit on master, but persists in PR refs.

### Additional details available on request

- Specific commit SHAs of pre-rewrite vs post-rewrite states
- The exact list of identifiers scrubbed (happy to share via this ticket or a more private channel)
- The list of file/directory paths removed via `--invert-paths`
- The list of commit-subject patterns neutralized via `--message-callback`
- Verification probe results (zero hits on master across content, commit messages, file paths, and the `.claude/` directory after all three rewrites)

Repository ownership is verified via my GitHub account `ItachiDevv` which is the sole owner.

Thank you for your help.

Best,
[your name / handle]

---

## Notes for the user (don't include in submission)

- The ticket form will ask for the affected URL — provide `https://github.com/ItachiDevv/ClawVille`
- They may take 1-3 business days to respond. Past similar requests have been honored about 95% of the time when:
  - The requester is verifiably the repo owner ✓ (you are)
  - A force-push has already been done ✓
  - The request is specific (purge cached blobs + PR refs) ✓
- If GitHub asks "what specifically did you scrub?" you may need to disclose the source identifiers via reply. That disclosure becomes part of the support ticket record but is internal to GitHub.
- If they decline, fallback is **Option C** (new repo, take old private). I can prep that if it comes to it.
