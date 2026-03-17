/**
 * SPIN & WIN — Backend Server
 * Node.js + Express + SQLite + Nodemailer + Stripe
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
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app  = express();
const PORT = process.env.PORT || 3000;

// Admin password hash — SHA-256 of your password
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH ||
  'b433e3d25d8b55297297fc4a7bf1e020ccb8485af87d62e1f038917ef2496cf8';

// Stripe Price IDs (created via /api/stripe/setup-products)
const STRIPE_PRICES = {
  basic: process.env.STRIPE_PRICE_BASIC || '',
  pro:   process.env.STRIPE_PRICE_PRO   || '',
};

// Stripe webhook needs raw body BEFORE express.json()
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Database
const db = new Database(process.env.DB_PATH || './spinwin.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS dealers (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT,
    contact         TEXT,
    city            TEXT,
    plan            TEXT DEFAULT 'basic',
    status          TEXT DEFAULT 'trial',
    stripe_customer TEXT,
    stripe_sub      TEXT,
    brand_color     TEXT DEFAULT '#D0021B',
    brand_logo      TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now')),
    active          INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS qr_codes (
    id          TEXT PRIMARY KEY,
    dealer_id   TEXT NOT NULL,
    label       TEXT,
    vehicle     TEXT,
    scans       INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
    dealer_id   TEXT NOT NULL,
    qr_id       TEXT NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT NOT NULL,
    stock       TEXT,
    prize       TEXT NOT NULL,
    code        TEXT UNIQUE NOT NULL,
    redeemed    INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'New',
    device_hash TEXT,
    ip_hash     TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS spin_locks (
    device_hash TEXT NOT NULL,
    dealer_id   TEXT NOT NULL,
    spun_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (device_hash, dealer_id)
  );
  CREATE TABLE IF NOT EXISTS prize_config (
    dealer_id     TEXT PRIMARY KEY,
    w100          INTEGER DEFAULT 50,
    w200          INTEGER DEFAULT 30,
    w500          INTEGER DEFAULT 15,
    w1000         INTEGER DEFAULT 5,
    amt1          INTEGER DEFAULT 100,
    amt2          INTEGER DEFAULT 200,
    amt3          INTEGER DEFAULT 500,
    amt4          INTEGER DEFAULT 1000,
    cooldown_days INTEGER DEFAULT 30,
    offer_hours   INTEGER DEFAULT 72,
    notify_emails TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed demo dealer
if (!db.prepare('SELECT id FROM dealers WHERE id=?').get('DEALER-DEMO')) {
  db.prepare(`INSERT INTO dealers (id,name,email,phone,plan,status) VALUES (?,?,?,?,?,?)`)
    .run('DEALER-DEMO','Premier Auto Group',process.env.DEMO_SALES_EMAIL||'sales@example.com','(602) 555-0100','pro','active');
  db.prepare(`INSERT INTO prize_config (dealer_id) VALUES (?)`).run('DEALER-DEMO');
  ['QR-LOT-001','QR-LOT-002','QR-LOT-003'].forEach((qid,i) => {
    const labels=['Lot Row A','Lot Row B — SUVs','Lot Row C — Trucks'];
    db.prepare(`INSERT OR IGNORE INTO qr_codes (id,dealer_id,label) VALUES (?,?,?)`).run(qid,'DEALER-DEMO',labels[i]);
  });
}

// Email
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

// Helpers
function hashString(str) { return crypto.createHash('sha256').update(str).digest('hex').slice(0,32); }
function generateCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code='';
  for(let i=0;i<8;i++){if(i===4)code+='-';code+=chars[Math.floor(Math.random()*chars.length)];}
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

// Admin auth middleware
function requireAdmin(req,res,next){
  const token=req.headers['x-admin-token']||req.query.adminToken;
  if(!token) return res.status(401).json({error:'Unauthorized'});
  const session=db.prepare('SELECT token FROM admin_sessions WHERE token=?').get(token);
  if(!session) return res.status(401).json({error:'Invalid session'});
  next();
}

// === ROUTES ===

// Admin login
app.post('/api/admin/login',(req,res)=>{
  const {password}=req.body;
  if(!password) return res.status(400).json({error:'Password required'});
  const hash=crypto.createHash('sha256').update(password).digest('hex');
  if(hash!==ADMIN_HASH) return res.status(401).json({error:'Invalid password'});
  const token=crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO admin_sessions (token) VALUES (?)').run(token);
  db.prepare("DELETE FROM admin_sessions WHERE created_at < datetime('now','-24 hours')").run();
  res.json({token});
});

// QR config (public)
app.get('/api/qr/:qrId/config',(req,res)=>{
  const qr=db.prepare(`SELECT q.*,d.name as dealer_name,d.id as dealer_id,d.brand_color,d.brand_logo,d.plan,
    p.w100,p.w200,p.w500,p.w1000,p.amt1,p.amt2,p.amt3,p.amt4,p.cooldown_days,p.offer_hours
    FROM qr_codes q JOIN dealers d ON d.id=q.dealer_id JOIN prize_config p ON p.dealer_id=d.id
    WHERE q.id=? AND q.active=1 AND d.active=1`).get(req.params.qrId);
  if(!qr) return res.status(404).json({error:'QR not found'});
  res.json({
    qrId:qr.id, dealerId:qr.dealer_id, dealerName:qr.dealer_name,
    label:qr.label, vehicle:qr.vehicle, plan:qr.plan,
    brandColor:qr.brand_color||'#D0021B', brandLogo:qr.brand_logo||'',
    prizes:{w100:qr.w100,w200:qr.w200,w500:qr.w500,w1000:qr.w1000,
            amt1:qr.amt1||100,amt2:qr.amt2||200,amt3:qr.amt3||500,amt4:qr.amt4||1000},
    cooldownDays:qr.cooldown_days, offerHours:qr.offer_hours
  });
});

// Submit lead
app.post('/api/leads',async(req,res)=>{
  const {qrId,dealerId,name,email,phone,stock,deviceFingerprint}=req.body;
  if(!qrId||!dealerId||!name||!email||!phone) return res.status(400).json({error:'Missing fields'});
  const dealer=db.prepare('SELECT * FROM dealers WHERE id=? AND active=1').get(dealerId);
  if(!dealer) return res.status(404).json({error:'Dealer not found'});
  const config=db.prepare('SELECT * FROM prize_config WHERE dealer_id=?').get(dealerId);
  const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.socket.remoteAddress||'';
  const deviceHash=hashString((deviceFingerprint||'')+ip+dealerId);
  const cooldownMs=(config.cooldown_days||30)*24*60*60*1000;
  const lock=db.prepare('SELECT spun_at FROM spin_locks WHERE device_hash=? AND dealer_id=?').get(deviceHash,dealerId);
  if(lock){
    const elapsed=Date.now()-new Date(lock.spun_at).getTime();
    if(elapsed<cooldownMs) return res.status(429).json({error:'cooldown',daysLeft:Math.ceil((cooldownMs-elapsed)/(24*60*60*1000))});
  }
  const prize=rollPrize(config); const code=generateCode(); const id=uuidv4();
  const expiresAt=addHours(config.offer_hours||72);
  db.prepare(`INSERT INTO leads (id,dealer_id,qr_id,name,email,phone,stock,prize,code,device_hash,ip_hash,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,dealerId,qrId,name,email,phone,stock||'',prize,code,deviceHash,hashString(ip),expiresAt);
  db.prepare(`INSERT OR REPLACE INTO spin_locks (device_hash,dealer_id,spun_at) VALUES (?,?,datetime('now'))`).run(deviceHash,dealerId);
  db.prepare('UPDATE qr_codes SET scans=scans+1 WHERE id=?').run(qrId);
  sendLeadEmail(dealer,{name,email,phone,stock,prize,code,qr_id:qrId,expires_at:expiresAt},config).catch(e=>console.error('[Email]',e.message));
  res.json({success:true,prize,code,expiresAt});
});

// Dashboard APIs
app.get('/api/dashboard/:d/leads',(req,res)=>{
  res.json(db.prepare('SELECT * FROM leads WHERE dealer_id=? ORDER BY created_at DESC').all(req.params.d));
});
app.patch('/api/dashboard/leads/:id/status',(req,res)=>{
  const {status}=req.body;
  if(!['New','Contacted','Closed'].includes(status)) return res.status(400).json({error:'Invalid'});
  db.prepare('UPDATE leads SET status=? WHERE id=?').run(status,req.params.id);
  res.json({success:true});
});
app.get('/api/dashboard/:d/qrcodes',(req,res)=>{
  res.json(db.prepare('SELECT * FROM qr_codes WHERE dealer_id=? ORDER BY created_at DESC').all(req.params.d));
});
app.post('/api/dashboard/:d/qrcodes',async(req,res)=>{
  const {label,vehicle}=req.body; const dealerId=req.params.d;
  const id='QR-'+crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('INSERT INTO qr_codes (id,dealer_id,label,vehicle) VALUES (?,?,?,?)').run(id,dealerId,label||'',vehicle||'');
  const url=`${process.env.BASE_URL||'http://localhost:'+PORT}/?qr=${id}&dealer=${dealerId}`;
  const qrDataUrl=await QRCode.toDataURL(url,{width:400,margin:2});
  res.json({id,url,qrDataUrl});
});
app.get('/api/dashboard/:d/stats',(req,res)=>{
  const d=req.params.d;
  res.json({
    total:      db.prepare('SELECT COUNT(*) as c FROM leads WHERE dealer_id=?').get(d).c,
    newLeads:   db.prepare("SELECT COUNT(*) as c FROM leads WHERE dealer_id=? AND status='New'").get(d).c,
    jackpots:   db.prepare("SELECT COUNT(*) as c FROM leads WHERE dealer_id=? AND prize LIKE '%1,000%'").get(d).c,
    todayLeads: db.prepare("SELECT COUNT(*) as c FROM leads WHERE dealer_id=? AND date(created_at)=date('now')").get(d).c,
    prizeBreakdown: db.prepare('SELECT prize,COUNT(*) as count FROM leads WHERE dealer_id=? GROUP BY prize').all(d),
    weeklyScans: db.prepare("SELECT date(created_at) as day,COUNT(*) as count FROM leads WHERE dealer_id=? AND created_at>=datetime('now','-7 days') GROUP BY date(created_at) ORDER BY day").all(d)
  });
});
app.patch('/api/dashboard/:d/config',(req,res)=>{
  const {w100,w200,w500,w1000,amt1,amt2,amt3,amt4,cooldown_days,offer_hours,email,notify_emails,brand_color,brand_logo}=req.body;
  db.prepare(`UPDATE prize_config SET w100=?,w200=?,w500=?,w1000=?,amt1=?,amt2=?,amt3=?,amt4=?,cooldown_days=?,offer_hours=?,notify_emails=? WHERE dealer_id=?`)
    .run(w100,w200,w500,w1000,amt1||100,amt2||200,amt3||500,amt4||1000,cooldown_days,offer_hours,notify_emails||'',req.params.d);
  if(email)       db.prepare('UPDATE dealers SET email=? WHERE id=?').run(email,req.params.d);
  if(brand_color) db.prepare('UPDATE dealers SET brand_color=? WHERE id=?').run(brand_color,req.params.d);
  if(brand_logo !== undefined) db.prepare('UPDATE dealers SET brand_logo=? WHERE id=?').run(brand_logo,req.params.d);
  res.json({success:true});
});
app.get('/api/dashboard/:d/branding',(req,res)=>{
  const dealer=db.prepare('SELECT brand_color,brand_logo,name,plan FROM dealers WHERE id=?').get(req.params.d);
  if(!dealer) return res.status(404).json({error:'Not found'});
  res.json(dealer);
});

// Dealer signup
app.post('/api/dealers/signup',async(req,res)=>{
  const {name,contact,email,phone,city,plan,prizes}=req.body;
  if(!name||!email) return res.status(400).json({error:'Name and email required'});
  const dealerId='DEALER-'+crypto.randomBytes(4).toString('hex').toUpperCase();
  const firstQrId='QR-'+crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare(`INSERT INTO dealers (id,name,email,phone,plan,contact,city,status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(dealerId,name,email,phone||'',plan||'basic',contact||'',city||'','trial');
  const w=Array.isArray(prizes)&&prizes.length>=4?prizes:null;
  db.prepare(`INSERT INTO prize_config (dealer_id,w100,w200,w500,w1000,amt1,amt2,amt3,amt4) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(dealerId,w?w[0].weight:50,w?w[1].weight:30,w?w[2].weight:15,w?w[3].weight:5,
         w?w[0].amount:100,w?w[1].amount:200,w?w[2].amount:500,w?w[3].amount:1000);
  db.prepare(`INSERT INTO qr_codes (id,dealer_id,label) VALUES (?,?,?)`).run(firstQrId,dealerId,'Main Lot');
  const baseUrl=process.env.BASE_URL||`http://localhost:${PORT}`;
  if(process.env.SMTP_USER){
    transporter.sendMail({
      from:`"Spin & Win" <${process.env.SMTP_USER}>`,to:email,
      subject:`⚡ Welcome to Spin & Win — ${name}`,
      html:`<div style="font-family:sans-serif;background:#0a0a0a;color:#f0ede6;padding:32px;border-radius:12px;max-width:560px">
        <h2 style="color:#F5C518">⚡ Welcome to Spin & Win!</h2>
        <p style="color:#888">Hi ${contact||name}, your account is ready.</p>
        <p style="margin:12px 0">Dealer ID: <strong style="color:#F5C518">${dealerId}</strong></p>
        <a href="${baseUrl}/dashboard.html?dealer=${dealerId}" style="display:inline-block;background:#D0021B;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700">Open My Dashboard →</a>
        <p style="font-size:11px;color:#555;margin-top:16px">Spin page: ${baseUrl}/?qr=${firstQrId}&dealer=${dealerId}</p>
      </div>`
    }).catch(e=>console.error('[Welcome Email]',e.message));
    if(process.env.ADMIN_EMAIL){
      transporter.sendMail({from:`"Spin & Win" <${process.env.SMTP_USER}>`,to:process.env.ADMIN_EMAIL,
        subject:`🆕 New signup: ${name} (${plan||'basic'})`,
        html:`<p><strong>${name}</strong><br/>${email}<br/>Plan: ${plan}<br/>ID: ${dealerId}</p>`
      }).catch(()=>{});
    }
  }
  res.json({success:true,dealerId,firstQrId});
});

// Stripe checkout
app.post('/api/stripe/checkout',async(req,res)=>{
  const {dealerId,plan}=req.body;
  const dealer=db.prepare('SELECT * FROM dealers WHERE id=?').get(dealerId);
  if(!dealer) return res.status(404).json({error:'Dealer not found'});
  const priceId=STRIPE_PRICES[plan];
  if(!priceId) return res.status(400).json({error:'Stripe not configured yet. Run /api/stripe/setup-products first.'});
  const baseUrl=process.env.BASE_URL||`http://localhost:${PORT}`;
  try {
    let customerId=dealer.stripe_customer;
    if(!customerId){
      const customer=await stripe.customers.create({email:dealer.email,name:dealer.name,metadata:{dealerId}});
      customerId=customer.id;
      db.prepare('UPDATE dealers SET stripe_customer=? WHERE id=?').run(customerId,dealerId);
    }
    const session=await stripe.checkout.sessions.create({
      customer:customerId, payment_method_types:['card'],
      line_items:[{price:priceId,quantity:1}], mode:'subscription',
      success_url:`${baseUrl}/dashboard.html?dealer=${dealerId}&subscribed=1`,
      cancel_url:`${baseUrl}/dashboard.html?dealer=${dealerId}&cancelled=1`,
      metadata:{dealerId,plan}
    });
    res.json({url:session.url});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Stripe webhook
async function handleStripeWebhook(req,res){
  const sig=req.headers['stripe-signature'];
  let event;
  try{ event=stripe.webhooks.constructEvent(req.body,sig,process.env.STRIPE_WEBHOOK_SECRET||''); }
  catch(e){ return res.status(400).send(`Webhook Error: ${e.message}`); }
  if(event.type==='checkout.session.completed'){
    const s=event.data.object;
    if(s.metadata?.dealerId){
      db.prepare('UPDATE dealers SET status=?,plan=?,stripe_sub=? WHERE id=?')
        .run('active',s.metadata.plan||'basic',s.subscription,s.metadata.dealerId);
    }
  }
  if(event.type==='customer.subscription.deleted'){
    const dealer=db.prepare('SELECT id FROM dealers WHERE stripe_sub=?').get(event.data.object.id);
    if(dealer) db.prepare("UPDATE dealers SET status='inactive' WHERE id=?").run(dealer.id);
  }
  res.json({received:true});
}

// Stripe setup (creates products + prices in Stripe — run once)
app.post('/api/stripe/setup-products',requireAdmin,async(req,res)=>{
  try{
    const basic=await stripe.products.create({name:'Spin & Win — Basic',description:'Unlimited leads, full dashboard, custom prizes'});
    const basicPrice=await stripe.prices.create({product:basic.id,unit_amount:19900,currency:'usd',recurring:{interval:'month'}});
    const pro=await stripe.products.create({name:'Spin & Win — Pro',description:'Everything in Basic + custom branding, SMS alerts, multiple emails'});
    const proPrice=await stripe.prices.create({product:pro.id,unit_amount:39900,currency:'usd',recurring:{interval:'month'}});
    res.json({
      message:'Products created! Add these to your Render environment variables and redeploy:',
      STRIPE_PRICE_BASIC:basicPrice.id,
      STRIPE_PRICE_PRO:proPrice.id
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Admin APIs
app.get('/api/admin/stats',requireAdmin,(req,res)=>{
  res.json({
    totalDealers:  db.prepare('SELECT COUNT(*) as c FROM dealers').get().c,
    activeDealers: db.prepare("SELECT COUNT(*) as c FROM dealers WHERE status='active'").get().c,
    trialDealers:  db.prepare("SELECT COUNT(*) as c FROM dealers WHERE status='trial'").get().c,
    totalLeads:    db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
    todayLeads:    db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at)=date('now')").get().c,
    planBreakdown: db.prepare("SELECT plan,COUNT(*) as count FROM dealers WHERE status='active' GROUP BY plan").all()
  });
});
app.get('/api/admin/dealers',requireAdmin,(req,res)=>{
  res.json(db.prepare(`SELECT d.*,
    (SELECT COUNT(*) FROM leads l WHERE l.dealer_id=d.id) as lead_count,
    (SELECT COUNT(*) FROM qr_codes q WHERE q.dealer_id=d.id) as qr_count
    FROM dealers d ORDER BY d.created_at DESC`).all());
});
app.post('/api/admin/dealers',requireAdmin,(req,res)=>{
  const {name,email,phone,plan,contact,city}=req.body;
  if(!name||!email) return res.status(400).json({error:'Name and email required'});
  const dealerId='DEALER-'+crypto.randomBytes(4).toString('hex').toUpperCase();
  const firstQrId='QR-'+crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare(`INSERT INTO dealers (id,name,email,phone,plan,contact,city,status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(dealerId,name,email,phone||'',plan||'basic',contact||'',city||'','trial');
  db.prepare(`INSERT INTO prize_config (dealer_id) VALUES (?)`).run(dealerId);
  db.prepare(`INSERT INTO qr_codes (id,dealer_id,label) VALUES (?,?,?)`).run(firstQrId,dealerId,'Main Lot');
  res.json({success:true,dealerId,firstQrId});
});
app.patch('/api/admin/dealers/:id',requireAdmin,(req,res)=>{
  const {plan,status,email,prizes}=req.body; const id=req.params.id;
  const u=[],v=[];
  if(plan){u.push('plan=?');v.push(plan);}
  if(status){u.push('status=?');v.push(status);}
  if(email){u.push('email=?');v.push(email);}
  if(u.length){v.push(id);db.prepare(`UPDATE dealers SET ${u.join(',')} WHERE id=?`).run(...v);}
  if(prizes&&prizes.length>=4){
    db.prepare(`UPDATE prize_config SET w100=?,w200=?,w500=?,w1000=?,amt1=?,amt2=?,amt3=?,amt4=? WHERE dealer_id=?`)
      .run(prizes[0].weight,prizes[1].weight,prizes[2].weight,prizes[3].weight,
           prizes[0].amount,prizes[1].amount,prizes[2].amount,prizes[3].amount,id);
  }
  res.json({success:true});
});

app.listen(PORT,()=>{
  console.log(`\n⚡ Spin & Win running at http://localhost:${PORT}`);
  console.log(`   Spin:      http://localhost:${PORT}/?qr=QR-LOT-001&dealer=DEALER-DEMO`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html?dealer=DEALER-DEMO`);
  console.log(`   Admin:     http://localhost:${PORT}/admin.html\n`);
});
