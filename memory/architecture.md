# Architecture

## Tech Stack
- **Runtime:** Node.js (ESM modules)
- **Framework:** Express.js
- **Database:** MongoDB via Mongoose
- **Storage:** S3-compatible bucket (Railway) via AWS SDK v3
- **File uploads:** Multer (in-memory storage, 10MB limit)
- **Zip downloads:** Archiver

## File Structure
```
server.js       — Single-file Express server (all routes)
db.js           — MongoDB connection helper
models/Event.js — Mongoose Event model
package.json    — Dependencies and scripts
```

## Key Patterns
- All routes in a single `server.js` file (no router separation yet)
- S3 presigned URLs (7-day expiry) for photo access
- Photos organized in S3 as: `{eventId}/raw/` and `{eventId}/collage/`
- Session IDs are timestamp-based (`Date.now()`)
- Two auth tiers: admin (`x-admin-password` header) and superadmin (`x-superadmin-password` header)
- CORS open to all origins (`*`)
- Default "test" event seeded on first startup if no events exist

## API Structure
- `/api/save` — Public: upload raw photos + collage
- `/api/event` — Public: get active event ID
- `/api/event/config` — Public: get active event full config
- `/api/public/photos` — Public: list collage presigned URLs for active event (no auth; for slideshow display)
- `/api/admin/*` — Admin-protected: view/download photos for active event
- `/api/superadmin/*` — Superadmin-protected: full CRUD on events, S3 file management
- `/health` — Health check

## Environment Variables
- `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `BUCKET_NAME`
- `ADMIN_PASSWORD`, `SUPERADMIN_PASSWORD`
- `PORT` (default 3000)
- MongoDB connection string (in db.js)
