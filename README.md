# wa-lead-backend

Small Express + Mongoose API that syncs the WA Lead Tracker Chrome extension's
data (`chats`, `settings`) to MongoDB Atlas. Single-user, single API key -
this is not a multi-tenant service.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `MONGODB_URI` - your Atlas connection string (create a database, e.g.
     `wa_lead_tracker`, in an existing or new cluster)
   - `API_KEY` - a random secret, e.g. `openssl rand -hex 32`
3. `npm run dev` (auto-restarts on file changes) or `npm start`

Test it's alive: `curl http://localhost:3000/health` should return `{"ok":true}`.

Test an authenticated route:
```
curl -H "Authorization: Bearer <your API_KEY>" http://localhost:3000/api/chats
```
Without the header (or with a wrong key) this should return `401`.

## Endpoints

- `GET /health` - no auth, liveness check
- `GET /api/chats` - all chats, `{ chats: { [id]: {...} } }`
- `PUT /api/chats` - upsert, body is `{ [id]: {...} }` (same shape as GET returns)
- `GET /api/settings` - `{ settings: {...} }`
- `PUT /api/settings` - upsert, body is the settings object directly

All routes under `/api` require `Authorization: Bearer <API_KEY>`.

## Structure

- `server/app.js` - `createApp()`, the Express app (routes + middleware), no `listen()` call
- `server/db.js` - `connectDB()`, shared by both entry points below
- `server/index.js` - local dev entry point (`npm run dev` / `npm start`)
- `netlify/functions/api.js` - Netlify Functions entry point (wraps the same
  `createApp()` with `serverless-http`, caches the DB connection across warm
  invocations)
- `netlify.toml` - maps `/api/*` and `/health` to the function

Both entry points share the exact same routes/models, so local dev and the
Netlify deployment always behave identically.

## Deploying to Netlify (free tier)

1. Push this folder to its own git repo (GitHub/GitLab/Bitbucket).
2. On [app.netlify.com](https://app.netlify.com), **Add new site → Import an
   existing project**, pick the repo.
3. Build settings: leave build command empty (nothing to build), publish
   directory can stay default - `netlify.toml` already declares
   `functions = "netlify/functions"`.
4. Site settings → **Environment variables** → add `MONGODB_URI` and
   `API_KEY` (same values as your local `.env` - never commit `.env` itself).
5. Deploy. Your API is then live at `https://<your-site>.netlify.app` - test
   with `curl https://<your-site>.netlify.app/health`.
6. Put `https://<your-site>.netlify.app` (no trailing slash, no `/api`) as
   the **Backend URL** in the extension's Options page - the extension
   already calls `/api/chats` and `/api/settings` on top of whatever base
   URL you give it.

## Deploying elsewhere (Railway, Render, Fly.io, etc.)

The `server/` folder is a plain Express app and doesn't need Netlify at all:
1. Push this folder to its own git repo.
2. Create a new Node service on your chosen platform, point it at the repo.
3. Set the start command to `npm start` (runs `server/index.js`).
4. Set `MONGODB_URI` and `API_KEY` as environment variables in the platform's
   dashboard (never commit `.env`).
5. Once deployed, note the public HTTPS URL - that's what goes into the
   extension's Options page ("Backend URL").
