# Glossary of finance and system terms

Draft Bangla for the Qatar-based office team. Needs review by a native speaker. QAR, IBAN, CSV, PDF, API and similar words stay in English on screen.

## Finance

| English | Bangla | Plain meaning |
| --- | --- | --- |
| Ledger | লেজার (খতিয়ান) | The book of all money entries. Nothing keeps its own balance; balances come from here. |
| Chart of accounts | হিসাবের তালিকা | The list of all accounts (cash, bank, loans, income, expense). |
| Account | হিসাব | One line in the chart that collects entries of one kind. |
| Header account | হেডার | A group heading. It holds other accounts and takes no entries itself. |
| Postable account | পোস্টযোগ্য হিসাব | An account that can receive entries. |
| Control account | নিয়ন্ত্রণ হিসাব | An account whose total is the sum of people balances (for example workers owe the company). Every line names the person. |
| Journal | জার্নাল | One recorded money event with at least two lines that balance. |
| Manual journal | হাতে লেখা জার্নাল | A journal typed by a person as a draft, then posted. |
| Posting | পোস্টিং | Writing a journal into the ledger. After this it cannot be changed. |
| Reversal | উল্টানো এন্ট্রি | A new journal that cancels an old one. This is how mistakes are corrected. |
| Debit | ডেবিট | The left side of an entry. |
| Credit | ক্রেডিট | The right side of an entry. |
| Balanced | মিলেছে | Total debit equals total credit. |
| Asset | সম্পদ | Something the company owns or is owed. |
| Liability | দায় | Something the company owes. |
| Equity | মালিকানা মূলধন | The owners' share in the company. |
| Income | আয় | Money earned. |
| Expense | খরচ | Money spent. |
| Base currency | মূল মুদ্রা | The company currency (QAR). All totals are shown in it. |
| Exchange rate | বিনিময় হার | How much base currency one unit of another currency is worth on a day. |
| Fiscal year | অর্থবছর | The twelve-month period used for the books. |
| Period (open, closed, locked) | সময়কাল (খোলা, বন্ধ, তালাবদ্ধ) | A month of the fiscal year. Entries can be posted only while it is open. |
| Trial balance | ট্রায়াল ব্যালান্স | A list of every account with its debit and credit totals; the two sides must be equal. |
| General ledger | সাধারণ লেজার | All entries of one account, with a running balance. |
| Party statement | পক্ষের বিবরণী | All entries of one person or organisation with a running balance. |
| Cost centre | খরচ কেন্দ্র | A department or project used to group costs. |
| Tax code | কর কোড | A tax type and rate attached to an entry. |
| Posting rule | পোস্টিং নিয়ম | The rule that says which journal a business event creates. |
| Simulate | পরীক্ষা | See the journal a rule would post, without saving anything. |
| Memo | টীকা | A short note on a journal line. |

## Cash and bank

| English | Bangla | Plain meaning |
| --- | --- | --- |
| Cash location | ক্যাশ রাখার স্থান | A place that holds money: cash box, bank, card or wallet. |
| Bank statement | ব্যাংক স্টেটমেন্ট | The list of money in and out sent by the bank. |
| Reconciliation | ব্যাংক মিলকরণ | Checking that each bank line has a matching ledger entry. |
| Match / unmatch | মেলান / মিল ভাঙুন | Pair, or un-pair, a bank line with a ledger entry. |
| Match rule | মিলের নিয়ম | A hint that helps auto-matching read the bank's wording. |
| IBAN | IBAN | International bank account number. Stored encrypted; only the last four characters show. |
| WPS | WPS | Qatar Wage Protection System, used to pay salaries through banks. |
| Money in / money out | টাকা ঢুকেছে / টাকা বেরিয়েছে | Direction of a bank line. |

## System

| English | Bangla | Plain meaning |
| --- | --- | --- |
| Lookup list | বাছাই তালিকা | A dropdown list (vehicle types, payment methods) that can be changed without a release. |
| Numbering sequence | নম্বর সিরিজ | The pattern and counter that give records numbers like INV-2026-00042. Numbers are never reused. |
| Record type | রেকর্ডের ধরন | A kind of record the business defines itself, with its own fields. |
| Field | ঘর (ফিল্ড) | One box of information on a record. |
| Draft / published / retired | খসড়া / প্রকাশিত / বন্ধ | The life of a version. A published version never changes. |
| Template | টেমপ্লেট | A letter, slip or message with merge fields such as {{name}}. |
| Formula | সূত্র | A calculation written as a rule (pay, fines, rates). Tested before it is put in force. |
| Rate table | রেট তালিকা | Rates by platform, profession, zone and so on, with start and end dates. |
| State machine | অবস্থার ধাপ | The statuses a record can have and the moves allowed between them. |
| Workflow | অনুমোদনের ধাপ | A chain of approval steps for a record. |
| Binding | অনুমোদন শুরুর শর্ত | What starts a workflow by itself. |
| Task inbox | কাজের ইনবক্স | Approvals waiting for one person. |
| Stand-in | বদলি | A person who receives someone's approval tasks while they are away. |
| Escalation | উপরে তোলা | A task sent to a higher person when its deadline passes. |
| Webhook | ওয়েবহুক | A signed message the system sends to another system when something happens. |
| Event | ঘটনা | Something the system announces, for example "journal posted". |
| Import / export | ইমপোর্ট / এক্সপোর্ট | Load a sheet into the system, or download records as a file. |
| Rollback (of an import) | ইমপোর্ট ফিরিয়ে নেওয়া | Undo a whole import; its records go to the recycle bin. |
| Recycle bin | রিসাইকেল বিন | Where deleted items wait. Nothing is deleted for good. |
| Audit log | অডিট লগ | The permanent record of who changed what and when. |
| Retention | সংরক্ষণের মেয়াদ | How long data is kept. Phase 2 only tests this; it deletes nothing. |
| Role | ভূমিকা | A set of permissions given to users. |
| Permission | অনুমতি | The right to do one thing, such as view or approve. |
