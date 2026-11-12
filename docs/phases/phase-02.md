# Phase 2: Foundation B

## Scope

Dynamic engines (entity and form builder, lookups, rules and formulas, workflow, state machines, templates, numbering), event outbox, public API v1, generic import and export, general ledger and posting service.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 2.5, 2.9, 2.10, 2.11, 2.12
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] An admin defines a new record type in the UI and gets list, form, history, import, export and API without a code change.
- [ ] A formula can be created, versioned with an effective date, tested against sample input, and explains its result.
- [ ] A three-step approval workflow can be configured and attached to a custom record type.
- [ ] A template with merge fields renders a server-side A4 PDF.
- [ ] Posting a sample event creates a balanced journal entry through the posting-rules table; unbalanced entries are rejected; a closed period refuses postings.
- [ ] Trial balance always sums to zero in tests with multi-currency entries.
- [ ] Events are written to the outbox in the same transaction and delivered to a signed webhook with retry.
- [ ] OpenAPI document is generated and served.
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-02.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
