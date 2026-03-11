# Bugs & Issues

Known issues, gotchas, and things to watch out for.

## Known Issues

### Duplicate route definitions
`/api/superadmin/tree`, `/api/superadmin/photos`, `/api/superadmin/file`, `/api/superadmin/folder`, `/api/superadmin/download-zip`, `/api/superadmin/download-selected`, and `/api/superadmin/move` are each defined twice in `server.js` — once using `checkSuperAdmin` middleware and once using `checkSuperadmin`. The second definitions (with pagination via `ContinuationToken`) will override the first. Should be cleaned up.

### Duplicate middleware
`checkSuperAdmin` and `checkSuperadmin` are two separate middleware functions that do the same thing (lines 71-78 and 83-90). Should be consolidated.

## Gotchas
- S3 presigned URLs expire after 7 days
- `MaxKeys` caps differ between admin (500) and first superadmin routes (1000/5000) — second superadmin routes use pagination correctly
- No rate limiting on public `/api/save` endpoint

---
*Update this file when bugs are discovered or resolved.*
