# Booth Server

Backend server for a photo booth application. Handles event management, photo uploads to S3-compatible storage, and admin/superadmin operations.

## Tech Stack

- **Runtime:** Node.js (ESM)
- **Framework:** Express.js
- **Database:** MongoDB (Mongoose)
- **Storage:** S3-compatible bucket (Railway) via AWS SDK v3
- **File Uploads:** Multer (in-memory, 10MB limit)
- **Zip Downloads:** Archiver

## Getting Started

### Prerequisites

- Node.js
- MongoDB instance
- S3-compatible storage bucket

### Environment Variables

| Variable | Description |
|---|---|
| `AWS_REGION` | S3 region (default: `auto`) |
| `AWS_ENDPOINT_URL_S3` | S3 endpoint URL |
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |
| `BUCKET_NAME` | S3 bucket name |
| `ADMIN_PASSWORD` | Password for admin endpoints |
| `SUPERADMIN_PASSWORD` | Password for superadmin endpoints |
| `PORT` | Server port (default: `3000`) |
| `MONGODB_URI` | MongoDB connection string |

### Run

```bash
npm install
npm run dev    # development (auto-restart on changes)
npm start      # production
```

A default "test" event is seeded automatically on first startup if no events exist.

## Project Structure

```
server.js           — Express server with all routes and middleware
db.js               — MongoDB connection helper
models/Event.js     — Mongoose Event schema
```

## Authentication

Two auth tiers via request headers (no JWT):

- **Admin** — `x-admin-password` header
- **Superadmin** — `x-superadmin-password` header

## API Endpoints

### Public

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/event` | Get active event ID |
| `GET` | `/api/event/config` | Get active event full config |
| `POST` | `/api/save` | Upload raw photos + collage (multipart) |

### Admin (requires `x-admin-password`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/photos` | List all photos for the active event (with presigned URLs) |
| `GET` | `/api/admin/download-zip` | Download all photos as a zip |
| `POST` | `/api/admin/download-selected` | Download selected photos as a zip |

### Superadmin (requires `x-superadmin-password`)

#### Event Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/superadmin/events` | List all events |
| `POST` | `/api/superadmin/events` | Create a new event |
| `PUT` | `/api/superadmin/events/:eventId` | Update an event |
| `POST` | `/api/superadmin/events/:eventId/activate` | Activate an event (deactivates all others) |
| `DELETE` | `/api/superadmin/events/:eventId` | Delete an event |

#### File Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/superadmin/tree` | S3 file tree view (all buckets) |
| `GET` | `/api/superadmin/photos` | List files with presigned URLs (optional `?prefix=`) |
| `DELETE` | `/api/superadmin/file` | Delete a single file by key |
| `DELETE` | `/api/superadmin/folder` | Delete all files under a prefix |
| `POST` | `/api/superadmin/move` | Move/rename a file |
| `GET` | `/api/superadmin/download-zip` | Download files as zip (optional `?prefix=`) |
| `POST` | `/api/superadmin/download-selected` | Download selected files as zip |

## Event Schema

Events configure the photo booth experience per occasion:

```json
{
  "event_id": "my-event",
  "event_name": "My Event",
  "templates": [
    {
      "file": "templates/template-1.png",
      "width": 1080,
      "height": 1920,
      "slots": [{ "x": 100, "y": 100 }]
    }
  ],
  "capture": { "totalShots": 3, "photoWidth": 880, "photoHeight": 495 },
  "countdown": { "seconds": 3, "stepMs": 500 },
  "gestureTrigger": {
    "enabled": false,
    "gestureType": "peace",
    "holdDuration": 1000,
    "detectionFps": 10
  },
  "background_url": ""
}
```

## S3 Storage Layout

Photos are organized per event:

```
{eventId}/raw/session_{timestamp}_raw{n}.jpg
{eventId}/collage/session_{timestamp}_collage.jpg
```

Presigned URLs are generated with a 7-day expiry for photo access.

## `/api/save` Multipart Fields

| Field | Type | Description |
|---|---|---|
| `raw1` … `raw10` | file | Individual captured photos (JPEG) |
| `collage` | file (required) | Composite image with template overlay |

Session ID is `Date.now()` at upload time. Files are stored under the currently active event's prefix.

**Response:**
```json
{ "ok": true, "sessionId": "1234567890", "collageUrl": "https://..." }
```

`collageUrl` is a 7-day presigned S3 URL, typically used to generate a QR code.

## Gesture Trigger Types

`gestureTrigger.gestureType` accepts:

| Value | Gesture |
|---|---|
| `"peace"` | Index + middle fingers extended |
| `"palm"` | All 5 fingers extended |
| `"thumbsup"` | Thumb up, other fingers curled |
