CREATE SCHEMA IF NOT EXISTS cscdm;

-- CSC Digital Mitra demo schema. Automatically applied by server.js at startup.
-- This app retains a JSONB compatibility snapshot so the existing HTML's full workflow
-- can be migrated without rewriting every screen at once. The core entities are also
-- mirrored into relational tables for inspection and future reporting.

CREATE TABLE IF NOT EXISTS cscdm.app_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cscdm.accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','agent')),
  mobile TEXT NOT NULL DEFAULT '',
  account_status TEXT NOT NULL DEFAULT 'active',
  ekyc_status TEXT,
  wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  default_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.account_service_permissions (
  account_id TEXT NOT NULL REFERENCES cscdm.accounts(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES cscdm.services(id) ON DELETE CASCADE,
  is_allowed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, service_id)
);

CREATE TABLE IF NOT EXISTS cscdm.requests (
  id TEXT PRIMARY KEY,
  service_id TEXT,
  created_by TEXT,
  assigned_agent_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  default_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  final_price NUMERIC(12,2),
  customer_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  related_request_id TEXT,
  transaction_type TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  message TEXT,
  status TEXT,
  occurred_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.ekyc_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  review_message TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES cscdm.accounts(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cscdm.request_assignments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES cscdm.requests(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  assignment_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cscdm.fund_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.support_tickets (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  category TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  reply TEXT,
  created_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.unlock_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES cscdm.accounts(id) ON DELETE SET NULL,
  service_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMPTZ,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS cscdm.account_activity_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transactions_account_time ON cscdm.transactions(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_agent_status ON cscdm.requests(assigned_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_ekyc_status ON cscdm.ekyc_requests(status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_account_time ON cscdm.notifications(account_id, created_at DESC);
