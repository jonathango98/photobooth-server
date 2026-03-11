# Decisions

Record of design decisions and their rationale.

## Active Decisions

### Single-file server
All routes live in `server.js`. No router splitting yet — keeps things simple for a small API.

### S3-compatible storage on Railway
Using Railway's S3-compatible bucket service rather than direct AWS S3. Configured with `forcePathStyle: true`.

### Two-tier auth via headers
Simple header-based auth (`x-admin-password`, `x-superadmin-password`) rather than JWT/sessions. Appropriate for internal/event use.

### Event-based photo organization
Photos are namespaced by `event_id` in S3 (`{eventId}/raw/`, `{eventId}/collage/`). Only one event can be active at a time.

---
*Update this file when significant design choices are made or changed.*
