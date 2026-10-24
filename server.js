require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('\nMissing Supabase PostgreSQL connection string. Set SUPABASE_DB_URL in .env.');
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 24 || JWT_SECRET.includes('replace-with')) {
  console.error('\nSet JWT_SECRET in .env to a long random value. This is a session signing secret, not an admin password.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 5 });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const asDate = value => value ? new Date(Number(value)) : null;
const json = value => JSON.stringify(value ?? {});

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query('SELECT 1');
}

function safeState(state, userId = null) {
  const copy = structuredClone(state);
  for (const user of (copy.users || [])) {
    if (user.id !== userId) delete user.pw;
  }
  return copy;
}

function publicState(state) {
  // Public homepage only needs content and the service catalogue; never expose accounts,
  // transactions, request records, or eKYC submissions before authentication.
  return { v: state.v || 3, svcs: state.svcs || [], plans: state.plans || [], ann: state.ann || [] };
}

async function readState(client = pool) {
  const result = await client.query('SELECT data, revision FROM cscdm.app_state WHERE id=1');
  return result.rows[0] || null;
}

async function syncMirrors(client, state) {
  // Snapshot is canonical for this compatibility release; normalized tables are kept in sync.
  const accountIds = new Set((state.users || []).map(u => String(u.id)));
  const validAccount = id => id != null && accountIds.has(String(id)) ? String(id) : null;
  await client.query('DELETE FROM cscdm.request_assignments');
  await client.query('DELETE FROM cscdm.notifications');
  await client.query('DELETE FROM cscdm.account_activity_logs');
  await client.query('DELETE FROM cscdm.support_tickets');
  await client.query('DELETE FROM cscdm.fund_requests');
  await client.query('DELETE FROM cscdm.unlock_requests');
  await client.query('DELETE FROM cscdm.ekyc_requests');
  await client.query('DELETE FROM cscdm.transactions');
  await client.query('DELETE FROM cscdm.requests');
  await client.query('DELETE FROM cscdm.account_service_permissions');
  await client.query('DELETE FROM cscdm.services');
  await client.query('DELETE FROM cscdm.accounts');

  for (const u of (state.users || [])) {
    await client.query(`INSERT INTO cscdm.accounts(id,name,email,password,role,mobile,account_status,ekyc_status,wallet_balance,created_by,created_at,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`, [
      String(u.id), String(u.name || ''), String(u.email || '').toLowerCase(), String(u.pw ?? ''), u.role === 'admin' ? 'admin' : 'agent',
      String(u.mobile || ''), String(u.st || 'active'), u.kycStatus || null, Number(u.bal || 0), u.createdBy || null, asDate(u.created), json(u)
    ]);
  }
  for (const s of (state.svcs || [])) {
    await client.query(`INSERT INTO cscdm.services(id,name,category,description,default_price,is_active,is_archived,display_order,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [String(s.id), String(s.en || s.id), s.cat || null, s.de || null, Number(s.price || 0), !!s.pub, !!s.arch, Number(s.ord || 0), json(s)]);
  }
  for (const u of (state.users || [])) {
    for (const service of (state.svcs || [])) {
      await client.query(`INSERT INTO cscdm.account_service_permissions(account_id,service_id,is_allowed) VALUES($1,$2,$3)`, [String(u.id), String(service.id), (u.perms || []).includes(service.id)]);
    }
  }
  for (const r of (state.reqs || [])) {
    await client.query(`INSERT INTO cscdm.requests(id,service_id,created_by,assigned_agent_id,status,default_price,final_price,customer_data,created_at,updated_at,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)`, [
      String(r.id), r.svc || null, r.createdBy || null, validAccount(r.ag), String(r.st || 'Open'), Number(r.price || 0), r.finalPrice == null ? null : Number(r.finalPrice),
      json(r.customer || {}), asDate(r.created || (r.h && r.h[0] && r.h[0][1])), asDate(r.updated || Date.now()), json(r)
    ]);
  }
  for (const t of (state.txs || [])) {
    const accountId = validAccount(t.aid || t.uid || null);
    await client.query(`INSERT INTO cscdm.transactions(id,account_id,related_request_id,transaction_type,amount,message,status,occurred_at,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [
      String(t.id), accountId ? String(accountId) : null, t.rid ? String(t.rid) : null, String(t.kind || 'transaction'), Number(t.amt || 0), t.reason || t.message || null,
      String(t.st || 'Recorded'), asDate(t.t), json(t)
    ]);
  }
  for (const k of (state.kycs || [])) {
    await client.query(`INSERT INTO cscdm.ekyc_requests(id,account_id,status,submitted_at,reviewed_at,reviewed_by,review_message,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [String(k.id), validAccount(k.uid), String(k.status || 'Pending'), asDate(k.submitted), asDate(k.reviewed), k.reviewedBy || null, k.reason || null, json(k)]);
  }
  for (const n of (state.notes || [])) {
    await client.query(`INSERT INTO cscdm.notifications(id,account_id,message,is_read,created_at) VALUES($1,$2,$3,$4,$5)`, [String(n.id), validAccount(n.to), String(n.m || ''), !!n.read, asDate(n.t)]);
  }
  for (const f of (state.fundRequests || [])) {
    await client.query(`INSERT INTO cscdm.fund_requests(id,account_id,amount,reason,status,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [String(f.id), validAccount(f.aid), Number(f.amount || 0), f.reason || null, String(f.status || 'Pending'), asDate(f.created), json(f)]);
  }
  for (const t of (state.tickets || [])) {
    await client.query(`INSERT INTO cscdm.support_tickets(id,account_id,subject,category,body,status,reply,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [String(t.id), validAccount(t.uid), String(t.subject || 'Support'), t.category || null, t.body || null, String(t.status || 'Open'), t.reply || null, asDate(t.t), json(t)]);
  }
  for (const l of (state.unl || [])) {
    await client.query(`INSERT INTO cscdm.unlock_requests(id,account_id,service_id,reason,status,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [String(l.id), validAccount(l.aid), l.svc || null, l.why || null, String(l.st || 'Pending'), asDate(l.created), json(l)]);
  }
  for (const r of (state.reqs || [])) {
    if (r.to) await client.query(`INSERT INTO cscdm.request_assignments(id,request_id,agent_id,assignment_kind,status,created_at) VALUES($1,$2,$3,$4,$5,$6)`, [`${r.id}:direct:${r.to}`, String(r.id), validAccount(r.to), 'direct', String(r.st || 'Open'), asDate(r.created)]);
    if (r.ag) await client.query(`INSERT INTO cscdm.request_assignments(id,request_id,agent_id,assignment_kind,status,created_at) VALUES($1,$2,$3,$4,$5,$6)`, [`${r.id}:assigned:${r.ag}`, String(r.id), validAccount(r.ag), 'assigned', String(r.st || 'Open'), asDate(r.created)]);
  }
  for (const a of (state.audit || [])) {
    await client.query(`INSERT INTO cscdm.account_activity_logs(actor,action,target,details,created_at) VALUES($1,$2,$3,$4::jsonb,$5)`, [a.by || null, String(a.act || 'activity'), a.target || null, json({ why: a.why || '' }), asDate(a.t)]);
  }
}


function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function equal(a, b) { return stable(a) === stable(b); }
function byId(items) { return new Map((items || []).map(item => [String(item.id), item])); }
function mergeAgentState(oldState, incoming, actor) {
  const merged = structuredClone(oldState);
  const oldUsers = byId(oldState.users), newUsers = byId(incoming.users);
  if (oldUsers.size !== newUsers.size || [...oldUsers.keys()].some(id => !newUsers.has(id))) throw new Error('Only administrators can create or delete accounts.');
  for (const [id, oldUser] of oldUsers) {
    const nextUser = newUsers.get(id);
    if (id !== String(actor.id)) {
      const a = structuredClone(oldUser), b = structuredClone(nextUser);
      delete a.pw; delete b.pw;
      if (!equal(a, b) || (nextUser.pw !== undefined && nextUser.pw !== oldUser.pw)) throw new Error('Agents cannot change another account.');
    } else {
      for (const key of ['id', 'role', 'st', 'bal', 'open', 'perms', 'features', 'created', 'createdBy']) {
        if (!equal(nextUser[key], oldUser[key])) throw new Error('Only administrators can change account role, status, balance, or permissions.');
      }
      if (oldUser.kycStatus === 'Approved' && nextUser.kycStatus !== 'Approved') throw new Error('An approved eKYC status cannot be changed by an agent.');
      if (nextUser.kycStatus !== oldUser.kycStatus && nextUser.kycStatus !== 'Pending') throw new Error('Only administrators can approve or reject eKYC.');
      const updated = merged.users.find(u => String(u.id) === id);
      for (const key of ['name', 'email', 'mobile', 'pw']) if (nextUser[key] !== undefined) updated[key] = nextUser[key];
      if (nextUser.kycStatus !== undefined) updated.kycStatus = nextUser.kycStatus;
    }
  }

  // Agents may change only their own allowed request status transitions.
  const oldReqs = byId(oldState.reqs), nextReqs = byId(incoming.reqs);
  if (oldReqs.size !== nextReqs.size || [...oldReqs.keys()].some(id => !nextReqs.has(id))) throw new Error('Agents cannot create or delete requests.');
  merged.reqs = structuredClone(oldState.reqs || []);
  for (let i = 0; i < merged.reqs.length; i++) {
    const oldR = oldReqs.get(String(merged.reqs[i].id)), nextR = nextReqs.get(String(oldR.id));
    if (equal(oldR, nextR)) continue;
    const oldBase = structuredClone(oldR), nextBase = structuredClone(nextR);
    for (const obj of [oldBase, nextBase]) { delete obj.ag; delete obj.to; delete obj.st; delete obj.h; }
    if (!equal(oldBase, nextBase)) throw new Error('Agents cannot change request details.');
    const id = String(actor.id);
    const advanced = ((oldR.st === 'Accepted' && nextR.st === 'In Progress') || (oldR.st === 'In Progress' && nextR.st === 'Completed')) && oldR.ag === id && nextR.ag === oldR.ag && nextR.to === oldR.to;
    if (!advanced) throw new Error('Agents cannot accept or reject requests. Only the status of already assigned work can be updated.');
    merged.reqs[i] = structuredClone(nextR);
  }

  // Agents can submit/update their own pending eKYC only. They cannot review it.
  const oldKycs = oldState.kycs || [], nextKycs = incoming.kycs || [];
  const oldOtherKycs = oldKycs.filter(k => String(k.uid) !== String(actor.id));
  const nextOtherKycs = nextKycs.filter(k => String(k.uid) !== String(actor.id));
  if (!equal(oldOtherKycs, nextOtherKycs)) throw new Error('Agents cannot review another account’s eKYC.');
  const ownKycs = nextKycs.filter(k => String(k.uid) === String(actor.id));
  if (ownKycs.some(k => k.status !== 'Pending' || k.reviewed || k.reviewedBy)) throw new Error('Agents may submit eKYC for review but cannot approve it.');
  merged.kycs = [...ownKycs.map(k => structuredClone(k)), ...oldOtherKycs.map(k => structuredClone(k))];

  // Read flags on own notifications may change; new agent notifications may only target admin.
  const oldNotes = oldState.notes || [], nextNotes = incoming.notes || [];
  const oldNoteIds = new Set(oldNotes.map(n => String(n.id)));
  const nextNoteMap = byId(nextNotes);
  for (const oldNote of oldNotes) {
    const nextNote = nextNoteMap.get(String(oldNote.id));
    if (!nextNote) throw new Error('Notification history cannot be deleted.');
    if (String(oldNote.to) === String(actor.id)) {
      const a = structuredClone(oldNote), b = structuredClone(nextNote); delete a.read; delete b.read;
      if (!equal(a, b)) throw new Error('Only your notification read status can be changed.');
    } else if (!equal(oldNote, nextNote)) throw new Error('Agents cannot change another account’s notifications.');
  }
  const newNotes = nextNotes.filter(n => !oldNoteIds.has(String(n.id)));
  if (newNotes.some(n => String(n.to) !== 'admin')) throw new Error('Agent-generated notifications must be addressed to the administrator.');
  merged.notes = [...newNotes.map(n => structuredClone(n)), ...nextNotes.filter(n => oldNoteIds.has(String(n.id))).map(n => structuredClone(n))];

  const appendOwn = (key, ownerField) => {
    const oldItems = oldState[key] || [], nextItems = incoming[key] || [];
    const oldMap = byId(oldItems), nextMap = byId(nextItems);
    for (const [id, item] of oldMap) if (!nextMap.has(id) || !equal(item, nextMap.get(id))) throw new Error(`Existing ${key} records cannot be changed by an agent.`);
    const added = nextItems.filter(item => !oldMap.has(String(item.id)));
    if (added.some(item => String(item[ownerField]) !== String(actor.id))) throw new Error(`Agents can only add their own ${key} records.`);
    merged[key] = [...added.map(item => structuredClone(item)), ...oldItems.map(item => structuredClone(item))];
  };
  appendOwn('tickets', 'uid');
  appendOwn('fundRequests', 'aid');
  appendOwn('unl', 'aid');

  // Keep the audit history append-only for agent actions.
  const oldAudit = oldState.audit || [], nextAudit = incoming.audit || [];
  const remaining = [...nextAudit];
  for (const oldEntry of oldAudit) {
    const index = remaining.findIndex(entry => equal(entry, oldEntry));
    if (index < 0) throw new Error('Audit history cannot be edited or deleted.');
    remaining.splice(index, 1);
  }
  merged.audit = [...remaining.map(entry => structuredClone(entry)), ...oldAudit.map(entry => structuredClone(entry))];
  return merged;
}

async function writeState(state) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT data FROM cscdm.app_state WHERE id=1 FOR UPDATE');
    // Preserve passwords omitted from the client's sanitized copy; accept explicitly supplied new passwords.
    if (current.rows[0]) {
      const oldUsers = new Map((current.rows[0].data.users || []).map(u => [String(u.id), u]));
      for (const user of (state.users || [])) {
        if (user.pw === undefined && oldUsers.has(String(user.id))) user.pw = oldUsers.get(String(user.id)).pw;
      }
    }
    await client.query(`INSERT INTO cscdm.app_state(id,data,revision,updated_at) VALUES(1,$1::jsonb,1,now())
      ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, revision=cscdm.app_state.revision+1, updated_at=now()`, [json(state)]);
    await syncMirrors(client, state);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please log in again.' });
  try { req.session = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Your session expired. Please log in again.' }); }
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'supabase-postgres' }); }
  catch { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
});

app.get('/api/public-state', async (_req, res) => {
  try {
    const row = await readState();
    if (!row) return res.json({ initialized: false });
    res.json({ initialized: true, state: publicState(row.data), revision: Number(row.revision) });
  } catch (error) { console.error('public-state:', error.message); res.status(500).json({ error: 'Could not load application data.' }); }
});

app.post('/api/bootstrap', async (req, res) => {
  try {
    if (!req.body || !req.body.state || !Array.isArray(req.body.state.users)) return res.status(400).json({ error: 'Initial state is invalid.' });
    const existing = await readState();
    if (existing) return res.status(409).json({ error: 'Database is already initialized.' });
    const state = req.body.state;
    if (!state.users.some(u => u.role === 'admin' && String(u.email).toLowerCase() === 'admin@cscmitra.in' && String(u.pw) === 'admin123')) {
      return res.status(400).json({ error: 'Initial admin seed is missing expected demo credentials.' });
    }
    await writeState(state);
    res.status(201).json({ ok: true });
  } catch (error) { console.error('bootstrap:', error.message); res.status(500).json({ error: 'Could not initialize database.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const row = await readState();
    if (!row) return res.status(503).json({ error: 'The database has not been initialized. Reload the page and try again.' });
    const user = (row.data.users || []).find(u => String(u.email || '').trim().toLowerCase() === email && String(u.pw ?? '') === password);
    if (!user) return res.status(401).json({ error: 'Email ID or password is incorrect.' });
    if (user.st === 'locked' || user.st === 'disabled' || user.st === 'suspended') return res.status(403).json({ error: 'This account is locked. Please contact the administrator.' });
    const token = jwt.sign({ sub: String(user.id), role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    const safe = safeState(row.data, String(user.id));
    res.json({ token, userId: String(user.id), state: safe, revision: Number(row.revision) });
  } catch (error) { console.error('login:', error.message); res.status(500).json({ error: 'Login failed. Please try again.' }); }
});

app.get('/api/state', auth, async (req, res) => {
  try {
    const row = await readState();
    if (!row) return res.status(404).json({ error: 'Application state not initialized.' });
    const user = (row.data.users || []).find(u => String(u.id) === String(req.session.sub));
    if (!user || user.st === 'locked' || user.st === 'disabled' || user.st === 'suspended') return res.status(403).json({ error: 'Account is not active.' });
    res.json({ state: safeState(row.data, String(req.session.sub)), revision: Number(row.revision) });
  } catch (error) { console.error('state:', error.message); res.status(500).json({ error: 'Could not load application data.' }); }
});

app.put('/api/state', auth, async (req, res) => {
  try {
    if (!req.body || !req.body.state || !Array.isArray(req.body.state.users)) return res.status(400).json({ error: 'Application state is invalid.' });
    const row = await readState();
    if (!row) return res.status(404).json({ error: 'Application state not initialized.' });
    const actor = (row.data.users || []).find(u => String(u.id) === String(req.session.sub));
    if (!actor || actor.st === 'locked' || actor.st === 'disabled' || actor.st === 'suspended') return res.status(403).json({ error: 'Account is not active.' });
    let next = req.body.state;
    if (actor.role !== 'admin') {
      try { next = mergeAgentState(row.data, next, actor); }
      catch (error) { return res.status(403).json({ error: error.message || 'This action is not allowed for agents.' }); }
    }
    await writeState(next);
    res.json({ ok: true, state: safeState(next, String(actor.id)) });
  } catch (error) { console.error('save:', error.message); res.status(500).json({ error: 'Could not save application data.' }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`CSCDigitalMitra running at http://localhost:${PORT} (Supabase PostgreSQL)`));
}).catch(error => {
  console.error('\nFailed to initialize Supabase database. Check SUPABASE_DB_URL and your Supabase project.');
  console.error(error.message);
  process.exit(1);
});

process.on('SIGINT', async () => { await pool.end().catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { await pool.end().catch(() => {}); process.exit(0); });
