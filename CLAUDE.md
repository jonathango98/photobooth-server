# CLAUDE.md — Booth Server

## Memory System
At the **start of every session**, read all files in `/memory/`:
- `memory/architecture.md` — Tech stack, file structure, API routes
- `memory/decisions.md` — Design decisions and rationale
- `memory/progress.md` — Current work state, recent changes, next steps
- `memory/bugs-and-issues.md` — Known issues and gotchas
- `memory/preferences.md` — User's coding style and conventions

At the **end of every session**, update the relevant memory files with anything new you learned.

## Quick Reference

### Run the server
```bash
npm run dev    # development (auto-restart on changes)
npm start      # production
```

### Project structure
```
server.js           — All Express routes and middleware
db.js               — MongoDB connection
models/Event.js     — Event schema
memory/             — Persistent context for Claude
```

### Tech stack
Node.js + Express + MongoDB (Mongoose) + S3-compatible storage (Railway bucket)

### Auth
- Admin routes: `x-admin-password` header
- Superadmin routes: `x-superadmin-password` header
- No JWT — simple password comparison against env vars
