# Versioning

The API version is **`2026-10`**; webhook payloads carry it as `apiVersion`.

- **Additive changes ship without a new version:** new routes, new optional fields in requests, new fields in answers and webhook payloads, new webhook event types, new error codes. Write clients that ignore unknown fields and unknown events.
- **Breaking changes** (removing / renaming a field, changing a type or a status code) come only with a new version. The old version keeps working for **6 months** after the announcement; key owners get an e-mail and the change is listed in the changelog.
- Status values and enums can gain new members; handle unknown values gracefully.
