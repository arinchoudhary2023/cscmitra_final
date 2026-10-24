# CSC Digital Mitra — Supabase edition

This package keeps the existing CSCDigitalMitra V3.2 HTML interface and connects its shared application data to Supabase PostgreSQL through a small Node.js/Express backend, following the general frontend → API → database approach used by EmberLuz.

## What this build does

- Uses one Supabase PostgreSQL database for every device that connects to the same deployed application.
- Preserves the existing admin/agent dashboard and workflows instead of rebuilding the UI.
- Stores application state in the database; Local Storage is only used for UI preferences and a short-lived signed session token.
- Creates the schema automatically when the server starts. No manual SQL paste is required for the normal setup.
- Mirrors core data into relational tables: `accounts`, `services`, `account_service_permissions`, `requests`, `transactions`, `ekyc_requests`, `notifications`, `request_assignments`, `fund_requests`, `support_tickets`, `unlock_requests`, and `account_activity_logs`.
- Keeps a compatibility snapshot in `cscdm.app_state` so the existing UI's full set of settings and workflows can be preserved during this migration. The tables live in the dedicated PostgreSQL schema `cscdm`, so they do not collide with tables used by your e-commerce or NGO projects. The snapshot is the canonical application state for this release; the listed relational tables are synchronized mirrors for inspection and reporting.
- Does not create customer login accounts or an agent-facing job marketplace. The preloaded request/customer details are fictional sample records only; agents cannot accept or reject public requests. Public contact-form enquiries are not sent to the database.
- Adds **Account Settings** to the admin sidebar, including changing the administrator's own password.

## Demo login

- Email: `admin@cscmitra.in`
- Password: `admin123`

The initial database seed is created once, when the database is empty. Changing the admin password in Account Settings persists to Supabase. The admin password is not configured in `.env`.

**College-demo warning:** this requested version stores account passwords as plain text in the database. Use only fictional credentials and dummy data in a private college demonstration. Do not use real accounts, real Aadhaar/bank information, or expose this version as a public production service.

## Setup

Requirements: Node.js 20 or newer and a Supabase project with PostgreSQL available.

1. Extract the ZIP and open a terminal in the project folder.
2. Copy `.env.example` to `.env` (a blank `.env` template is included too).
3. In Supabase, open **Project Settings → Database → Connection string → URI**. Copy the PostgreSQL URI into `SUPABASE_DB_URL` in `.env`. If your network cannot reach the direct database host, use the Supabase pooler connection URI shown in the dashboard.
4. Set `JWT_SECRET` in `.env` to a long random string. It is a session-signing secret, not the admin password.
5. Run:

   ```bash
   npm install
   npm run dev
   ```

6. Open `http://localhost:3000`.

On startup, the server automatically applies `db/schema.sql` and verifies the Supabase connection. The database user in the connection string must be allowed to create tables. If the connection is invalid, the server stops with an error instead of silently falling back to Local Storage.

## Using it from another device

`localhost` only refers to the current device. To use the same database from another device, deploy this Node.js app to a reachable server/hosting service and have both devices open the same deployed URL. Both sessions will then read/write the same Supabase database. Do not expose your database URI or `JWT_SECRET` to the browser or commit `.env` to a public repository.

## Database notes

- `accounts.password` is plain text because this is the requested classroom demo. It is not safe for real users.
- Each account's service access is mirrored in `account_service_permissions` with an `is_allowed` Boolean.
- Transaction rows include account linkage, amount, optional message, status, timestamp, and the original JSON payload for compatibility.
- eKYC and request customer details in the sample dataset are fictional. Do not enter real Aadhaar or banking details.
- No real bank, wallet provider, payment gateway, or identity-verification service is connected.

## Validation

Before sharing/deploying, run `npm run check`. A live database connection test is available at `/api/health` after the server starts. A successful health response confirms the server can reach the configured Supabase PostgreSQL database; it does not mean every user workflow has been manually browser-tested.
