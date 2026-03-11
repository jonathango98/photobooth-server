# Superadmin Page — Backend Todo

## Overview
Add superadmin API endpoints to the Railway Express.js server. These endpoints allow full bucket browsing, listing all files across events, and deleting files/folders. Authenticated with a separate `SUPERADMIN_PASSWORD`.

---

## 1. Environment Variable
- [ ] Add `SUPERADMIN_PASSWORD` to Railway environment variables (must be different from `ADMIN_PASSWORD`)

## 2. Auth Middleware
- [ ] Create `superadminAuth` middleware that:
  - Reads `x-superadmin-password` from request headers
  - Compares against `process.env.SUPERADMIN_PASSWORD`
  - Returns 401 if missing or incorrect
- [ ] Apply this middleware to all `/api/superadmin/*` routes

## 3. API Endpoints

### `GET /api/superadmin/tree`
Returns the full folder/file tree of the bucket.
- [ ] Use S3 `ListObjectsV2` to list all objects in the bucket
- [ ] Build a tree structure from the object keys, e.g.:
  ```json
  {
    "name": "/",
    "type": "folder",
    "children": [
      {
        "name": "raw",
        "type": "folder",
        "children": [
          { "name": "session_123_raw1.jpg", "type": "file", "size": 45000, "lastModified": "..." }
        ]
      },
      {
        "name": "collage",
        "type": "folder",
        "children": [...]
      }
    ]
  }
  ```
- [ ] Include file metadata: size, lastModified

### `GET /api/superadmin/photos?prefix=<path>`
Returns all files under a given prefix (folder path) with presigned URLs.
- [ ] Use S3 `ListObjectsV2` with `Prefix` parameter
- [ ] If no `prefix` query param, list everything
- [ ] For each object, generate a presigned GET URL (same expiry as admin: 7 days)
- [ ] Return:
  ```json
  {
    "ok": true,
    "files": [
      {
        "key": "raw/session_123_raw1.jpg",
        "url": "https://presigned-url...",
        "size": 45000,
        "lastModified": "2024-01-15T..."
      }
    ]
  }
  ```

### `DELETE /api/superadmin/file`
Deletes a single file from the bucket.
- [ ] Accept JSON body: `{ "key": "raw/session_123_raw1.jpg" }`
- [ ] Use S3 `DeleteObject` with the given key
- [ ] Return `{ "ok": true, "deleted": "raw/session_123_raw1.jpg" }`
- [ ] Return 404 if key doesn't exist

### `DELETE /api/superadmin/folder`
Deletes all objects under a given prefix (folder).
- [ ] Accept JSON body: `{ "prefix": "raw/" }`
- [ ] Use S3 `ListObjectsV2` to get all keys under prefix
- [ ] Use S3 `DeleteObjects` (batch delete) to remove them all
- [ ] Return `{ "ok": true, "deletedCount": 15 }`
- [ ] Safety check: reject if prefix is empty or "/" (prevent accidental full bucket wipe)

## 4. CORS
- [ ] Ensure CORS allows the frontend origin to make DELETE requests (may already be configured for admin)

## 5. Testing
- [ ] Test all endpoints with curl or Postman:
  - Tree endpoint returns correct structure
  - Photos endpoint returns presigned URLs that work
  - File delete removes the file and returns success
  - Folder delete removes all files under prefix
  - Wrong password returns 401
  - Empty prefix on folder delete is rejected
