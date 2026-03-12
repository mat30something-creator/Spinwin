/**
 * SPIN & WIN — Backend Server
 * Node.js + Express + SQLite + Nodemailer
 * 
 * Install deps:  npm install
 * Run:           node server.js
 * Production:    pm2 start server.js
 */

require('dotenv').config();
const express    = require('express');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');
const QRCode     = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './spinwin.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS dealers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,       -- sales manager notification email
    phone       TEXT,
    plan        TEXT DEFAULT 'basic',
    created_at  TEXT DEFAULT (datetime('now')),
    active      INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS qr_codes (
    id          TEXT PRIMARY KEY,    -- e.g. "QR-ABC123"
    dealer_id   TEXT NOT NULL,
    label       TEXT,                -- e.g. "Lot Row A - Trucks"
    vehicle     TEXT,                -- optional specific vehicle
    scans       INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (dealer_id) REFERENCES dealers(id)
  );

  CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
    dealer_id   TEXT NOT NULL,
    qr_id       TEXT NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT NOT NULL,
    stock       TEXT,
    prize       TEXT NOT NULL,       -- "$100", "$200", "$500", "$1,000"
    code        TEXT UNIQUE NOT NULL,
    redeemed    INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'New',  -- New | Contacted | Closed
    device_hash TEXT,                -- hashed device fingerprint for cooldown
    ip_hash     TEXT,                -- hashed IP for cooldown
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT,
    FOREIGN KEY (dealer_id) REFERENCES dealers(id),
    FOREIGN KEY (qr_id)     REFERENCES qr_codes(id)
  );

  CREATE TABLE IF NOT EXISTS spin_locks (
    device_hash TEXT NOT NULL,
    dealer_id   TEXT NOT NULL,
    spun_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (device_hash, dealer_id)
  );

  CREATE TABLE IF NOT EXISTS prize_config (
    dealer_id   TEXT PRIMARY KEY,
    w100        INTEGER DEFAULT 50,
    w200        INTEGER DEFAULT 30,
    w500        INTEGER DEFAULT 15,
    w1000       INTEGER DEFAULT 5,
    cooldown_days INTEGER DEFAULT 30,
    offer_hours   INTEGER DEFAULT 72,
    FOREIGN KEY (dealer_id) REFERENCES dealers(id)
  );
`);

// Seed a demo dealer if none exist
const demoDealer = db.prepare('SELECT id FROM dealers WHERE id = ?').get('DEALER-DEMO');
if (!demoDealer) {
  db.prepare(`INSERT INTO dealers (id, name, email, phone) VALUES (?, ?, ?, ?)`)
    .run('DEALER-DEMO', 'Premier Auto Group', process.env.DEMO_SALES_EMAIL || 'sales@example.com', '(602) 555-0100');
  db.prepare(`INSERT INTO prize_config (dealer_id) VALUES (?)`).run('DEALER-DEMO');
  // Seed some QR codes
  ['QR-LOT-001','QR-LOT-002','QR-LOT-003'].forEach((qid, i) => {
    const labels = ['Lot Row A — Mixed Inventory','Lot Row B — SUVs','Lot Row C — Trucks'];
    db.prepare(`INSERT OR IGNORE INTO qr_codes (id, dealer_id, label) VALUES (?,?,?)`)
      .run(qid, 'DEALER-DEMO', labels[i]);
  });
}

// ─── Email transporter ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
});

async function sendLeadEmail(dealer, lead) {
  if (!process.env.SMTP_USER) {
    console.log('[EMAIL SKIPPED — no SMTP config] Lead:', lead.name, lead.prize);
    return;
  }
  const subject = `🎯 New Spin & Win Lead — ${lead.name} won ${lead.prize} OFF`;
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#f0ede6;padding:32px;border-radius:12px;">
      <h2 style="color:#F5C518;font-size:24px;margin-bottom:4px;">⚡ New Lead Alert</h2>
      <p style="color:#777;margin-bottom:24px;">${dealer.name} — Spin &amp; Win</p>
      
      <div style="background:#1a1a1a;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:20px;margin-bottom:16px;">
        <h3 style="margin:0 0 16px;font-size:18px;">${lead.name}</h3>
        <p style="margin:6px 0;font-size:14px;">📧 <a href="mailto:${lead.email}" style="color:#F5C518">${lead.email}</a></p>
        <p style="margin:6px 0;font-size:14px;">📞 <a href="tel:${lead.phone}" style="color:#F5C518">${lead.phone}</a></p>
        <p style="margin:6px 0;font-size:14px;">🚗 ${lead.stock || 'Vehicle not specified'}</p>
      </div>

      <div style="background:#1A3A2A;border:1px solid rgba(34,197,94,0.2);border-radius:8px;padding:20px;margin-bottom:16px;text-align:center;">
        <div style="color:#4ADE80;font-size:12px;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;">Prize Won</div>
        <div style="font-size:40px;font-weight:900;color:white;">${lead.prize} OFF</div>
        <div style="font-size:12px;color:#555;margin-top:8px;">Code: <strong style="color:#F5C518;letter-spacing:2px">${lead.code}</strong></div>
        <div style="font-size:11px;color:#555;margin-top:4px;">Expires: ${lead.expires_at}</div>
      </div>

      <div style="font-size:12px;color:#555;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;margin-top:16px;">
        QR Source: ${lead.qr_id} &nbsp;·&nbsp; Submitted: ${lead.created_at}<br/>
        <a href="${process.env.DASHBOARD_URL || 'http://localhost:3000'}/dashboard.html" style="color:#F5C518">View in Dashboard →</a>
      </div>
    </div>
  `;
  await transporter.sendMail({
    from: `"Spin & Win" <${process.env.SMTP_USER}>`,
    to: dealer.email,
    subject,
    html
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 32);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function rollPrize(config) {
  const prizes = [
    { amount: '$100',   weight: config.w100  },
    { amount: '$200',   weight: config.w200  },
    { amount: '$500',   weight: config.w500  },
    { amount: '$1,000', weight: config.w1000 },
  ];
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of prizes) {
    r -= p.weight;
    if (r <= 0) return p.amount;
  }
  return prizes[0].amount;
}

function addHours(h) {
  const d = new Date();
  d.setHours(d.getHours() + h);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/qr/:qrId/config
 * Returns dealer name + prize config for the landing page
 */
app.get('/api/qr/:qrId/config', (req, res) => {
  const qr = db.prepare(`
    SELECT q.*, d.name as dealer_name, d.id as dealer_id,
           p.w100, p.w200, p.w500, p.w1000, p.cooldown_days, p.offer_hours
    FROM qr_codes q
    JOIN dealers d ON d.id = q.dealer_id
    JOIN prize_config p ON p.dealer_id = d.id
    WHERE q.id = ? AND q.active = 1 AND d.active = 1
  `).get(req.params.qrId);

  if (!qr) return res.status(404).json({ error: 'QR code not found or inactive' });
  res.json({
    qrId:      qr.id,
    dealerId:  qr.dealer_id,
    dealerName: qr.dealer_name,
    label:     qr.label,
    vehicle:   qr.vehicle,
    prizes:    { w100: qr.w100, w200: qr.w200, w500: qr.w500, w1000: qr.w1000 },
    cooldownDays: qr.cooldown_days,
    offerHours:   qr.offer_hours
  });
});

/**
 * POST /api/leads
 * Submit a lead + roll prize
 * Body: { qrId, dealerId, name, email, phone, stock, deviceFingerprint }
 */
app.post('/api/leads', async (req, res) => {
  const { qrId, dealerId, name, email, phone, stock, deviceFingerprint } = req.body;

  // Validate
  if (!qrId || !dealerId || !name || !email || !phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Look up dealer + config
  const dealer = db.prepare('SELECT * FROM dealers WHERE id = ? AND active = 1').get(dealerId);
  if (!dealer) return res.status(404).json({ error: 'Dealer not found' });

  const config = db.prepare('SELECT * FROM prize_config WHERE dealer_id = ?').get(dealerId);

  // Check cooldown
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  const deviceHash = hashString((deviceFingerprint || '') + ip + dealerId);
  const cooldownMs = (config.cooldown_days || 30) * 24 * 60 * 60 * 1000;

  const lock = db.prepare('SELECT spun_at FROM spin_locks WHERE device_hash = ? AND dealer_id = ?')
    .get(deviceHash, dealerId);

  if (lock) {
    const elapsed = Date.now() - new Date(lock.spun_at).getTime();
    if (elapsed < cooldownMs) {
      const msLeft = cooldownMs - elapsed;
      const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
      return res.status(429).json({ error: 'cooldown', daysLeft });
    }
  }

  // Roll prize
  const prize = rollPrize(config);
  const code  = generateCode();
  const id    = uuidv4();
  const expiresAt = addHours(config.offer_hours || 72);

  // Save lead
  db.prepare(`
    INSERT INTO leads (id, dealer_id, qr_id, name, email, phone, stock, prize, code, device_hash, ip_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, dealerId, qrId, name, email, phone, stock || '', prize, code, deviceHash, hashString(ip), expiresAt);

  // Update spin lock
  db.prepare(`
    INSERT OR REPLACE INTO spin_locks (device_hash, dealer_id, spun_at)
    VALUES (?, ?, datetime('now'))
  `).run(deviceHash, dealerId);

  // Increment QR scan count
  db.prepare('UPDATE qr_codes SET scans = scans + 1 WHERE id = ?').run(qrId);

  // Send email notification (non-blocking)
  sendLeadEmail(dealer, { name, email, phone, stock, prize, code, qr_id: qrId, created_at: new Date().toLocaleString(), expires_at: expiresAt })
    .catch(err => console.error('[Email Error]', err.message));

  res.json({ success: true, prize, code, expiresAt });
});

/**
 * GET /api/dashboard/:dealerId/leads
 * Returns all leads for the dealer dashboard (add auth middleware in production)
 */
app.get('/api/dashboard/:dealerId/leads', (req, res) => {
  // TODO: add JWT/session auth middleware before going live
  const leads = db.prepare(`
    SELECT id, name, email, phone, stock, prize, code, status, qr_id, created_at, expires_at, redeemed
    FROM leads WHERE dealer_id = ?
    ORDER BY created_at DESC
  `).all(req.params.dealerId);
  res.json(leads);
});

/**
 * PATCH /api/dashboard/leads/:leadId/status
 * Update lead status
 */
app.patch('/api/dashboard/leads/:leadId/status', (req, res) => {
  const { status } = req.body;
  if (!['New','Contacted','Closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, req.params.leadId);
  res.json({ success: true });
});

/**
 * GET /api/dashboard/:dealerId/qrcodes
 * Returns all QR codes for a dealer
 */
app.get('/api/dashboard/:dealerId/qrcodes', (req, res) => {
  const codes = db.prepare('SELECT * FROM qr_codes WHERE dealer_id = ? ORDER BY created_at DESC')
    .all(req.params.dealerId);
  res.json(codes);
});

/**
 * POST /api/dashboard/:dealerId/qrcodes
 * Create a new QR code + return its PNG as base64
 */
app.post('/api/dashboard/:dealerId/qrcodes', async (req, res) => {
  const { label, vehicle } = req.body;
  const dealerId = req.params.dealerId;
  const id = 'QR-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  db.prepare('INSERT INTO qr_codes (id, dealer_id, label, vehicle) VALUES (?,?,?,?)')
    .run(id, dealerId, label || '', vehicle || '');

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const url = `${baseUrl}/?qr=${id}&dealer=${dealerId}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#000', light: '#fff' } });

  res.json({ id, url, qrDataUrl });
});

/**
 * GET /api/dashboard/:dealerId/stats
 * Summary stats for the dashboard header
 */
app.get('/api/dashboard/:dealerId/stats', (req, res) => {
  const { dealerId } = req.params;
  const total     = db.prepare('SELECT COUNT(*) as c FROM leads WHERE dealer_id = ?').get(dealerId).c;
  const newLeads  = db.prepare("SELECT COUNT(*) as c FROM leads WHERE dealer_id = ? AND status = 'New'").get(dealerId).c;
  const jackpots  = db.prepare("SELECT COUNT(*) as c FROM leads WHERE dealer_id = ? AND prize = '$1,000'").get(dealerId).c;
  const todayLeads = db.prepare("SELECT COUNT(*) as c FROM leads WHERE dealer_id = ? AND date(created_at) = date('now')").get(dealerId).c;
  const prizeBreakdown = db.prepare(`
    SELECT prize, COUNT(*) as count FROM leads WHERE dealer_id = ? GROUP BY prize
  `).all(dealerId);
  const weeklyScans = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM leads WHERE dealer_id = ?
    AND created_at >= datetime('now', '-7 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(dealerId);
  res.json({ total, newLeads, jackpots, todayLeads, prizeBreakdown, weeklyScans });
});

/**
 * PATCH /api/dashboard/:dealerId/config
 * Update prize weights + settings
 */
app.patch('/api/dashboard/:dealerId/config', (req, res) => {
  const { w100, w200, w500, w1000, cooldown_days, offer_hours, email } = req.body;
  db.prepare(`
    UPDATE prize_config SET w100=?, w200=?, w500=?, w1000=?, cooldown_days=?, offer_hours=?
    WHERE dealer_id=?
  `).run(w100, w200, w500, w1000, cooldown_days, offer_hours, req.params.dealerId);
  if (email) db.prepare('UPDATE dealers SET email=? WHERE id=?').run(email, req.params.dealerId);
  res.json({ success: true });
});

/**
 * POST /api/dealers/signup
 * Public endpoint — new dealer self-onboarding
 * Body: { name, contact, email, phone, city, plan, prizes:[{amount,weight}] }
 */
app.post('/api/dealers/signup', async (req, res) => {
  const { name, contact, email, phone, city, plan, prizes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  const dealerId = 'DEALER-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const firstQrId = 'QR-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  // Insert dealer
  db.prepare(`INSERT INTO dealers (id, name, email, phone, plan) VALUES (?,?,?,?,?)`)
    .run(dealerId, name, email, phone || '', plan || 'starter');

  // Insert prize config (custom or defaults)
  const w = Array.isArray(prizes) && prizes.length >= 4 ? prizes : null;
  db.prepare(`INSERT INTO prize_config (dealer_id, w100, w200, w500, w1000) VALUES (?,?,?,?,?)`)
    .run(
      dealerId,
      w ? w[0].weight : 50,
      w ? w[1].weight : 30,
      w ? w[2].weight : 15,
      w ? w[3].weight : 5
    );

  // Also store custom prize amounts if they differ from defaults
  if (w) {
    db.exec(`ALTER TABLE prize_config ADD COLUMN IF NOT EXISTS amt100 INTEGER DEFAULT 100`);
    db.exec(`ALTER TABLE prize_config ADD COLUMN IF NOT EXISTS amt200 INTEGER DEFAULT 200`);
    db.exec(`ALTER TABLE prize_config ADD COLUMN IF NOT EXISTS amt500 INTEGER DEFAULT 500`);
    db.exec(`ALTER TABLE prize_config ADD COLUMN IF NOT EXISTS amt1000 INTEGER DEFAULT 1000`);
    db.prepare(`UPDATE prize_config SET amt100=?,amt200=?,amt500=?,amt1000=? WHERE dealer_id=?`)
      .run(w[0].amount, w[1].amount, w[2].amount, w[3].amount, dealerId);
  }

  // Create a starter QR code
  db.prepare(`INSERT INTO qr_codes (id, dealer_id, label) VALUES (?,?,?)`)
    .run(firstQrId, dealerId, 'Main Lot');

  // Send welcome email (non-blocking)
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  if (process.env.SMTP_USER) {
    const welcomeHtml = `
      <div style="font-family:sans-serif;max-width:560px;background:#0a0a0a;color:#f0ede6;padding:32px;border-radius:12px;">
        <h2 style="color:#F5C518">⚡ Welcome to Spin & Win!</h2>
        <p style="color:#888;margin-bottom:24px;">Hi ${name}, your account is ready.</p>
        <div style="background:#1a1a1a;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:20px;margin-bottom:16px;">
          <p style="margin:6px 0;font-size:14px;color:#ccc;">Your Dealer ID: <strong style="color:#F5C518;letter-spacing:2px">${dealerId}</strong></p>
          <p style="margin:6px 0;font-size:14px;color:#ccc;">Your first QR: <strong style="color:#F5C518">${firstQrId}</strong></p>
        </div>
        <a href="${baseUrl}/dashboard.html?dealer=${dealerId}" style="display:inline-block;background:#D0021B;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;margin-bottom:16px;">Open My Dashboard →</a>
        <p style="font-size:12px;color:#555;">Spin Page: ${baseUrl}/?qr=${firstQrId}&dealer=${dealerId}<br/>
        Print Stickers: ${baseUrl}/sticker.html?qr=${firstQrId}&dealer=${dealerId}</p>
      </div>`;
    transporter.sendMail({
      from: `"Spin & Win" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `⚡ Your Spin & Win account is ready — ${name}`,
      html: welcomeHtml
    }).catch(err => console.error('[Welcome Email Error]', err.message));

    // Also notify admin
    if (process.env.ADMIN_EMAIL) {
      transporter.sendMail({
        from: `"Spin & Win" <${process.env.SMTP_USER}>`,
        to: process.env.ADMIN_EMAIL,
        subject: `🆕 New dealer signup: ${name} (${plan})`,
        html: `<p>New dealer signed up:<br/><strong>${name}</strong><br/>${email}<br/>Plan: ${plan}<br/>ID: ${dealerId}</p>`
      }).catch(() => {});
    }
  }

  res.json({ success: true, dealerId, firstQrId });
});

/**
 * GET /api/admin/dealers
 * Admin: list all dealers with stats (protect with admin token in production)
 */
app.get('/api/admin/dealers', (req, res) => {
  // TODO: add admin auth middleware
  const dealers = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM leads l WHERE l.dealer_id = d.id) as lead_count,
      (SELECT COUNT(*) FROM qr_codes q WHERE q.dealer_id = d.id) as qr_count
    FROM dealers d ORDER BY d.created_at DESC
  `).all();
  res.json(dealers);
});

/**
 * POST /api/admin/dealers
 * Admin: manually create a dealer
 */
app.post('/api/admin/dealers', (req, res) => {
  const { name, email, phone, plan, prizes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  // Reuse signup logic
  req.body.contact = req.body.contact || '';
  req.body.city    = req.body.city    || '';
  // Forward to signup handler logic (simplified inline)
  const dealerId  = 'DEALER-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const firstQrId = 'QR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare(`INSERT INTO dealers (id, name, email, phone, plan) VALUES (?,?,?,?,?)`)
    .run(dealerId, name, email, phone||'', plan||'starter');
  db.prepare(`INSERT INTO prize_config (dealer_id) VALUES (?)`).run(dealerId);
  db.prepare(`INSERT INTO qr_codes (id, dealer_id, label) VALUES (?,?,?)`)
    .run(firstQrId, dealerId, 'Main Lot');
  res.json({ success: true, dealerId, firstQrId });
});

/**
 * PATCH /api/admin/dealers/:dealerId
 * Admin: update dealer plan, status, prizes
 */
app.patch('/api/admin/dealers/:dealerId', (req, res) => {
  const { plan, status, email, prizes } = req.body;
  const { dealerId } = req.params;
  if (plan || status || email) {
    const updates = [];
    const vals    = [];
    if (plan)   { updates.push('plan=?');   vals.push(plan); }
    if (status) { updates.push('active=?'); vals.push(status === 'active' ? 1 : 0); }
    if (email)  { updates.push('email=?');  vals.push(email); }
    if (updates.length) {
      vals.push(dealerId);
      db.prepare(`UPDATE dealers SET ${updates.join(',')} WHERE id=?`).run(...vals);
    }
  }
  if (prizes && prizes.length >= 4) {
    db.prepare(`UPDATE prize_config SET w100=?,w200=?,w500=?,w1000=? WHERE dealer_id=?`)
      .run(prizes[0].weight, prizes[1].weight, prizes[2].weight, prizes[3].weight, dealerId);
  }
  res.json({ success: true });
});

/**
 * GET /api/admin/stats
 * Platform-wide stats for admin dashboard
 */
app.get('/api/admin/stats', (req, res) => {
  const totalDealers = db.prepare('SELECT COUNT(*) as c FROM dealers').get().c;
  const activeDealers = db.prepare("SELECT COUNT(*) as c FROM dealers WHERE active=1").get().c;
  const totalLeads   = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const todayLeads   = db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at)=date('now')").get().c;
  const planBreakdown = db.prepare('SELECT plan, COUNT(*) as count FROM dealers WHERE active=1 GROUP BY plan').all();
  res.json({ totalDealers, activeDealers, totalLeads, todayLeads, planBreakdown });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n⚡ Spin & Win server running at http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`   Demo spin: http://localhost:${PORT}/?qr=QR-LOT-001&dealer=DEALER-DEMO\n`);
});
