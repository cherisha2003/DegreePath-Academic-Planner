// DegreePath Academic Planner — Express, MySQL and session-based authentication.
// Keep secrets in environment variables, never in this repository.
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const session = require('express-session');
const path = require('path');
const { setupExtras } = require('./extras');
const { recognizeHandbook, analyzeHandbook } = require('./handbook-rules');

const app = express();
const PORT = Number(process.env.PORT || 3000);
if (!process.env.DB_PASSWORD || !process.env.SESSION_SECRET) {
  console.error('Set DB_PASSWORD and SESSION_SECRET before starting DegreePath.');
  process.exit(1);
}

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'degreepath_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'degreepath_db',
  waitForConnections: true,
  connectionLimit: 10
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'degreepath.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' } // Browser-session cookie
}));

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 210000, 64, 'sha512').toString('hex');
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function responsePage(message, links = '<a href="/login.html">Login</a> · <a href="/register.html">Register</a>') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DegreePath</title><link rel="stylesheet" href="/style.css"></head><body class="auth-body"><main class="auth-card"><span class="logo-mark">◆</span><h1>DegreePath</h1><h2>${message}</h2><p>${links}</p></main></body></html>`;
}
const fail = (res, code, message) => res.status(code).json({ error: message });
const auth = (req, res, next) => req.session.user ? next() : fail(res, 401, 'Please log in to continue.');
const isId = value => /^\d+$/.test(String(value)) && Number(value) > 0;
const trim = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const validCredits = value => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 12;
const validStatus = value => ['planned', 'in_progress', 'completed'].includes(value);

// Existing users table stays intact. No duplicate users or sample accounts are created.
app.post('/register', async (req, res) => {
  const username = trim(req.body.username, 50), email = trim(req.body.email, 100);
  const password = String(req.body.password || '');
  if (!username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8)
    return res.status(400).send(responsePage('Please enter valid registration details.'));
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    await db.execute('INSERT INTO users (username,email,password_hash,password_salt,first_name,last_name) VALUES (?,?,?,?,?,?)', [username, email, hashPassword(password, salt), salt, username, '']);
    return res.send(responsePage('Your account is ready!', '<a href="/login.html">Continue to login</a>'));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).send(responsePage('Username or email already exists.'));
    console.error('Register:', err); return res.status(500).send(responsePage('Registration failed.'));
  }
});

app.post('/login', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT user_id, username, password_hash, password_salt FROM users WHERE username = ?', [trim(req.body.username, 50)]);
    const user = rows[0];
    if (!user || !user.password_hash || !user.password_salt)
      return res.status(401).send(responsePage('Incorrect username or password.'));
    const entered = Buffer.from(hashPassword(String(req.body.password || ''), user.password_salt), 'hex');
    const saved = Buffer.from(user.password_hash, 'hex');
    if (entered.length !== saved.length || !crypto.timingSafeEqual(entered, saved))
      return res.status(401).send(responsePage('Incorrect username or password.'));
    // Regenerate the session to prevent session fixation after login.
    req.session.regenerate(err => {
      if (err) return res.status(500).send(responsePage('Could not start session.'));
      req.session.user = { user_id: user.user_id, username: user.username };
      req.session.save(err2 => err2 ? res.status(500).send(responsePage('Could not save session.')) : res.redirect('/dashboard.html'));
    });
  } catch (err) { console.error('Login:', err); res.status(500).send(responsePage('Login failed.')); }
});

app.get('/logout', (req, res) => req.session.destroy(err => {
  if (err) return res.status(500).send(responsePage('Could not log out.'));
  res.clearCookie('degreepath.sid', { path: '/' });
  res.redirect('/login.html');
}));

// Only serve protected application pages when a session exists.
const protectedPages = new Set(['dashboard.html','courses.html','planner.html','requirements.html','profile.html','catalog.html','handbooks.html','schedule.html','compare.html','audit.html']);
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard.html' : '/login.html'));
app.get('/dashboard', (req,res)=>res.redirect('/dashboard.html'));
app.get('/handbook', (req,res)=>res.redirect('/handbooks.html'));
app.get('/schedule', (req,res)=>res.redirect('/schedule.html'));
app.get('/:page', (req, res, next) => {
  if (!protectedPages.has(req.params.page)) return next();
  if (!req.session.user) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', req.params.page));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// API: a user can only access their own records via their session user ID.
app.get('/api/me', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT user_id, username, email, first_name, last_name FROM users WHERE user_id=?', [req.session.user.user_id]);
    if (!rows.length) return fail(res, 404, 'Account not found.');
    res.json(rows[0]);
  } catch (err) { console.error(err); fail(res, 500, 'Unable to load profile.'); }
});
app.patch('/api/me', auth, async (req, res) => {
  const first = trim(req.body.first_name, 50), last = trim(req.body.last_name, 50);
  if (!first) return fail(res, 400, 'First name is required.');
  try {
    await db.execute('UPDATE users SET first_name=?, last_name=? WHERE user_id=?', [first, last, req.session.user.user_id]);
    res.json({ message: 'Profile updated.' });
  } catch (err) { console.error(err); fail(res, 500, 'Could not update profile.'); }
});

// Handbook-driven settings. Never silently assume a universal 36-credit M.S. degree.
app.get('/api/settings', auth, async (req, res) => {
  try {
    const uid=req.session.user.user_id;
    const [[preferences], [documents], [saved]] = await Promise.all([
      db.execute('SELECT program,degree_level,track,primary_handbook_id FROM degree_preferences WHERE user_id=?',[uid]),
      db.execute('SELECT id,filename,extracted_text FROM uploaded_handbooks WHERE user_id=? ORDER BY id DESC',[uid]),
      db.execute('SELECT degree_name,target_credits FROM degree_settings WHERE user_id=?',[uid])
    ]);
    const pref=preferences[0]||null;
    const primary=documents.find(x=>x.id===pref?.primary_handbook_id);
    const selected=primary||documents.find(x=>recognizeHandbook(x.extracted_text))||documents[0];
    const rules=selected?recognizeHandbook(selected.extracted_text):null;
    const level=pref?.degree_level||'Masters';
    const name=rules ? (level==='PhD'?'Doctor of Philosophy in Computer Science':'Master of Science in Computer Science')
      : (saved[0]?.degree_name||pref?.program||'Program not identified');
    const total=rules?(level==='PhD'?72:31):(selected?null:(saved[0]?.target_credits??null));
    res.json({degree_name:name,target_credits:total,handbook_detected:!!rules,
      handbook_name:selected?.filename||null,credit_source:rules?rules.sourceNote:null,
      source_url:rules&&level==='Masters'?'https://www.gsu.edu/program/computer-science-ms/':null});
  } catch (err) {console.error(err);fail(res,500,'Could not load handbook-derived degree settings.');}
});
// Settings for an unrecognized program may be recorded separately, but do not override
// verified rules extracted from the uploaded GSU Computer Science handbook.
app.put('/api/settings', auth, async (req,res)=>{
  try {
    const [docs]=await db.execute('SELECT extracted_text FROM uploaded_handbooks WHERE user_id=?',[req.session.user.user_id]);
    if(docs.some(d=>recognizeHandbook(d.extracted_text)))
      return fail(res,409,'Program rules come from your uploaded handbook. Edit your pathway in Compare Paths instead.');
    const name=trim(req.body.degree_name,140),target=Number(req.body.target_credits);
    if(!name||!Number.isInteger(target)||target<1||target>240)return fail(res,400,'Provide a valid program and credit target.');
    await db.execute(`INSERT INTO degree_settings (user_id,degree_name,target_credits) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE degree_name=VALUES(degree_name),target_credits=VALUES(target_credits)`,
      [req.session.user.user_id,name,target]);
    res.json({message:'Settings saved for unrecognized program.'});
  }catch(err){console.error(err);fail(res,500,'Could not save settings.');}
});

app.get('/api/courses', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, code, title, credits, semester, status, grade, category, created_at FROM courses WHERE user_id=? ORDER BY FIELD(status,\'in_progress\',\'planned\',\'completed\'), code', [req.session.user.user_id]);
    res.json(rows);
  } catch (err) { console.error(err); fail(res, 500, 'Could not load courses. Run the SQL migration.'); }
});
function parseCourse(body) {
  const code = trim(body.code, 24).toUpperCase(), title = trim(body.title, 140);
  const credits = Number(body.credits), semester = trim(body.semester, 70);
  const status = trim(body.status, 20), grade = trim(body.grade, 8), category = trim(body.category, 80);
  if (!code || !title || !validCredits(credits) || !validStatus(status) || !semester) return null;
  return {code,title,credits,semester,status,grade,category};
}
app.post('/api/courses', auth, async (req, res) => {
  const c = parseCourse(req.body);
  if (!c) return fail(res, 400, 'Provide course code, title, credits, semester and status.');
  try {
    const [result] = await db.execute('INSERT INTO courses (user_id,code,title,credits,semester,status,grade,category) VALUES (?,?,?,?,?,?,?,?)', [req.session.user.user_id,c.code,c.title,c.credits,c.semester,c.status,c.grade,c.category]);
    res.status(201).json({id:result.insertId,message:'Course added.'});
  } catch (err) { console.error(err); fail(res, 500, 'Could not add course.'); }
});
app.put('/api/courses/:id', auth, async (req, res) => {
  if (!isId(req.params.id)) return fail(res, 400, 'Invalid course ID.');
  const c = parseCourse(req.body);
  if (!c) return fail(res, 400, 'Provide valid course details.');
  try {
    const [result] = await db.execute('UPDATE courses SET code=?,title=?,credits=?,semester=?,status=?,grade=?,category=? WHERE id=? AND user_id=?', [c.code,c.title,c.credits,c.semester,c.status,c.grade,c.category,req.params.id,req.session.user.user_id]);
    if (!result.affectedRows) return fail(res,404,'Course not found.');
    res.json({message:'Course updated.'});
  } catch (err) { console.error(err); fail(res, 500, 'Could not update course.'); }
});
app.delete('/api/courses/:id', auth, async (req, res) => {
  if (!isId(req.params.id)) return fail(res,400,'Invalid course ID.');
  try {
    const [result] = await db.execute('DELETE FROM courses WHERE id=? AND user_id=?',[req.params.id, req.session.user.user_id]);
    if (!result.affectedRows) return fail(res,404,'Course not found.');
    res.json({message:'Course deleted.'});
  } catch (err) { console.error(err); fail(res,500,'Could not delete course.'); }
});

app.get('/api/requirements', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id,name,required_credits,notes FROM requirements WHERE user_id=? ORDER BY id', [req.session.user.user_id]);
    res.json(rows);
  } catch (err) { console.error(err); fail(res,500,'Could not load requirements.'); }
});
function parseRequirement(body) {
  const name = trim(body.name,100), notes = trim(body.notes,500), required = Number(body.required_credits);
  return name && Number.isFinite(required) && required > 0 && required <= 240 ? {name,notes,required} : null;
}
app.post('/api/requirements', auth, async (req,res) => {
  const r = parseRequirement(req.body); if(!r) return fail(res,400,'Enter a requirement and valid credits.');
  try {
    const [result] = await db.execute('INSERT INTO requirements (user_id,name,required_credits,notes) VALUES (?,?,?,?)',[req.session.user.user_id,r.name,r.required,r.notes]);
    res.status(201).json({id:result.insertId,message:'Requirement added.'});
  } catch (err) { console.error(err); fail(res,500,'Could not add requirement.'); }
});
app.put('/api/requirements/:id', auth, async (req,res) => {
  if(!isId(req.params.id)) return fail(res,400,'Invalid requirement ID.');
  const r = parseRequirement(req.body); if(!r) return fail(res,400,'Enter a valid requirement.');
  try {
    const [result] = await db.execute('UPDATE requirements SET name=?,required_credits=?,notes=? WHERE id=? AND user_id=?',[r.name,r.required,r.notes,req.params.id,req.session.user.user_id]);
    if(!result.affectedRows) return fail(res,404,'Requirement not found.');
    res.json({message:'Requirement updated.'});
  } catch (err) { console.error(err); fail(res,500,'Could not update requirement.'); }
});
app.delete('/api/requirements/:id', auth, async (req,res) => {
  if(!isId(req.params.id)) return fail(res,400,'Invalid requirement ID.');
  try {
    const [result] = await db.execute('DELETE FROM requirements WHERE id=? AND user_id=?',[req.params.id,req.session.user.user_id]);
    if(!result.affectedRows) return fail(res,404,'Requirement not found.');
    res.json({message:'Requirement deleted.'});
  } catch (err) { console.error(err); fail(res,500,'Could not delete requirement.'); }
});

// Additional authenticated catalog, handbook, schedule and degree-audit features.
const initializeExtras = setupExtras(app, db, auth, fail);

// Readiness check confirms both Node.js and MySQL are available.
app.get('/api/health', async (_,res) => {
  try { await db.query('SELECT 1'); res.json({status:'ok',database:'connected'}); }
  catch { fail(res,503,'Database unavailable.'); }
});
(async () => {
  try {
    await db.query('SELECT 1');
    await initializeExtras();
    console.log('Database connection established! All project tables and catalog are ready.');
    app.listen(PORT,'0.0.0.0',()=>console.log(`DegreePath running on port ${PORT}`));
  } catch (err) {
    console.error('Could not connect to MySQL:', err.message);
    process.exit(1);
  }
})();
