# Domain Docs

How engineering skills should consume this repo's domain documentation.

## Before exploring

Read `CONTEXT.md` at the repo root, if present, and relevant ADRs in `docs/adr/`.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. Domain docs can be created when domain terms or decisions need to be resolved.

## File structure

This is a single-context repo:

- `CONTEXT.md` holds domain vocabulary and concepts.
- `docs/adr/` holds architecture decisions.

## Use the glossary

Use terms as defined in `CONTEXT.md`. If a needed concept is missing, reconsider whether new terminology is necessary or note the gap for domain modeling.

## Flag ADR conflicts

Surface any conflict with an existing ADR rather than silently overriding it.
