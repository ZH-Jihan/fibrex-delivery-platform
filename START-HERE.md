# এখান থেকে শুরু করুন

এই ফোল্ডারে Claude Code দিয়ে Fibrex প্ল্যাটফর্ম বানানোর সব নির্দেশনা আছে। এখনো কোনো কোড লেখা হয়নি।

## ফাইলগুলো কী

| ফাইল | কাজ |
| --- | --- |
| `docs/SPEC.md` | পুরো সফটওয়্যারের বিস্তারিত বর্ণনা (মূল প্রম্পট) |
| `CLAUDE.md` | Claude Code যে নিয়মগুলো প্রতিবার মেনে চলবে |
| `docs/phases/phase-01.md` থেকে `phase-12.md` | প্রতিটি ধাপের কাজ, শেষ হওয়ার শর্ত, এবং পেস্ট করার প্রম্পট |
| `docs/PROGRESS.md` | কোন ধাপ কতদূর হয়েছে |
| `docs/DECISIONS.md` | আপনার যে প্রশ্নগুলোর উত্তর দিতে হবে |
| `reference/` | আপনার আসল Excel ফাইলগুলো এখানে রাখবেন |

## ধাপে ধাপে

1. কম্পিউটারে Node.js 20, Git, Docker Desktop এবং Claude Code ইনস্টল করুন।
2. এই ফোল্ডারে টার্মিনাল খুলে `git init` চালান।
3. `reference/` ফোল্ডারে `Loan_Management_System_v7.xlsx` এবং `Book1.xlsx` কপি করুন।
4. `docs/DECISIONS.md` খুলে যে প্রশ্নগুলোর উত্তর জানেন সেগুলো লিখে দিন।
5. এই ফোল্ডারে `claude` চালু করে প্রথমে এটা পেস্ট করুন:

```
Read CLAUDE.md and docs/SPEC.md completely. Do not write code yet.
Give me the planning reply described in SPEC section 6.8: your understanding, the complete database schema,
the folder structure, the API endpoints per module, and your questions. Save it as docs/PLAN.md.
```

6. `docs/PLAN.md` দেখে ঠিক মনে হলে `docs/phases/phase-01.md`-এর নিচের প্রম্পটটা পেস্ট করুন।
7. প্রতিটি ধাপ শেষে: অ্যাপ চালিয়ে "Done when" তালিকা মিলিয়ে দেখুন, তারপর Git-এ commit করুন, তারপর নতুন সেশনে পরের ধাপ শুরু করুন।

## মনে রাখবেন

- ধাপ ১ ও ২ বাদ দেবেন না; এগুলোই সিস্টেমকে দীর্ঘদিন টেকাবে।
- ধাপ ৭ পর্যন্ত বানালেই আপনার এখনকার Excel ও পুরনো অ্যাপের সব কাজ চলে আসবে। অফিসে কিছুদিন ব্যবহার করে তারপর ধাপ ৮–১২ করুন।
- স্যালারি ও লোনের হিসাব প্রতিবার আপনার আসল Excel-এর সাথে মিলিয়ে দেখুন।
- অনলাইনে চালুর আগে একজন অভিজ্ঞ ডেভেলপারকে দিয়ে নিরাপত্তা পরীক্ষা করান।
