# Phase 9: Worker app and requests

## Scope

Rider and driver mobile app, electronic signature, loan application workflow, service request catalogue, WhatsApp and SMS.

## Read first

- `CLAUDE.md` (rules)
- `docs/SPEC.md` sections: 4.5, 5.10, 5.11, 2.10 (service request catalogue)
- `docs/PROGRESS.md` and `docs/DECISIONS.md`

## Done when

- [ ] PWA installs on Android, works offline for queued forms, and receives push notifications.
- [ ] Loan application passes review, owner approval and manager disbursement, with notifications and a live tracker.
- [ ] E-signature stores signer, time, IP, device and document hash and stamps the PDF.
- [ ] WhatsApp and SMS are channels of the notification service with delivery status (stub adapters allowed until accounts exist).
- [ ] A worker sees only his own data (tested).
- [ ] Tests for this phase pass in CI, and `docs/PROGRESS.md` is updated.

## Prompt to paste into Claude Code

```
Read CLAUDE.md, docs/PROGRESS.md, docs/DECISIONS.md and docs/phases/phase-09.md, then the SPEC sections it lists.
First show me your plan for this phase (tables, endpoints, screens, tests) and any questions. Wait for my approval.
After approval, build the phase in small commits, run the tests, and finish by updating docs/PROGRESS.md
with what was built, how to run it, and what is still open.
```
