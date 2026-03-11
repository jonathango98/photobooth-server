# Backend Todo — Event-Based Configuration

## Railway MongoDB Setup

- [ ] In Railway dashboard → your project → click **"New"** → **"Database"** → **"MongoDB"**
- [ ] Railway will provision a MongoDB instance and expose a `MONGO_URL` connection string
- [ ] Add `MONGO_URL` as an environment variable on the booth-server service
  - If MongoDB is in the same Railway project, you can use Railway's variable references (e.g., `${{MongoDB.MONGO_URL}}`)
- [ ] Verify the connection string works by checking Railway logs after deploy

---

## Install Dependencies

- [ ] Run `npm install mongoose`

---

## Create `db.js` — MongoDB Connection Module

- [ ] Create `/db.js` with:
  ```js
  import mongoose from "mongoose";

  export async function connectDB() {
    try {
      await mongoose.connect(process.env.MONGO_URL);
      console.log("MongoDB connected");
    } catch (err) {
      console.error("MongoDB connection error:", err);
      process.exit(1);
    }
  }
  ```

---

## Create `models/Event.js` — Mongoose Schema

- [ ] Create `/models/Event.js` with the following schema:

| Field | Type | Notes |
|-------|------|-------|
| `event_id` | `String`, unique, required, indexed | Matches `EVENT_ID` env var |
| `event_name` | `String`, required | Display name (e.g., "IFGF NextGen Photo Booth") |
| `templates` | Array of objects | Each: `{ name: String, file: String, preview: String, width: Number, height: Number, slots: [{ x: Number, y: Number }] }` |
| `capture` | Object | `{ totalShots: Number, photoWidth: Number, photoHeight: Number }` |
| `countdown` | Object | `{ seconds: Number, stepMs: Number }` |
| `qr` | Object | `{ size: Number, margin: Number }` |
| `background_url` | `String`, optional | Background image URL (default `""`) |
| `is_active` | `Boolean` | Default `true` |
| `created_at` | `Date` | Default `Date.now` |
| `updated_at` | `Date` | Default `Date.now`, auto-updated via `pre('save')` hook |

- [ ] Template `file` and `preview` fields reference frontend paths (e.g., `templates/template-1.png`)

---

## Modify `server.js`

### Startup & Seeding

- [ ] Import `connectDB` from `./db.js` and `Event` from `./models/Event.js`
- [ ] Call `await connectDB()` before `app.listen()` (wrap in async IIFE or use top-level await)
- [ ] Add seed logic: if no event document exists for the current `EVENT_ID`, create one with these defaults:
  ```js
  {
    event_id: EVENT_ID,
    event_name: "IFGF NextGen Photo Booth",
    templates: [
      { name: "Template 1", file: "templates/template-1.png", preview: "templates/template-1.png", width: 1080, height: 1920, slots: [{ x: 100, y: 100 }, { x: 100, y: 639 }, { x: 100, y: 1178 }] },
      { name: "Template 2", file: "templates/template-2.png", preview: "templates/template-2.png", width: 1080, height: 1920, slots: [{ x: 100, y: 100 }, { x: 100, y: 639 }, { x: 100, y: 1178 }] },
      { name: "Template 3", file: "templates/template-3.png", preview: "templates/template-3.png", width: 1080, height: 1920, slots: [{ x: 100, y: 100 }, { x: 100, y: 639 }, { x: 100, y: 1178 }] }
    ],
    capture: { totalShots: 3, photoWidth: 880, photoHeight: 495 },
    countdown: { seconds: 3, stepMs: 500 },
    qr: { size: 300, margin: 1 },
    is_active: true
  }
  ```

### Update CORS

- [ ] Add `DELETE, PUT` to `Access-Control-Allow-Methods`
- [ ] Add `x-superadmin-password` to `Access-Control-Allow-Headers` (if not already present)

### New Endpoint — `GET /api/event/config`

- [ ] No authentication required (called by the photobooth frontend)
- [ ] Finds the event document matching the current `EVENT_ID`
- [ ] Returns the full event config object
- [ ] Returns `404` if no matching event found

### New CRUD Endpoints (all require `x-superadmin-password` header)

- [ ] **`GET /api/superadmin/events`**
  - List all events, sorted by `created_at` descending
  - Response: `{ ok: true, events: [...] }`

- [ ] **`POST /api/superadmin/events`**
  - Create a new event from request body
  - Validate `event_id` is unique
  - Response: `{ ok: true, event: {...} }`

- [ ] **`PUT /api/superadmin/events/:eventId`**
  - Update event matching `eventId` param
  - Accept partial updates (only fields in body get updated)
  - Set `updated_at` to now
  - Response: `{ ok: true, event: {...} }`

- [ ] **`DELETE /api/superadmin/events/:eventId`**
  - Delete the event config document (does NOT delete S3 photos)
  - Response: `{ ok: true }`

---

## Testing

- [ ] Deploy to Railway and check logs for "MongoDB connected"
- [ ] `GET /api/event/config` → should return the seeded default event
- [ ] Test all CRUD endpoints via curl or Postman with `x-superadmin-password` header
- [ ] Change `EVENT_ID` env var in Railway → redeploy → verify `/api/event/config` returns different config (or seeds a new default)
