# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, and fetch its labels.
- **List issues**: `gh issue list` with suitable state, label, and JSON filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If this is changed to `yes`, triage skills should process external PRs with the same labels and states as issues, using the corresponding `gh pr` commands.

## Publishing and fetching

When a skill says to publish to the issue tracker, create a GitHub issue.

When a skill says to fetch the relevant ticket, run `gh issue view <number> --comments`.

## Wayfinding

- A map is one issue labelled `wayfinder:map`, containing the Notes, Decisions-so-far, and Fog.
- Child tickets are linked GitHub sub-issues. If sub-issues are unavailable, list them in the map and add `Part of #<map>` to each child.
- Use native GitHub issue dependencies for blockers when available; otherwise add a `Blocked by: #<n>` line.
- A ticket is ready when it has no open blockers and no assignee.
- Claim a ticket with `gh issue edit <n> --add-assignee @me`.
- Resolve it with a comment, close it, then update the map’s Decisions-so-far.
