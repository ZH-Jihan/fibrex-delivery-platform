# Decisions

## Open: the owner must answer these

Questions 11 onward come from `docs/PLAN.md` section 7 (the Q number there is shown in brackets).

| # | Question | Needed for | Answer |
| --- | --- | --- | --- |
| 1 | Salary columns: is `COD` an earning (as in the Excel formulas) or a deduction (as in the old app)? Are `Bills` and `Adjustments Minus` deducted? | Phase 7 | |
| 2 | Snoonu daily report sheet link and its column names | Phase 4 | |
| 3 | Company email list for document expiry alerts | Phase 3 | |
| 4 | Loan approval order: permitted admins, then owner, then manager. Confirm. | Phase 9 | |
| 5 | Should loans recorded under "Fibrex Delivery Service" stay as Company-type borrower entries or become company expenses? | Phase 6 | |
| 6 | Snoonu rate card and a sample payout statement | Phase 8 | |
| 7 | WPS salary file and bulk-transfer specification from the bank | Phase 7 | |
| 8 | WhatsApp Business and SMS provider accounts | Phase 9 | |
| 9 | Chart of accounts from the accountant, or approval to use a standard one. Also: which month does the financial year start? (PLAN Q12) | Phase 2 | |
| 11 | (Q3) Loan interest: (a) payment applied interest first, principal first, or proportionally? (b) interest income recognised when the loan is given or when collected? (c) investor profit share from interest charged or interest collected? | Phase 6 | |
| 12 | (Q4) Can a negative-salary advance be recorded without a signed loan paper? | Phase 6, 7 | |
| 13 | (Q5) Open-ended loans (term 0): after one month, is the status Open or Overdue? Proposal: copy the workbook's exact rule. | Phase 6 | |
| 14 | (Q6) A worker on two platforms in one month: one payslip or one per platform? | Phase 7 | |
| 15 | (Q7) Maximum deduction per month, minimum take-home, and order of deductions when earnings are not enough (confirm legal limits with the legal adviser) | Phase 7 | |
| 16 | (Q8) "Free" repayment plan loans: engine deducts nothing automatically (only file or manual)? | Phase 7 | |
| 17 | (Q14) COD outstanding at ID handover: owed by the ID owner or the operator? | Phase 4, 7 | |
| 18 | (Q15) Company-rented vehicle: is any rent deducted from the worker's salary? | Phase 5, 7 | |
| 19 | (Q16) Database dump or read-only access to the old payroll app's PostgreSQL for migration | Phase 7 | |
| 20 | (Q17) Currencies needed at launch besides QAR; are bKash amounts recorded in BDT or QAR? | Phase 2, 6 | |
| 21 | (Q18) Existing number formats to keep (payslip, invoice, handover slip) | Phase 2 | |
| 22 | (Q19) Retention period for ex-employee and unsuccessful-candidate records (legal adviser to confirm) | Phase 2, 12 | |
| 23 | (Q11) Hosting for staging and production | Before first deploy | Decide later (2026-11-13). Phase 1 builds CI and Docker; the deploy job is switched on once chosen. |
| 24 | (Q11) Email sending method: Gmail API or SMTP | Phase 3 | Decide later (2026-11-13). Development uses Mailpit through the email adapter. |

## Made

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-13 | PostgreSQL instead of MongoDB | Relational, financial data needs transactions and foreign keys |
| 2026-11-13 | Multi-tenant, party model and double-entry ledger from the first migration | Avoid a redesign in the next 5 to 10 years |
| 2026-11-13 | Default currency QAR, time zone Asia/Qatar, configurable per company | Company operates in Qatar |
| 2026-11-13 | Falcon ID, Falcon Flex ID and Snoonu ID are the same number: one `party_identifier` type for Snoonu, used by the sheet sync, salary file and loan workbook import (PLAN Q2) | Owner confirmed |
| 2026-11-13 | Two-factor login (TOTP) mandatory for Super Admin, Admin and Owner from the first release; stored as a per-role setting (PLAN Q9, conflict C10) | Owner chose the stricter SPEC 6.5 rule |
| 2026-11-13 | Product name in the interface: **Fibrex** (replaces the working name FleetForce) (DECISIONS #10) | Owner chose |
| 2026-11-13 | First-release interface languages: English, Bangla, Urdu, Hindi, Nepali. Arabic is not translated at launch, but RTL support stays in the i18n setup so it can be added without refactoring (SPEC 1) (DECISIONS #10) | Owner chose; the answer also ticked "English only", which was read as "English is included" |
| 2026-11-13 | Code stored in a private GitHub repository; CI on GitHub Actions. The owner creates the repository; nothing is pushed without asking (PLAN Q11) | Owner chose |
| 2026-11-13 | **Node 24 LTS replaces Node 20** in the stack (CLAUDE.md and SPEC 1 updated) | Node 20 reached end of life on 2026-04-30; SPEC 6.6 requires supported LTS versions only. Owner approved the substitution. |
| 2026-11-13 | Phase 1 plan approved (`docs/phases/phase-01-plan.md`). The staging deploy workflow is written but disabled until hosting is chosen; Phase 1 can be accepted on that basis | Hosting is "decide later" |
| 2026-11-13 | pnpm through corepack, version pinned in `package.json` (`packageManager`) | Same pnpm version on every machine and in CI |
