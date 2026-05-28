require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const Anthropic  = require('@anthropic-ai/sdk');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dgod-secret-2024';
const APP_URL    = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Anthropic (lazy init so missing key = clear 500, not crash) ──────────
let _anthropicClient = null;
function getClient() {
  if (!_anthropicClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Add it to Vercel → Settings → Environment Variables, then redeploy.');
    _anthropicClient = new Anthropic({ apiKey: key });
  }
  return _anthropicClient;
}

// ── Email transporter ─────────────────────────────
const emailReady = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS &&
  !process.env.EMAIL_PASS.includes('YOUR_GMAIL'));

const transporter = emailReady
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    })
  : null;

async function sendConfirmEmail(user, token) {
  if (!transporter) throw new Error('Email not configured in .env');
  const link = `${APP_URL}/api/auth/confirm/${token}`;
  await transporter.sendMail({
    from: `"Dallas Gangs On Diet 🤠" <${process.env.EMAIL_USER}>`,
    to:   user.email,
    subject: 'Confirm your email — Dallas Gangs On Diet',
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F2EBE0;font-family:-apple-system,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F2EBE0;padding:40px 20px">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#FFFDF8;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(44,24,16,0.10)">
        <tr>
          <td style="background:#C4714A;padding:32px;text-align:center">
            <div style="font-size:52px;margin-bottom:8px">🤠</div>
            <h1 style="margin:0;color:white;font-size:22px;font-weight:900;letter-spacing:-0.5px">Dallas Gangs On Diet</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px;text-align:center">
            <h2 style="color:#2C1810;font-size:20px;font-weight:800;margin:0 0 12px">Confirm your email</h2>
            <p style="color:#8B7355;font-size:15px;line-height:1.6;margin:0 0 28px">
              Hey <strong style="color:#2C1810">${user.username}</strong>! You're almost in.<br>
              Click the button below to confirm your email and activate your account.
            </p>
            <a href="${link}"
               style="display:inline-block;background:#C4714A;color:white;padding:15px 36px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:800;letter-spacing:0.2px">
              ✅ Confirm My Email
            </a>
            <p style="color:#B8A593;font-size:12px;margin:24px 0 0;line-height:1.6">
              This link expires in <strong>24 hours</strong>.<br>
              If you didn't create this account, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background:#F2EBE0;padding:20px;text-align:center">
            <p style="color:#B8A593;font-size:11px;margin:0">
              Or copy this link into your browser:<br>
              <a href="${link}" style="color:#C4714A;word-break:break-all;font-size:11px">${link}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
  });
}

// ── Confirmation page HTML helper ─────────────────
function confirmPage(success, title, message, showLogin = false) {
  const icon  = success ? '✅' : '❌';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — Dallas Gangs On Diet</title></head>
<body style="margin:0;padding:0;background:#F2EBE0;font-family:-apple-system,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div style="max-width:400px;width:90%;background:#FFFDF8;border-radius:20px;padding:48px 36px;text-align:center;box-shadow:0 4px 24px rgba(44,24,16,0.10)">
    <div style="font-size:56px;margin-bottom:16px">${icon}</div>
    <h2 style="color:#2C1810;font-size:22px;font-weight:900;margin:0 0 12px">${title}</h2>
    <p style="color:#8B7355;font-size:15px;line-height:1.6;margin:0 0 28px">${message}</p>
    ${showLogin ? `<a href="${APP_URL}" style="display:inline-block;background:#C4714A;color:white;padding:13px 32px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:800">Open App &amp; Login →</a>` : ''}
  </div>
</body></html>`;
}

// ══════════════════════════════════════════════════
//  STORAGE LAYER
//  MongoDB when MONGODB_URI is set (Vercel / production)
//  Local JSON files otherwise (dev — no change needed)
// ══════════════════════════════════════════════════
const USE_MONGO = !!process.env.MONGODB_URI;

// ── Local file fallback ────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!USE_MONGO && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const readJSON   = (f, d) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : d; } catch { return d; } };
const writeJSON  = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');

// ── MongoDB connection (cached across warm invocations) ───────────────────
let _db = null;
async function getDb() {
  if (_db) return _db;
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  _db = client.db('dgod');
  return _db;
}

// ── Unified async accessors ────────────────────────
// Users
async function readUsers() {
  if (USE_MONGO) {
    const db = await getDb();
    return db.collection('users').find({}, { projection: { _id: 0 } }).toArray();
  }
  return readJSON(USERS_FILE, []);
}
async function writeUsers(users) {
  if (USE_MONGO) {
    if (!users.length) return;
    const db = await getDb();
    const ops = users.map(u => ({
      replaceOne: { filter: { id: u.id }, replacement: u, upsert: true }
    }));
    await db.collection('users').bulkWrite(ops);
  } else {
    writeJSON(USERS_FILE, users);
  }
}

// Logs (per user)
async function readLogs(uid) {
  if (USE_MONGO) {
    const db = await getDb();
    const doc = await db.collection('logs').findOne({ uid });
    return doc?.entries || [];
  }
  return readJSON(path.join(DATA_DIR, `logs_${uid}.json`), []);
}
async function writeLogs(uid, entries) {
  if (USE_MONGO) {
    const db = await getDb();
    await db.collection('logs').replaceOne({ uid }, { uid, entries }, { upsert: true });
  } else {
    writeJSON(path.join(DATA_DIR, `logs_${uid}.json`), entries);
  }
}

// Burned calories (per user, keyed by date string)
async function readBurned(uid) {
  if (USE_MONGO) {
    const db = await getDb();
    const doc = await db.collection('burned').findOne({ uid });
    return doc?.data || {};
  }
  return readJSON(path.join(DATA_DIR, `burned_${uid}.json`), {});
}
async function writeBurned(uid, data) {
  if (USE_MONGO) {
    const db = await getDb();
    await db.collection('burned').replaceOne({ uid }, { uid, data }, { upsert: true });
  } else {
    writeJSON(path.join(DATA_DIR, `burned_${uid}.json`), data);
  }
}

// ── TDEE Calculator ────────────────────────────────
function calculateTargets(profile = {}) {
  const { age, gender, weight, height, activityLevel,
          goalDirection, goalAmount, goalPeriod,
          weeklyGoal } = profile;
  if (!age || !weight || !height) return null;

  const bmr  = gender === 'female'
    ? 10 * weight + 6.25 * height - 5 * age - 161
    : 10 * weight + 6.25 * height - 5 * age + 5;
  const mul  = { sedentary:1.2, light:1.375, moderate:1.55, active:1.725, very_active:1.9 };
  const tdee = Math.round(bmr * (mul[activityLevel] || 1.375));
  const suggestedBurn = Math.round(tdee - bmr);

  let dailyAdjust = 0;
  const dir = goalDirection || 'maintain';
  if (dir !== 'maintain' && goalAmount) {
    const kgPerWeek = goalPeriod === 'month' ? goalAmount / 4.33 : goalAmount;
    dailyAdjust = dir === 'lose' ? -(kgPerWeek * 7700 / 7) : (kgPerWeek * 7700 / 7);
  } else if (!goalDirection && weeklyGoal) {
    const legacyAdj = { cut:-500, cut_aggressive:-750, maintain:0, bulk:250 };
    dailyAdjust = legacyAdj[weeklyGoal] || 0;
  }

  const targetCalories = Math.max(1200, Math.round(tdee + dailyAdjust));
  return {
    tdee, bmr: Math.round(bmr), suggestedBurn, targetCalories,
    targetProtein: Math.round(weight * 2),
    targetCarbs:   Math.round(targetCalories * 0.40 / 4),
    targetFat:     Math.round(targetCalories * 0.30 / 9),
  };
}

// ── Auth middleware ────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Login required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired, please login again' }); }
}

// ── Middleware ─────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════

// ── Register ──────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const users = await readUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
      return res.status(400).json({ error: 'An account with this email already exists' });

    const confirmToken  = crypto.randomBytes(32).toString('hex');
    const autoConfirm   = !emailReady;

    const user = {
      id:                 Date.now().toString(),
      username:           username.trim(),
      email:              email.toLowerCase().trim(),
      passwordHash:       await bcrypt.hash(password, 10),
      confirmed:          autoConfirm,
      confirmToken:       autoConfirm ? null : confirmToken,
      confirmTokenExpiry: autoConfirm ? null : Date.now() + 24 * 3600 * 1000,
      createdAt:          new Date().toISOString(),
      profile: {
        age: null, gender: 'male', weight: null, height: null,
        activityLevel: 'moderate',
        goalDirection: 'maintain', goalAmount: null, goalPeriod: 'week',
        weeklyGoal: 'maintain',
        dailyTargets: { calories: 2000, protein: 150, carbs: 200, fat: 65 }
      }
    };

    users.push(user);
    await writeUsers(users);

    if (!autoConfirm) {
      try {
        await sendConfirmEmail(user, confirmToken);
        return res.json({
          pending: true, email: user.email,
          message: `Confirmation email sent to ${user.email}. Please check your inbox (and spam folder) and click the link to activate your account.`
        });
      } catch (emailErr) {
        console.error('Email send error:', emailErr.message);
        return res.status(500).json({
          error: `Account created but we couldn't send the confirmation email: ${emailErr.message}.`
        });
      }
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    const { passwordHash: _, confirmToken: __, confirmTokenExpiry: ___, ...safe } = user;
    res.json({ token, user: { ...safe, calculated: calculateTargets(user.profile) } });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Confirm email ─────────────────────────────────
app.get('/api/auth/confirm/:token', async (req, res) => {
  try {
    const users = await readUsers();
    const idx   = users.findIndex(u => u.confirmToken === req.params.token);

    if (idx === -1)
      return res.send(confirmPage(false, 'Invalid Link',
        'This confirmation link is invalid or has already been used. Please go back to the app.'));

    if (Date.now() > users[idx].confirmTokenExpiry)
      return res.send(confirmPage(false, 'Link Expired',
        'This confirmation link has expired (links are valid for 24 hours). Please register again.'));

    users[idx].confirmed          = true;
    users[idx].confirmToken       = null;
    users[idx].confirmTokenExpiry = null;
    await writeUsers(users);

    res.send(confirmPage(true, 'Email Confirmed!',
      `Welcome aboard, <strong>${users[idx].username}</strong>! 🎉<br>Your account is now active. Tap the button below to open the app and start tracking.`,
      true));
  } catch (err) { res.status(500).send(confirmPage(false, 'Error', err.message)); }
});

// ── Resend confirmation ────────────────────────────
app.post('/api/auth/resend-confirm', async (req, res) => {
  try {
    const { email } = req.body;
    const users = await readUsers();
    const idx   = users.findIndex(u => u.email.toLowerCase() === email?.toLowerCase());

    if (idx === -1) return res.status(404).json({ error: 'No account found with this email' });
    if (users[idx].confirmed) return res.status(400).json({ error: 'This account is already confirmed. Please login.' });

    const newToken = crypto.randomBytes(32).toString('hex');
    users[idx].confirmToken       = newToken;
    users[idx].confirmTokenExpiry = Date.now() + 24 * 3600 * 1000;
    await writeUsers(users);

    await sendConfirmEmail(users[idx], newToken);
    res.json({ message: `New confirmation email sent to ${email}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Forgot password ───────────────────────────────
async function sendResetEmail(user, token) {
  if (!transporter) throw new Error('Email not configured in .env');
  const link = `${APP_URL}/?reset=${token}`;
  await transporter.sendMail({
    from: `"Dallas Gangs On Diet 🤠" <${process.env.EMAIL_USER}>`,
    to:   user.email,
    subject: 'Reset your password — Dallas Gangs On Diet',
    html: `
<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F2EBE0;font-family:-apple-system,Arial,sans-serif">
  <div style="max-width:480px;margin:40px auto;background:#FFFDF8;border-radius:20px;padding:40px 36px;text-align:center;box-shadow:0 4px 24px rgba(44,24,16,0.10)">
    <div style="font-size:56px;margin-bottom:12px">🔑</div>
    <h2 style="color:#2C1810;font-size:22px;font-weight:900;margin:0 0 10px">Reset your password</h2>
    <p style="color:#8B7355;font-size:15px;line-height:1.7;margin:0 0 28px">
      Hi <strong>${user.username}</strong>, we received a request to reset your password.<br>
      Click the button below — the link expires in <strong>1 hour</strong>.
    </p>
    <a href="${link}" style="display:inline-block;background:#C4714A;color:white;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:800;letter-spacing:0.2px">
      Reset Password →
    </a>
    <p style="color:#B8A593;font-size:12px;margin:24px 0 0;line-height:1.6">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>
</body></html>`
  });
}

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const users = await readUsers();
    const idx   = users.findIndex(u => u.email.toLowerCase() === email?.toLowerCase()?.trim());
    const ok    = { message: 'If that email is registered, a reset link has been sent. Check your inbox (and spam folder).' };
    if (idx === -1) return res.json(ok);

    const token = crypto.randomBytes(32).toString('hex');
    users[idx].resetToken  = token;
    users[idx].resetExpiry = Date.now() + 3_600_000;
    await writeUsers(users);
    await sendResetEmail(users[idx], token);
    res.json(ok);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });

    const users = await readUsers();
    const idx   = users.findIndex(u => u.resetToken === token && u.resetExpiry > Date.now());
    if (idx === -1)
      return res.status(400).json({ error: 'This reset link has expired or is invalid. Please request a new one.' });

    users[idx].passwordHash = await bcrypt.hash(newPassword, 10);
    users[idx].resetToken   = null;
    users[idx].resetExpiry  = null;
    await writeUsers(users);
    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Login ─────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = await readUsers();
    const user  = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.confirmed)
      return res.status(403).json({
        error:       'Please confirm your email before logging in. Check your inbox for the confirmation link.',
        unconfirmed: true,
        email:       user.email
      });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    const { passwordHash: _, confirmToken: __, confirmTokenExpiry: ___, ...safe } = user;
    res.json({ token, user: { ...safe, calculated: calculateTargets(user.profile) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  PROFILE
// ══════════════════════════════════════════════════
app.get('/api/profile', auth, async (req, res) => {
  try {
    const users = await readUsers();
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { passwordHash: _, confirmToken: __, confirmTokenExpiry: ___, ...safe } = user;
    res.json({ ...safe, calculated: calculateTargets(user.profile) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile', auth, async (req, res) => {
  try {
    const users = await readUsers();
    const idx   = users.findIndex(u => u.id === req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx].profile = { ...users[idx].profile, ...req.body };
    await writeUsers(users);
    const { passwordHash: _, confirmToken: __, confirmTokenExpiry: ___, ...safe } = users[idx];
    res.json({ ...safe, calculated: calculateTargets(users[idx].profile) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  FOOD LOGS
// ══════════════════════════════════════════════════
app.get('/api/logs', auth, async (req, res) => {
  try { res.json(await readLogs(req.user.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/logs', auth, async (req, res) => {
  try {
    const logs  = await readLogs(req.user.id);
    const now   = new Date();
    const entry = {
      id: now.getTime().toString(), timestamp: now.toISOString(),
      date: now.toLocaleDateString('en-CA'),
      time: now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true }),
      ...req.body
    };
    logs.push(entry);
    await writeLogs(req.user.id, logs);
    res.json(entry);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/logs/:id', auth, async (req, res) => {
  try {
    const logs = await readLogs(req.user.id);
    await writeLogs(req.user.id, logs.filter(l => l.id !== req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  BURNED CALORIES
// ══════════════════════════════════════════════════
app.get('/api/burned', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toLocaleDateString('en-CA');
    const burned = await readBurned(req.user.id);
    res.json({ date, calories: burned[date] || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/burned', auth, async (req, res) => {
  try {
    const { date, calories } = req.body;
    const d      = date || new Date().toLocaleDateString('en-CA');
    const burned = await readBurned(req.user.id);
    burned[d]    = Math.max(0, Number(calories) || 0);
    await writeBurned(req.user.id, burned);
    res.json({ date: d, calories: burned[d] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  FOOD ANALYSIS
// ══════════════════════════════════════════════════
app.post('/api/analyze', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    const base64Image = req.file.buffer.toString('base64');
    const mediaType   = req.file.mimetype || 'image/jpeg';

    const response = await getClient().messages.create({
      model: 'claude-opus-4-7', max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type:'image', source:{ type:'base64', media_type:mediaType, data:base64Image } },
          { type:'text', text:`Analyze this food image. Return ONLY valid JSON, no markdown.
Fields:
- food (string): name of the food
- calories (number): total kcal for everything shown in the image
- protein (number, grams), carbs (number, grams), fat (number, grams), fiber (number, grams)
- summary (string, 1 sentence)
- confidence ("low"|"medium"|"high")
- servingUnit (string|null): the natural counting unit for THIS food if it is discretely countable — e.g. "slice" for pizza/bread/cake, "piece" for chicken pieces/wings/nuggets, "roll" for sushi, "cup" for soup/rice (if clearly portioned), "whole" for a whole item like a burger or apple. Use null for non-countable items like a mixed salad, pasta dish, or smoothie.
- servingsInImage (number): how many of the servingUnit are visible in the image (e.g. 2 if two pizza slices are shown). If servingUnit is null, set this to 1.
- ingredients (array of {name, calories, protein, carbs, fat, fiber}): breakdown per ingredient for the total shown.
- warnings (array of strings): include a short entry for EACH of the following that clearly applies to this food — artificial preservatives (nitrates/nitrites, BHA, BHT, sodium benzoate, sulfites, TBHQ), trans fats / partially hydrogenated oils, high-fructose corn syrup, artificial food dyes (Red 40, Yellow 5/6 etc.), or strongly pro-inflammatory ingredients (refined seed oils in excess, ultra-processed additives). Write each as a concise phrase e.g. "Contains nitrates — processed meat preservative" or "High in refined seed oils (pro-inflammatory)". Return [] if none apply. Be accurate — only flag genuine concerns, not general unhealthiness.` }
        ]
      }]
    });

    const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err instanceof SyntaxError ? 'Unexpected response, try again' : err.message });
  }
});

// ══════════════════════════════════════════════════
//  ADVICE
// ══════════════════════════════════════════════════
app.get('/api/advice', auth, async (req, res) => {
  try {
    const [logs, users] = await Promise.all([readLogs(req.user.id), readUsers()]);
    const user = users.find(u => u.id === req.user.id);
    const calc = calculateTargets(user?.profile || {});

    const todayStr  = new Date().toLocaleDateString('en-CA');
    const todayLogs = logs.filter(l => l.date === todayStr);
    const todayCal  = todayLogs.reduce((s,l) => s+(l.calories||0), 0);
    const todayPro  = todayLogs.reduce((s,l) => s+(l.protein||0), 0);
    const todayCarb = todayLogs.reduce((s,l) => s+(l.carbs||0), 0);
    const todayFat  = todayLogs.reduce((s,l) => s+(l.fat||0), 0);

    const burnedMap   = await readBurned(req.user.id);
    const todayBurned = burnedMap[todayStr] || calc?.suggestedBurn || 0;

    const targetCal  = user?.profile?.dailyTargets?.calories || calc?.targetCalories || 2000;
    const targetPro  = user?.profile?.dailyTargets?.protein  || calc?.targetProtein  || 150;
    const targetCarb = user?.profile?.dailyTargets?.carbs    || calc?.targetCarbs    || 200;
    const targetFat  = user?.profile?.dailyTargets?.fat      || calc?.targetFat      || 65;

    const remaining  = targetCal - todayCal;
    const bodyWeight = user?.profile?.weight || 70;
    const goalDir    = user?.profile?.goalDirection || user?.profile?.weeklyGoal || 'maintain';

    const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-7);
    const recent = logs.filter(l => new Date(l.timestamp) > cutoff);
    const weekLog = recent.length
      ? '\n\n7-DAY LOG:\n' + recent.map(l=>
          `${l.date}: ${l.food} — ${l.calories}cal | P:${l.protein}g C:${l.carbs}g F:${l.fat}g`
        ).join('\n')
      : '';

    let todayCtx = '', instruction = '';

    if (todayLogs.length > 0) {
      const needPro  = Math.max(0, targetPro  - todayPro);
      const needCarb = Math.max(0, targetCarb - todayCarb);
      const needFat  = Math.max(0, targetFat  - todayFat);

      todayCtx = `\n\nTODAY:
  Eaten: ${todayCal} kcal  (P ${todayPro}g / C ${todayCarb}g / F ${todayFat}g)
  Target: ${targetCal} kcal (P ${targetPro}g / C ${targetCarb}g / F ${targetFat}g)
  Active calories burned: ${todayBurned} kcal
  ${remaining > 0 ? `Still has ${remaining} kcal remaining` : `Over target by ${Math.abs(remaining)} kcal`}`;

      if (remaining > 100) {
        instruction = `The user still has ${remaining} kcal left for today and needs roughly: protein +${needPro}g, carbs +${needCarb}g, fat +${needFat}g. Suggest 1–2 SPECIFIC meals or snacks they could eat NOW to close the gap. Include food name, rough portion size, and estimated macros.`;
      } else if (remaining < -100) {
        instruction = `The user is ${Math.abs(remaining)} kcal OVER their daily target. Suggest a specific cardio exercise with exact duration needed to burn approximately ${Math.abs(remaining)} kcal for a ${bodyWeight}kg person. Give 1–2 options with clear details.`;
      } else {
        instruction = `The user is right on their daily calorie target — great balance! Give 2–3 sentences of positive feedback and one practical tip for tomorrow.`;
      }
    } else if (recent.length === 0) {
      return res.json({ advice: 'Start logging meals to get personalized coaching — tap the camera on the Today tab!' });
    } else {
      instruction = `The user hasn't logged any meals today yet. Give 2–3 motivating sentences and one nutrition tip based on their recent food history.`;
    }

    const prompt = `You are a friendly, knowledgeable nutrition coach. User goal: ${goalDir}. Body weight: ${bodyWeight}kg.${weekLog}${todayCtx}\n\n${instruction}\n\nRespond in a warm, motivating tone. Be specific and actionable.`;

    const response = await getClient().messages.create({
      model:'claude-opus-4-7', max_tokens:700,
      messages:[{ role:'user', content: prompt }]
    });
    res.json({ advice: response.content[0].text, status: { remaining, todayCal, targetCal } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🤠 Dallas Gangs On Diet → ${APP_URL}`);
    console.log(`💾 Storage: ${USE_MONGO ? 'MongoDB Atlas' : 'Local JSON files'}`);
    console.log(emailReady
      ? `📧 Email confirmation ON  (${process.env.EMAIL_USER})`
      : `📧 Email confirmation OFF (add EMAIL_PASS to .env to enable)\n`);
  });
}
module.exports = app;
