/**
 * SPIN & WIN — Backend Server
 * Fixes: dealer PIN auth, rate limiting, persistent DB path
 */

require('dotenv').config();
const express    = require('express');
const sqlite3    = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const QRCode     = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH ||
  'b433e3d25d8b55297297fc4a7bf1e020ccb8485af87d62e1f038917ef2496cf8';

const STRIPE_PRICES = {
  basic: process.env.STRIPE_PRICE_BASIC || '',
  pro:   process.env.STRIPE_PRICE_PRO   || '',
};

// ─── Rate Limiting (Fix #3) ───────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) { record.count = 0; record.resetAt = now + windowMs; }
    record.count++;
    rateLimitMap.set(key, record);
    if (record.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}
// Clean up rate limit map every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ─── Database (Fix #2 — use /data path for persistent disk on Render) ─────────
// On Render paid tier: set DB_PATH=/data/spinwin.db and add a persistent disk at /data
const DB_PATH = process.env.DB_PATH || './spinwin.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('[DB Error]', err.message);
  else console.log('[DB] Connected to', DB_PATH);
});

const dbRun = (sql, params=[]) => new Promise((res,rej) => db.run(sql, params, function(err){ err ? rej(err) : res(this); }));
const dbGet = (sql, params=[]) => new Promise((res,rej) => db.get(sql, params, (err,row) => err ? rej(err) : res(row)));
const dbAll = (sql, params=[]) => new Promise((res,rej) => db.all(sql, params, (err,rows) => err ? rej(err) : res(rows)));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS dealers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
    phone TEXT, contact TEXT, city TEXT, plan TEXT DEFAULT 'basic',
    status TEXT DEFAULT 'trial', stripe_customer TEXT, stripe_sub TEXT,
    brand_color TEXT DEFAULT '#D0021B', brand_logo TEXT DEFAULT '',
    dashboard_pin TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), active INTEGER DEFAULT 1
  )`);
  db.run(`ALTER TABLE dealers ADD COLUMN dashboard_pin TEXT DEFAULT ''`, [], () => {});
  db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
    id TEXT PRIMARY KEY, dealer_id TEXT NOT NULL, label TEXT, vehicle TEXT,
    scans INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, dealer_id TEXT NOT NULL, qr_id TEXT NOT NULL,
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
    stock TEXT, prize TEXT NOT NULL, code TEXT UNIQUE NOT NULL, assigned_to TEXT DEFAULT '',
    redeemed INTEGER DEFAULT 0, status TEXT DEFAULT 'New',
    device_hash TEXT, ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')), expires_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS spin_locks (
    device_hash TEXT NOT NULL, dealer_id TEXT NOT NULL,
    spun_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (device_hash, dealer_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS prize_config (
    dealer_id TEXT PRIMARY KEY, w100 INTEGER DEFAULT 50,
    w200 INTEGER DEFAULT 30, w500 INTEGER DEFAULT 15, w1000 INTEGER DEFAULT 5,
    amt1 INTEGER DEFAULT 100, amt2 INTEGER DEFAULT 200,
    amt3 INTEGER DEFAULT 500, amt4 INTEGER DEFAULT 1000,
    cooldown_days INTEGER DEFAULT 30, offer_hours INTEGER DEFAULT 72,
    notify_emails TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS dealer_sessions (
    token TEXT PRIMARY KEY, dealer_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Seed demo dealer
  db.get('SELECT id FROM dealers WHERE id=?', ['DEALER-DEMO'], (err, row) => {
    if (!row) {
      const pin = generatePin();
      db.run(`INSERT INTO dealers (id,name,email,phone,plan,status,dashboard_pin) VALUES (?,?,?,?,?,?,?)`,
        ['DEALER-DEMO','Premier Auto Group',process.env.DEMO_SALES_EMAIL||'sales@example.com','(602) 555-0100','pro','active', hashPin(pin)]);
      db.run(`INSERT INTO prize_config (dealer_id) VALUES (?)`, ['DEALER-DEMO']);
      [['QR-LOT-001','Lot Row A'],['QR-LOT-002','Lot Row B — SUVs'],['QR-LOT-003','Lot Row C — Trucks']].forEach(([qid,label]) => {
        db.run(`INSERT OR IGNORE INTO qr_codes (id,dealer_id,label) VALUES (?,?,?)`, [qid,'DEALER-DEMO',label]);
      });
      console.log(`[DEMO] Dashboard PIN: ${pin}`);
    }
  });
});

// ─── Email ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST||'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT||'587'),
  secure: process.env.SMTP_SECURE==='true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendLeadEmail(dealer, lead, config) {
  if (!process.env.SMTP_USER) return;
  const extra = config.notify_emails ? config.notify_emails.split(',').map(e=>e.trim()).filter(Boolean) : [];
  const to = [dealer.email, ...extra].join(',');
  await transporter.sendMail({
    from: `"Spin & Win" <${process.env.SMTP_USER}>`,
    to,
    subject: `🎯 New Lead — ${lead.name} won ${lead.prize} OFF · ${dealer.name}`,
    html: `<div style="font-family:sans-serif;max-width:560px;background:#0a0a0a;color:#f0ede6;padding:32px;border-radius:12px;">
      <h2 style="color:#F5C518">⚡ New Lead — ${dealer.name}</h2>
      <div style="background:#1a1a1a;border-radius:8px;padding:20px;margin-bottom:16px;">
        <h3>${lead.name}</h3>
        <p>📧 <a href="mailto:${lead.email}" style="color:#F5C518">${lead.email}</a></p>
        <p>📞 <a href="tel:${lead.phone}" style="color:#F5C518">${lead.phone}</a></p>
        <p>🚗 ${lead.stock||'Not specified'}</p>
      </div>
      <div style="background:#1A3A2A;border-radius:8px;padding:20px;text-align:center;margin-bottom:16px;">
        <div style="color:#4ADE80;font-size:11px;text-transform:uppercase;letter-spacing:2px">Prize Won</div>
        <div style="font-size:42px;font-weight:900;color:white">${lead.prize} OFF</div>
        <div style="color:#555;font-size:11px">Code: <strong style="color:#F5C518">${lead.code}</strong></div>
      </div>
      <a href="${process.env.BASE_URL}/dashboard.html?dealer=${dealer.id}" style="color:#F5C518">View Dashboard →</a>
    </div>`
  });
}

async function sendWelcomeEmail(dealer, pin, firstQrId) {
  if (!process.env.SMTP_USER) return;
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  await transporter.sendMail({
    from: `"Spin & Win" <${process.env.SMTP_USER}>`,
    to: dealer.email,
    subject: `⚡ Welcome to Spin & Win — ${dealer.name}`,
    html: `<div style="font-family:sans-serif;max-width:560px;background:#0a0a0a;color:#f0ede6;padding:32px;border-radius:12px;">
      <h2 style="color:#F5C518">⚡ Welcome to Spin & Win!</h2>
      <p style="color:#888;margin-bottom:20px">Hi ${dealer.contact||dealer.name}, your account is ready.</p>
      <div style="background:#1a1a1a;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:20px;margin-bottom:16px;">
        <p style="margin:6px 0;font-size:13px">🏢 <strong>${dealer.name}</strong></p>
        <p style="margin:6px 0;font-size:13px">🔑 Dashboard PIN: <strong style="color:#F5C518;font-size:18px;letter-spacing:3px">${pin}</strong></p>
        <p style="margin:6px 0;font-size:11px;color:#555">Keep this PIN safe — you'll need it to access your dashboard</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
        <a href="${baseUrl}/dashboard.html?dealer=${dealer.id}" style="display:block;background:#D0021B;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:700;text-align:center">📊 Open My Dashboard →</a>
        <a href="${baseUrl}/?qr=${firstQrId}&dealer=${dealer.id}" style="display:block;background:#1a1a1a;color:#F5C518;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:700;text-align:center;border:1px solid rgba(245,197,24,.3)">🎰 Preview Spin Page →</a>
        <a href="${baseUrl}/sticker.html?qr=${firstQrId}&dealer=${dealer.id}&name=${encodeURIComponent(dealer.name)}" style="display:block;background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:700;text-align:center;border:1px solid rgba(255,255,255,.1)">🔳 Print Stickers →</a>
      </div>
      <p style="font-size:11px;color:#555">Dealer ID: ${dealer.id}<br/>Plan: ${dealer.plan}</p>
    </div>`
  });
}

async function sendCustomerEmail({name, email, prize, code, expiresAt, dealerName, stock}) {
  if (!process.env.SMTP_USER) return;
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  await transporter.sendMail({
    from: `"${dealerName} via Spin & Win" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `🎉 You won ${prize} OFF at ${dealerName}!`,
    html: `<div style="font-family:sans-serif;max-width:520px;background:#0a0a0a;color:#f0ede6;padding:32px;border-radius:12px;margin:0 auto;">
      <h2 style="color:#F5C518;margin-bottom:4px">🎉 Congratulations, ${name}!</h2>
      <p style="color:#888;margin-bottom:24px">You just won an exclusive discount at ${dealerName}.</p>
      <div style="background:#1A3A2A;border:1px solid rgba(34,197,94,.2);border-radius:10px;padding:24px;text-align:center;margin-bottom:20px;">
        <div style="color:#4ADE80;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Your Prize</div>
        <div style="font-size:52px;font-weight:900;color:#fff;line-height:1">${prize} OFF</div>
        <div style="color:#555;font-size:12px;margin-top:8px">${stock ? 'On: ' + stock : 'On your vehicle purchase'}</div>
      </div>
      <div style="background:#1a1a1a;border:1px dashed rgba(245,197,24,.3);border-radius:8px;padding:16px;text-align:center;margin-bottom:20px;">
        <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Your Redemption Code</div>
        <div style="font-size:28px;font-weight:900;color:#F5C518;letter-spacing:4px">${code}</div>
        <div style="font-size:11px;color:#555;margin-top:6px">Valid until ${new Date(expiresAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
      </div>
      <div style="background:#161616;border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:16px;font-size:13px;color:#888;">
        <strong style="color:#ccc">How to redeem:</strong><br/>
        Show this email or your redemption code to a sales representative at ${dealerName} to apply your discount.
      </div>
      <p style="font-size:10px;color:#444;margin-top:20px;text-align:center">This offer expires in 72 hours · ${dealerName}</p>
    </div>`
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hashString(str) { return crypto.createHash('sha256').update(str).digest('hex').slice(0,32); }
function hashPin(pin) { return crypto.createHash('sha256').update(pin + 'spinwin_salt').digest('hex'); }
function generatePin() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function generateCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code='';
  for(let i=0;i<8;i++){if(i===4)code+='-';code+=c[Math.floor(Math.random()*c.length)];}
  return code;
}
function rollPrize(config) {
  const prizes=[
    {amount:`$${config.amt1||100}`, weight:config.w100},
    {amount:`$${config.amt2||200}`, weight:config.w200},
    {amount:`$${config.amt3||500}`, weight:config.w500},
    {amount:`$${config.amt4||1000}`,weight:config.w1000},
  ];
  const total=prizes.reduce((s,p)=>s+p.weight,0);
  let r=Math.random()*total;
  for(const p of prizes){r-=p.weight;if(r<=0)return p.amount;}
  return prizes[0].amount;
}
function addHours(h){const d=new Date();d.setHours(d.getHours()+h);return d.toISOString().replace('T',' ').slice(0,19);}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAdmin(req,res,next){
  const token=req.headers['x-admin-token']||req.query.adminToken;
  if(!token) return res.status(401).json({error:'Unauthorized'});
  dbGet('SELECT token FROM admin_sessions WHERE token=?',[token])
    .then(row => { if(!row) return res.status(401).json({error:'Invalid session'}); next(); })
    .catch(()=>res.status(500).json({error:'Server error'}));
}

function requireDealer(req,res,next){
  const token=req.headers['x-dealer-token'];
  const dealerId=req.params.d || req.params.dealerId;
  if(!token) return res.status(401).json({error:'Dashboard login required'});
  dbGet('SELECT * FROM dealer_sessions WHERE token=? AND dealer_id=?',[token, dealerId])
    .then(row => {
      if(!row) return res.status(401).json({error:'Invalid or expired session'});
      // Expire sessions older than 7 days
      const age = Date.now() - new Date(row.created_at).getTime();
      if(age > 7*24*60*60*1000) {
        dbRun('DELETE FROM dealer_sessions WHERE token=?',[token]);
        return res.status(401).json({error:'Session expired'});
      }
      next();
    })
    .catch(()=>res.status(500).json({error:'Server error'}));
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// ─── SALESMEN APIs ────────────────────────────────────────────────────────────
app.get('/api/dashboard/:d/salesmen', requireDealer, async (req,res) => {
  try { res.json(await dbAll('SELECT * FROM salesmen WHERE dealer_id=? AND active=1 ORDER BY name',[req.params.d])); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/dashboard/:d/salesmen', requireDealer, async (req,res) => {
  try {
    const {name,email,phone}=req.body;
    if(!name||!email) return res.status(400).json({error:'Name and email required'});
    const id=uuidv4();
    await dbRun('INSERT INTO salesmen (id,dealer_id,name,email,phone) VALUES (?,?,?,?,?)',[id,req.params.d,name,email,phone||'']);
    res.json({success:true,id});
  } catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/dashboard/:d/salesmen/:sid', requireDealer, async (req,res) => {
  try {
    await dbRun('UPDATE salesmen SET active=0 WHERE id=? AND dealer_id=?',[req.params.sid,req.params.d]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});
app.patch('/api/dashboard/leads/:id/assign', async (req,res) => {
  try {
    const {salesmanId}=req.body;
    await dbRun('UPDATE leads SET assigned_to=? WHERE id=?',[salesmanId||'',req.params.id]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

// ─── DEALER PIN CHANGE ────────────────────────────────────────────────────────
app.post('/api/dealer/change-pin', requireDealer, async (req,res) => {
  try {
    const {dealerId,newPin}=req.body;
    if(!newPin||newPin.length<4) return res.status(400).json({error:'PIN must be at least 4 digits'});
    await dbRun('UPDATE dealers SET dashboard_pin=? WHERE id=?',[hashPin(newPin),dealerId]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

// Admin login
app.post('/api/admin/login', rateLimit(10, 60000), async (req,res) => {
  try {
    const {password}=req.body;
    if(!password) return res.status(400).json({error:'Password required'});
    const hash=crypto.createHash('sha256').update(password).digest('hex');
    if(hash!==ADMIN_HASH) return res.status(401).json({error:'Invalid password'});
    const token=crypto.randomBytes(32).toString('hex');
    await dbRun('INSERT INTO admin_sessions (token) VALUES (?)',[token]);
    await dbRun("DELETE FROM admin_sessions WHERE created_at < datetime('now','-24 hours')");
    res.json({token});
  } catch(e){res.status(500).json({error:e.message});}
});

// ─── DEALER DASHBOARD LOGIN (Fix #1) ─────────────────────────────────────────
app.post('/api/dealer/login', rateLimit(10, 60000), async (req,res) => {
  try {
    const {dealerId, pin} = req.body;
    if(!dealerId||!pin) return res.status(400).json({error:'Dealer ID and PIN required'});
    const dealer = await dbGet('SELECT * FROM dealers WHERE id=? AND active=1',[dealerId]);
    if(!dealer) return res.status(404).json({error:'Dealer not found'});
    const pinHash = hashPin(pin);
    if(dealer.dashboard_pin !== pinHash) return res.status(401).json({error:'Incorrect PIN'});
    const token = crypto.randomBytes(32).toString('hex');
    await dbRun('INSERT INTO dealer_sessions (token, dealer_id) VALUES (?,?)',[token, dealerId]);
    await dbRun("DELETE FROM dealer_sessions WHERE created_at < datetime('now','-7 days')");
    res.json({token, dealerName: dealer.name, plan: dealer.plan});
  } catch(e){res.status(500).json({error:e.message});}
});

// QR config (public — no auth needed, customers scan this)
app.get('/api/qr/:qrId/config', rateLimit(60, 60000), async (req,res) => {
  try {
    const qr = await dbGet(`SELECT q.*,d.name as dealer_name,d.id as dealer_id,
      d.brand_color,d.brand_logo,d.plan,p.w100,p.w200,p.w500,p.w1000,
      p.amt1,p.amt2,p.amt3,p.amt4,p.cooldown_days,p.offer_hours
      FROM qr_codes q JOIN dealers d ON d.id=q.dealer_id
      JOIN prize_config p ON p.dealer_id=d.id
      WHERE q.id=? AND q.active=1 AND d.active=1`,[req.params.qrId]);
    if(!qr) return res.status(404).json({error:'QR not found'});
    res.json({
      qrId:qr.id, dealerId:qr.dealer_id, dealerName:qr.dealer_name,
      label:qr.label, vehicle:qr.vehicle, plan:qr.plan,
      brandColor:qr.brand_color||'#D0021B', brandLogo:qr.brand_logo||'',
      prizes:{w100:qr.w100,w200:qr.w200,w500:qr.w500,w1000:qr.w1000,
              amt1:qr.amt1||100,amt2:qr.amt2||200,amt3:qr.amt3||500,amt4:qr.amt4||1000},
      cooldownDays:qr.cooldown_days, offerHours:qr.offer_hours
    });
  } catch(e){res.status(500).json({error:e.message});}
});

// Submit lead (rate limited)
app.post('/api/leads', rateLimit(30, 60000), async (req,res) => {
  try {
    const {qrId,dealerId,name,email,phone,stock,deviceFingerprint}=req.body;
    if(!qrId||!dealerId||!name||!email||!phone) return res.status(400).json({error:'Missing fields'});
    const dealer = await dbGet('SELECT * FROM dealers WHERE id=? AND active=1',[dealerId]);
    if(!dealer) return res.status(404).json({error:'Dealer not found'});
    const config = await dbGet('SELECT * FROM prize_config WHERE dealer_id=?',[dealerId]);
    const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.socket.remoteAddress||'';
    const deviceHash=hashString((deviceFingerprint||'')+ip+dealerId);
    const cooldownMs=(config.cooldown_days||30)*24*60*60*1000;
    const lock = await dbGet('SELECT spun_at FROM spin_locks WHERE device_hash=? AND dealer_id=?',[deviceHash,dealerId]);
    if(lock){
      const elapsed=Date.now()-new Date(lock.spun_at).getTime();
      if(elapsed<cooldownMs) return res.status(429).json({error:'cooldown',daysLeft:Math.ceil((cooldownMs-elapsed)/(24*60*60*1000))});
    }
    const prize=rollPrize(config); const code=generateCode();
    const id=uuidv4(); const expiresAt=addHours(config.offer_hours||72);
    await dbRun(`INSERT INTO leads (id,dealer_id,qr_id,name,email,phone,stock,prize,code,device_hash,ip_hash,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,dealerId,qrId,name,email,phone,stock||'',prize,code,deviceHash,hashString(ip),expiresAt]);
    await dbRun(`INSERT OR REPLACE INTO spin_locks (device_hash,dealer_id,spun_at) VALUES (?,?,datetime('now'))`,[deviceHash,dealerId]);
    await dbRun('UPDATE qr_codes SET scans=scans+1 WHERE id=?',[qrId]);
    sendLeadEmail(dealer,{name,email,phone,stock,prize,code,qr_id:qrId,expires_at:expiresAt},config).catch(e=>console.error('[Email]',e.message));
    sendCustomerEmail({name,email,prize,code,expiresAt,dealerName:dealer.name,stock}).catch(e=>console.error('[Customer Email]',e.message));
    res.json({success:true,prize,code,expiresAt});
  } catch(e){res.status(500).json({error:e.message});}
});

// ─── DEALER DASHBOARD APIs (now protected by requireDealer) ───────────────────
app.get('/api/dashboard/:d/leads', async (req,res) => {
  // Allow admin token as bypass
  const adminToken = req.headers['x-admin-token'];
  if (adminToken) {
    const session = await dbGet('SELECT token FROM admin_sessions WHERE token=?',[adminToken]).catch(()=>null);
    if (session) {
      try { return res.json(await dbAll('SELECT * FROM leads WHERE dealer_id=? ORDER BY created_at DESC',[req.params.d])); }
      catch(e){ return res.status(500).json({error:e.message}); }
    }
  }
  return requireDealer(req, res, async () => {
  try { res.json(await dbAll('SELECT * FROM leads WHERE dealer_id=? ORDER BY created_at DESC',[req.params.d])); }
  catch(e){res.status(500).json({error:e.message});}
  });
});
app.patch('/api/dashboard/leads/:id/status', async (req,res) => {
  try {
    const {status}=req.body;
    if(!['New','Contacted','Closed'].includes(status)) return res.status(400).json({error:'Invalid'});
    await dbRun('UPDATE leads SET status=? WHERE id=?',[status,req.params.id]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/dashboard/:d/qrcodes', requireDealer, async (req,res) => {
  try { res.json(await dbAll('SELECT * FROM qr_codes WHERE dealer_id=? ORDER BY created_at DESC',[req.params.d])); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/dashboard/:d/qrcodes', requireDealer, async (req,res) => {
  try {
    const {label,vehicle}=req.body; const dealerId=req.params.d;
    const id='QR-'+crypto.randomBytes(4).toString('hex').toUpperCase();
    await dbRun('INSERT INTO qr_codes (id,dealer_id,label,vehicle) VALUES (?,?,?,?)',[id,dealerId,label||'',vehicle||'']);
    const url=`${process.env.BASE_URL||'http://localhost:'+PORT}/?qr=${id}&dealer=${dealerId}`;
    const qrDataUrl=await QRCode.toDataURL(url,{width:400,margin:2});
    res.json({id,url,qrDataUrl});
  } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/dashboard/:d/stats', requireDealer, async (req,res) => {
  try {
    const d=req.params.d;
    const [total,newLeads,jackpots,todayLeads,prizeBreakdown,weeklyScans] = await Promise.all([
      dbGet('SELECT COUNT(*) as c FROM leads WHERE dealer_id=?',[d]),
      dbGet("SELECT COUNT(*) as c FROM leads WHERE dealer_id=? AND status='New'",[d]),
      dbGet("SELECT COUNT(*) as c FROM leads WHERE dealer_id=? AND prize LIKE '%1,000%'",[d]),
      dbGet("SELECT COUNT(*) as c FROM leads WHERE dealer_id=? AND date(created_at)=date('now')",[d]),
      dbAll('SELECT prize,COUNT(*) as count FROM leads WHERE dealer_id=? GROUP BY prize',[d]),
      dbAll("SELECT date(created_at) as day,COUNT(*) as count FROM leads WHERE dealer_id=? AND created_at>=datetime('now','-7 days') GROUP BY date(created_at) ORDER BY day",[d])
    ]);
    res.json({total:total.c,newLeads:newLeads.c,jackpots:jackpots.c,todayLeads:todayLeads.c,prizeBreakdown,weeklyScans});
  } catch(e){res.status(500).json({error:e.message});}
});
app.patch('/api/dashboard/:d/config', requireDealer, async (req,res) => {
  try {
    const {w100,w200,w500,w1000,amt1,amt2,amt3,amt4,cooldown_days,offer_hours,email,notify_emails,brand_color,brand_logo}=req.body;
    await dbRun(`UPDATE prize_config SET w100=?,w200=?,w500=?,w1000=?,amt1=?,amt2=?,amt3=?,amt4=?,cooldown_days=?,offer_hours=?,notify_emails=? WHERE dealer_id=?`,
      [w100,w200,w500,w1000,amt1||100,amt2||200,amt3||500,amt4||1000,cooldown_days,offer_hours,notify_emails||'',req.params.d]);
    if(email) await dbRun('UPDATE dealers SET email=? WHERE id=?',[email,req.params.d]);
    if(brand_color) await dbRun('UPDATE dealers SET brand_color=? WHERE id=?',[brand_color,req.params.d]);
    if(brand_logo!==undefined) await dbRun('UPDATE dealers SET brand_logo=? WHERE id=?',[brand_logo,req.params.d]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/dashboard/:d/branding', async (req,res) => {
  try {
    const dealer=await dbGet('SELECT brand_color,brand_logo,name,plan FROM dealers WHERE id=?',[req.params.d]);
    if(!dealer) return res.status(404).json({error:'Not found'});
    res.json(dealer);
  } catch(e){res.status(500).json({error:e.message});}
});

// Dealer signup
app.post('/api/dealers/signup', rateLimit(5, 60000), async (req,res) => {
  try {
    const {name,contact,email,phone,city,plan,prizes}=req.body;
    if(!name||!email) return res.status(400).json({error:'Name and email required'});
    // Generate dealer ID from their name e.g. PREMIER-AUTO-A1B2
    const nameSlug = (name||'DEALER').toUpperCase().replace(/[^A-Z0-9]/g,' ').trim().split(/\s+/).slice(0,2).join('-');
    const dealerId = nameSlug + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const firstQrId='QR-'+crypto.randomBytes(4).toString('hex').toUpperCase();
    const pin = generatePin();
    const pinHash = hashPin(pin);
    await dbRun(`INSERT INTO dealers (id,name,email,phone,plan,contact,city,status,dashboard_pin) VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealerId,name,email,phone||'',plan||'basic',contact||'',city||'','trial',pinHash]);
    const w=Array.isArray(prizes)&&prizes.length>=4?prizes:null;
    await dbRun(`INSERT INTO prize_config (dealer_id,w100,w200,w500,w1000,amt1,amt2,amt3,amt4) VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealerId,w?w[0].weight:50,w?w[1].weight:30,w?w[2].weight:15,w?w[3].weight:5,
               w?w[0].amount:100,w?w[1].amount:200,w?w[2].amount:500,w?w[3].amount:1000]);
    await dbRun(`INSERT INTO qr_codes (id,dealer_id,label) VALUES (?,?,?)`,[firstQrId,dealerId,'Main Lot']);
    const dealer = {id:dealerId,name,email,contact:contact||name,plan:plan||'basic'};
    sendWelcomeEmail(dealer, pin, firstQrId).catch(e=>console.error('[Welcome Email]',e.message));
    if(process.env.ADMIN_EMAIL && process.env.SMTP_USER){
      transporter.sendMail({
        from:`"Spin & Win" <${process.env.SMTP_USER}>`,to:process.env.ADMIN_EMAIL,
        subject:`🆕 New signup: ${name} (${plan||'basic'})`,
        html:`<p><strong>${name}</strong><br/>${email}<br/>Plan: ${plan}<br/>ID: ${dealerId}</p>`
      }).catch(()=>{});
    }
    // Create Stripe checkout session immediately
    let checkoutUrl = null;
    try {
      const priceId = STRIPE_PRICES[plan||'basic'];
      if (priceId && process.env.STRIPE_SECRET_KEY) {
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        let customerId;
        const customer = await stripe.customers.create({email,name,metadata:{dealerId}});
        customerId = customer.id;
        await dbRun('UPDATE dealers SET stripe_customer=? WHERE id=?',[customerId,dealerId]);
        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          payment_method_types:['card'],
          line_items:[{price:priceId,quantity:1}],
          mode:'subscription',
          success_url:`${baseUrl}/dashboard.html?dealer=${dealerId}&subscribed=1`,
          cancel_url:`${baseUrl}/signup.html?cancelled=1`,
          metadata:{dealerId,plan:plan||'basic'}
        });
        checkoutUrl = session.url;
      }
    } catch(e) { console.error('[Stripe Checkout]',e.message); }
    res.json({success:true,dealerId,firstQrId,checkoutUrl});
  } catch(e){res.status(500).json({error:e.message});}
});

// Stripe checkout
app.post('/api/stripe/checkout', async (req,res) => {
  try {
    const {dealerId,plan}=req.body;
    const dealer=await dbGet('SELECT * FROM dealers WHERE id=?',[dealerId]);
    if(!dealer) return res.status(404).json({error:'Dealer not found'});
    const priceId=STRIPE_PRICES[plan];
    if(!priceId) return res.status(400).json({error:'Stripe not configured. Contact support.'});
    const baseUrl=process.env.BASE_URL||`http://localhost:${PORT}`;
    let customerId=dealer.stripe_customer;
    if(!customerId){
      const customer=await stripe.customers.create({email:dealer.email,name:dealer.name,metadata:{dealerId}});
      customerId=customer.id;
      await dbRun('UPDATE dealers SET stripe_customer=? WHERE id=?',[customerId,dealerId]);
    }
    const session=await stripe.checkout.sessions.create({
      customer:customerId, payment_method_types:['card'],
      line_items:[{price:priceId,quantity:1}], mode:'subscription',
      success_url:`${baseUrl}/dashboard.html?dealer=${dealerId}&subscribed=1`,
      cancel_url:`${baseUrl}/dashboard.html?dealer=${dealerId}&cancelled=1`,
      metadata:{dealerId,plan}
    });
    res.json({url:session.url});
  } catch(e){res.status(500).json({error:e.message});}
});

// Stripe webhook
async function handleStripeWebhook(req,res){
  const sig=req.headers['stripe-signature'];
  let event;
  try{ event=stripe.webhooks.constructEvent(req.body,sig,process.env.STRIPE_WEBHOOK_SECRET||'whsec_placeholder'); }
  catch(e){ return res.status(400).send(`Webhook Error: ${e.message}`); }
  if(event.type==='checkout.session.completed'){
    const s=event.data.object;
    if(s.metadata?.dealerId){
      await dbRun('UPDATE dealers SET status=?,plan=?,stripe_sub=? WHERE id=?',
        ['active',s.metadata.plan||'basic',s.subscription,s.metadata.dealerId]);
    }
  }
  if(event.type==='customer.subscription.deleted'){
    const dealer=await dbGet('SELECT id FROM dealers WHERE stripe_sub=?',[event.data.object.id]);
    if(dealer) await dbRun("UPDATE dealers SET status='inactive' WHERE id=?",[dealer.id]);
  }
  res.json({received:true});
}

// Stripe setup
app.post('/api/stripe/setup-products', requireAdmin, async (req,res) => {
  try{
    const basic=await stripe.products.create({name:'Spin & Win — Basic',description:'Unlimited leads, full dashboard, custom prizes'});
    const basicPrice=await stripe.prices.create({product:basic.id,unit_amount:19900,currency:'usd',recurring:{interval:'month'}});
    const pro=await stripe.products.create({name:'Spin & Win — Pro',description:'Everything in Basic + custom branding, SMS alerts, multiple emails'});
    const proPrice=await stripe.prices.create({product:pro.id,unit_amount:39900,currency:'usd',recurring:{interval:'month'}});
    res.json({message:'Add to Render env vars:',STRIPE_PRICE_BASIC:basicPrice.id,STRIPE_PRICE_PRO:proPrice.id});
  } catch(e){res.status(500).json({error:e.message});}
});

// Admin APIs
app.get('/api/admin/leads', requireAdmin, async (req,res) => {
  try {
    const leads = await dbAll(`
      SELECT l.*, d.name as dealer_name
      FROM leads l JOIN dealers d ON d.id = l.dealer_id
      ORDER BY l.created_at DESC LIMIT 200
    `);
    res.json(leads);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/stats', requireAdmin, async (req,res) => {
  try {
    const [total,active,trial,leads,todayLeads,plans] = await Promise.all([
      dbGet('SELECT COUNT(*) as c FROM dealers'),
      dbGet("SELECT COUNT(*) as c FROM dealers WHERE status='active'"),
      dbGet("SELECT COUNT(*) as c FROM dealers WHERE status='trial'"),
      dbGet('SELECT COUNT(*) as c FROM leads'),
      dbGet("SELECT COUNT(*) as c FROM leads WHERE date(created_at)=date('now')"),
      dbAll("SELECT plan,COUNT(*) as count FROM dealers WHERE status='active' GROUP BY plan")
    ]);
    res.json({totalDealers:total.c,activeDealers:active.c,trialDealers:trial.c,
              totalLeads:leads.c,todayLeads:todayLeads.c,planBreakdown:plans});
  } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/admin/dealers', requireAdmin, async (req,res) => {
  try {
    res.json(await dbAll(`SELECT d.*,
      (SELECT COUNT(*) FROM leads l WHERE l.dealer_id=d.id) as lead_count,
      (SELECT COUNT(*) FROM qr_codes q WHERE q.dealer_id=d.id) as qr_count
      FROM dealers d ORDER BY d.created_at DESC`));
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/dealers', requireAdmin, async (req,res) => {
  try {
    const {name,email,phone,plan,contact,city}=req.body;
    if(!name||!email) return res.status(400).json({error:'Name and email required'});
    // Generate dealer ID from their name e.g. PREMIER-AUTO-A1B2
    const nameSlug = (name||'DEALER').toUpperCase().replace(/[^A-Z0-9]/g,' ').trim().split(/\s+/).slice(0,2).join('-');
    const dealerId = nameSlug + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const firstQrId='QR-'+crypto.randomBytes(4).toString('hex').toUpperCase();
    const pin = generatePin();
    const pinHash = hashPin(pin);
    await dbRun(`INSERT INTO dealers (id,name,email,phone,plan,contact,city,status,dashboard_pin) VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealerId,name,email,phone||'',plan||'basic',contact||'',city||'','trial',pinHash]);
    await dbRun(`INSERT INTO prize_config (dealer_id) VALUES (?)`,[dealerId]);
    await dbRun(`INSERT INTO qr_codes (id,dealer_id,label) VALUES (?,?,?)`,[firstQrId,dealerId,'Main Lot']);
    res.json({success:true,dealerId,firstQrId,pin});
  } catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/admin/dealers/:id', requireAdmin, async (req,res) => {
  try {
    const id = req.params.id;
    if (id === 'DEALER-DEMO') return res.status(400).json({error:'Cannot delete demo dealer'});
    await dbRun('UPDATE dealers SET active=0 WHERE id=?',[id]);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.patch('/api/admin/dealers/:id', requireAdmin, async (req,res) => {
  try {
    const {plan,status,email,prizes,resetPin}=req.body; const id=req.params.id;
    const u=[],v=[];
    if(plan){u.push('plan=?');v.push(plan);}
    if(status){u.push('status=?');v.push(status);}
    if(email){u.push('email=?');v.push(email);}
    let newPin = null;
    if(resetPin){
      newPin = generatePin();
      u.push('dashboard_pin=?');
      v.push(hashPin(newPin));
    }
    if(u.length){v.push(id);await dbRun(`UPDATE dealers SET ${u.join(',')} WHERE id=?`,v);}
    if(prizes&&prizes.length>=4){
      await dbRun(`UPDATE prize_config SET w100=?,w200=?,w500=?,w1000=?,amt1=?,amt2=?,amt3=?,amt4=? WHERE dealer_id=?`,
        [prizes[0].weight,prizes[1].weight,prizes[2].weight,prizes[3].weight,
         prizes[0].amount,prizes[1].amount,prizes[2].amount,prizes[3].amount,id]);
    }
    res.json({success:true, ...(newPin ? {newPin} : {})});
  } catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT, () => {
  console.log(`\n⚡ Spin & Win running at http://localhost:${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Spin:      http://localhost:${PORT}/?qr=QR-LOT-001&dealer=DEALER-DEMO`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html?dealer=DEALER-DEMO`);
  console.log(`   Admin:     http://localhost:${PORT}/admin.html\n`);
});
