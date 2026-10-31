# Pagination

Lists are paged. Large, growing lists such as calls and messages use a **cursor**:

```
GET /api/v1/calls?limit=50
→ "meta": { "nextCursor": "eyJj…", "hasMore": true }
GET /api/v1/calls?limit=50&cursor=eyJj…
```

Pass `nextCursor` back as `cursor` until `hasMore` is `false`. Cursors are opaque, so don't build or change them. Smaller lists use pages (`?page=2&limit=50` → `meta.page`, `meta.total`, `meta.totalPages`).

`limit` is at most 100. Unknown query parameters are refused (`422`), so typos never pass silently.

Dates are ISO 8601 in UTC (`2026-10-30T05:00:00.000Z`). Money is in integer micro-units (`2500000000` = ₹2,500). Phones are E.164 (`+919876543210`).
