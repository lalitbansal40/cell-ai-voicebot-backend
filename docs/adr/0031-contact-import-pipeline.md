# 0031 — Contact import pipeline

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Clients upload their borrower sheets every day (Phase 3 "Done when": a 100-row sheet imports, every contact shows its variables, bad rows are reported). Sheets come from Excel or other tools: CSV in UTF-8 or Windows-1252, `,` / `;` / tab separators, `.xlsx` with several sheets, phone numbers mangled into scientific notation, Indian date formats. Files can reach tens of thousands of rows, so the import can't run inside the HTTP request, and a crash half-way must not leave a mess.

## Options considered

1. **Upload → map → validate (dry run) → import, as background jobs on our BullMQ queue** — the user sees exactly what will happen before anything is written.
2. **Single "upload and import" request** — simplest, but no preview, times out on big files and can't be resumed.
3. **Parse in the browser** — avoids upload, but duplicates normalisation logic and trusts the client.

Libraries:

| Need             | Choice                                         | Why                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multipart upload | `multer` 2 (memory storage, upload route only) | standard, size / file-count limits                                                                                                                                                       |
| CSV              | `csv-parse` (+ `iconv-lite` for Windows-1252)  | maintained, handles quotes / multiline / ragged rows                                                                                                                                     |
| XLSX             | `read-excel-file` (`/node`, CommonJS export)   | maintained, small, MIT; numbers read as their exact text via `parseNumber` — no float noise, long phone numbers intact. `exceljs` (last release 2024) was the fallback and wasn't needed |
| XLSX in tests    | `write-excel-file` (dev only)                  | same author, round-trips with the reader                                                                                                                                                 |

## Decision

Option 1.

- **Upload** (`POST /contact-imports`): extension + MIME + magic bytes checked (`.xls` and fakes → 415), ≤ 10 MB (413), ≤ 50,000 rows / 100 columns (`IMPORT_FILE_INVALID`). The file goes to storage (`accounts/<id>/imports/<jobId>.<ext>`); the job keeps columns, 3 sample values each, the row count and warnings.
- **XLSX zip-bomb guard**: the ZIP central directory is read (no decompression) and the declared uncompressed size must stay ≤ 100 MB.
- **CSV decoding**: UTF-8 (BOM stripped); bytes that aren't valid UTF-8 are decoded as Windows-1252 with an `encoding_fallback` warning. Delimiter sniffed from the header line.
- **Mapping** (`PUT /:id/mapping`): server suggests targets from headers (English + Hinglish aliases, existing field keys / labels, otherwise a new field with a guessed type). Exactly one phone column. New fields are created only when the import starts.
- **Validate** = dry run on the queue: same normalisation code as the import, totals + first 100 problem rows (row numbers + reasons, no cell values) + an error CSV in storage (signed URL).
- **Import** = batches of 500 upserts by phone, with a checkpoint after each batch, so a retried job resumes. There is deliberately **no single transaction**: a large import would exceed transaction limits; partial progress is visible and reported instead. One running import / validation per account (Redis lock).
- **Retention**: uploaded file, error report and samples deleted 30 days after the job ends; the job document (totals only) stays.

## Consequences

- **Positive:** users fix sheets before anything is written; big files never block the API; crashes resume; no PII in Redis or logs.
- **Negative / trade-offs:** whole files are held in memory while parsing (bounded by the 10 MB limit); `variables.*` filters are not indexed (fine at current sizes, measured by `npm run bench:contacts`).
- **Follow-ups:** `.xls` and Google Sheets links are out of scope; one-contact-per-phone vs several loans per borrower is an open client question (PHASE_3_PLAN §7).
