# ⚡ Spin & Win — Dealership QR Lead Capture System

A complete SaaS product for car dealerships. Customers scan a QR sticker on a vehicle, enter their info, and spin a prize wheel to win a discount. Leads are instantly emailed to the sales team.

---

## 📁 Project Structure

```
spinwin/
├── backend/
│   ├── server.js          ← Node.js/Express API + SQLite database
│   ├── package.json       ← Dependencies
│   └── .env.example       ← Environment variable template
│
└── public/                ← Static files served by the backend
    ├── index.html         ← Customer-facing QR landing page (spin & win)
    ├── dashboard.html     ← Dealer admin dashboard
    └── sticker.html       ← Printable QR sticker sheet
```

---

## 🚀 Quick Start (Local)

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your SMTP credentials and domain
```

### 3. Run the server
```bash
npm start
# or for auto-reload during dev:
npm run dev
```

### 4. Open in browser
- **Customer spin page:** http://localhost:3000/?qr=QR-LOT-001&dealer=DEALER-DEMO
- **Dealer dashboard:**  http://localhost:3000/dashboard.html?dealer=DEALER-DEMO
- **Print stickers:**    http://localhost:3000/sticker.html?qr=QR-LOT-001&dealer=DEALER-DEMO

---

## ☁️ Deploy to Production (Render — Free Tier)

Render is the easiest free hosting option that supports Node.js + persistent disk for SQLite.

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create spinwin --public --push
```

### Step 2 — Create a Render Web Service
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `cd backend && npm install`
   - **Start Command:** `cd backend && node server.js`
   - **Disk:** Add a disk at `/backend` (for SQLite persistence)

### Step 3 — Set Environment Variables in Render
Copy all values from `.env.example` into Render's Environment tab:
```
PORT=10000
BASE_URL=https://your-app.onrender.com
DASHBOARD_URL=https://your-app.onrender.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
```

### Step 4 — Custom Domain (Optional)
- In Render → Settings → Custom Domain → add `app.yourdomain.com`
- Point DNS CNAME to your Render URL

---

## 🌐 Alternative: Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```
Then set environment variables in the Railway dashboard.

---

## 📧 Setting Up Email (Gmail)

1. Enable 2FA on your Google account
2. Go to: https://myaccount.google.com/apppasswords
3. Create an App Password for "Mail"
4. Use that 16-character password as `SMTP_PASS`

**For higher volume, use SendGrid (free up to 100 emails/day):**
```
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
```

---

## 🔳 QR Code Workflow

1. **Create QR code** in the dashboard → QR Codes tab → "+ New QR Code"
2. Enter a label (e.g. "Lot Row B — SUVs") and optional vehicle
3. **Download the PNG** or click "Sticker PDF" to open the print page
4. Print stickers on label paper (Avery 22807 works great at 3.5" × 4")
5. Apply to vehicle windows — customers scan → spin → lead captured!

Each QR code URL looks like:
```
https://yoursite.com/?qr=QR-ABC123&dealer=DEALER-XYZ
```

---

## 💰 Business Model Suggestions

| Tier     | Price    | Features |
|----------|----------|----------|
| Starter  | $99/mo   | 1 location, unlimited QR codes, email alerts |
| Pro      | $199/mo  | 3 locations, custom branding, CSV export |
| Agency   | $499/mo  | Unlimited locations, white-label, API access |

**Onboarding flow:**
1. Sign dealer up → create their `dealer_id` in the DB
2. Generate 5–10 QR sticker sheets for their lot
3. Install takes 15 minutes — peel and stick

---

## 🔒 Security Notes for Production

- Add **JWT authentication** to all `/api/dashboard/` routes before going live
- Use **HTTPS** (Render/Railway handle this automatically)
- The server-side cooldown (hashed device fingerprint + IP) prevents abuse even if users clear localStorage
- Consider adding **Cloudflare** in front for DDoS protection on busy lots

---

## 🛠 Tech Stack

| Layer       | Tech |
|-------------|------|
| Backend     | Node.js, Express |
| Database    | SQLite (via better-sqlite3) |
| Email       | Nodemailer (SMTP) |
| QR Codes    | qrcode npm package |
| Frontend    | Vanilla HTML/CSS/JS (zero dependencies) |
| Fonts       | Google Fonts (Bebas Neue, DM Sans) |

---

## 📞 Support

Built and maintained by Spin & Win.  
Questions? Email: support@spinwinleads.com
