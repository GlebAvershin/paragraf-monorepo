# Test fixtures

Place sample documents here for integration tests:

- `sample-contract.pdf` — образец договора (text-based, не скан)
- `sample-contract.docx` — образец договора Word
- `sample-balance.xlsx` — образец бухгалтерской таблицы

These files are **gitignored** because real documents contain client data.
Each developer keeps their own collection locally.

For unit tests, use the round-trip approach (generate → parse) — no fixtures needed.
