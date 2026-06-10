export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
      return jsonResponse({ error: 'Missing Firebase secrets' }, corsHeaders, 500);
    }

    try {
      const projectId = env.FIREBASE_PROJECT_ID;
      const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

      if (url.pathname === '/' || url.pathname === '/health') {
        return jsonResponse({ status: 'ok', version: '1.0', project: projectId, type: 'teacher' }, corsHeaders);
      }

      if (url.pathname === '/api/debug') {
        const token = await getAccessToken(env);
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
        const res = await fetch(`${baseUrl}:runQuery`, {
          method: 'POST', headers,
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: 'teachers', allDescendants: true }],
              limit: 10,
            }
          })
        });
        const json = await res.json();
        const docs = Array.isArray(json) ? json.map(r => r.document).filter(Boolean) : [];
        return jsonResponse({
          success: true, version: '1.0', teachersFound: docs.length,
          teachers: docs.map(d => ({
            path: d.name,
            EMPLOYEE_ID: d.fields?.EMPLOYEE_ID?.stringValue || 'MISSING',
            NAME: d.fields?.NAME?.stringValue || '?',
            SCHOOL_ID: d.fields?.SCHOOL_ID?.stringValue || '?',
          }))
        }, corsHeaders);
      }

      if (url.pathname === '/verify') {
        const code = url.searchParams.get('code')?.trim();
        if (!code) return htmlResponse(errorPage('Missing ?code='), corsHeaders, 400);
        const token = await getAccessToken(env);
        const { teacher, schoolCfg } = await fetchTeacherWithSchool(env, code, token, baseUrl);
        if (!teacher) return htmlResponse(notFoundPage(code), corsHeaders, 404);
        return htmlResponse(verifiedPage(teacher, code, schoolCfg), corsHeaders);
      }

      if (url.pathname === '/api/teacher' && request.method === 'GET') {
        const code = url.searchParams.get('code')?.trim();
        if (!code) return jsonResponse({ success: false, error: 'Missing code' }, corsHeaders, 400);
        const token = await getAccessToken(env);
        const { teacher } = await fetchTeacherWithSchool(env, code, token, baseUrl);
        if (!teacher) return jsonResponse({ success: false, error: 'Not found', code }, corsHeaders, 404);
        return jsonResponse({ success: true, teacher }, corsHeaders);
      }

      if (url.pathname === '/api/teacher' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch {}
        const code = body.code?.trim();
        if (!code) return jsonResponse({ success: false, error: 'Missing code' }, corsHeaders, 400);
        const token = await getAccessToken(env);
        const { teacher } = await fetchTeacherWithSchool(env, code, token, baseUrl);
        if (!teacher) return jsonResponse({ success: false, error: 'Not found', code }, corsHeaders, 404);
        return jsonResponse({ success: true, teacher }, corsHeaders);
      }

      return htmlResponse(errorPage(
        `Route not found: <code>${sanitize(url.pathname)}</code><br><br>
        Available routes:<br>
        <code>GET /verify?code=EMPLOYEE_ID</code><br>
        <code>GET /api/teacher?code=EMPLOYEE_ID</code><br>
        <code>POST /api/teacher</code> — body: {"code":"UMSW-TCH-001"}<br>
        <code>GET /health</code><br>
        <code>GET /api/debug</code>`
      ), corsHeaders, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    }
  }
};

// ══════════════════════════════════════════════════════════════
//  FETCH TEACHER + SCHOOL CONFIG
// ══════════════════════════════════════════════════════════════
async function fetchTeacherWithSchool(env, employeeId, token, baseUrl) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const code = employeeId.trim();
  let teacher = null;
  let attempts = 0;
  let offset = 0;

  do {
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'teachers', allDescendants: true }],
        limit: 500,
      }
    };
    if (offset > 0) body.structuredQuery.offset = offset;

    const res = await fetch(`${baseUrl}:runQuery`, {
      method: 'POST', headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) { console.error('Firestore query failed:', res.status); break; }

    const results = await res.json();
    if (!Array.isArray(results)) break;

    const docs = results.filter(r => r.document);

    for (const r of docs) {
      const fields = r.document.fields;
      if (!fields) continue;
      const empId = fields.EMPLOYEE_ID?.stringValue || '';
      if (empId === code || empId.replace(/[^\w]/g,'_') === code.replace(/[^\w]/g,'_')) {
        teacher = parseFields(fields);
        break;
      }
    }

    if (teacher) break;
    if (docs.length < 500) break;
    attempts++;
    offset = attempts * 500;

  } while (attempts < 10);

  if (!teacher) return { teacher: null, schoolCfg: null };

  const schoolId = teacher.SCHOOL_ID;
  let schoolCfg = {};

  if (schoolId) {
    const safeId = schoolId.replace(/[^\w]/g, '_');

    // Try schoolSettings_teacher first (teacher-specific settings)
    try {
      const cfgRes = await fetch(`${baseUrl}/schoolSettings_teacher/${safeId}`, { headers });
      if (cfgRes.ok) {
        const cfgJson = await cfgRes.json();
        if (cfgJson.fields?.cfg?.mapValue?.fields) {
          schoolCfg = parseFields(cfgJson.fields.cfg.mapValue.fields);
        }
      }
    } catch (e) { console.warn('schoolSettings_teacher fetch failed:', e.message); }

    // Fallback to school name from schools collection
    if (!schoolCfg.schoolLine1) {
      try {
        const schRes = await fetch(`${baseUrl}/schools/${safeId}`, { headers });
        if (schRes.ok) {
          const schJson = await schRes.json();
          if (schJson.fields) {
            schoolCfg.schoolLine1 = schJson.fields.name?.stringValue || '';
          }
        }
      } catch (e) { console.warn('schools fetch failed:', e.message); }
    }
  }

  return { teacher, schoolCfg };
}

function parseFields(fields) {
  if (!fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if      (v.stringValue  !== undefined) obj[k] = v.stringValue;
    else if (v.integerValue !== undefined) obj[k] = String(v.integerValue);
    else if (v.doubleValue  !== undefined) obj[k] = String(v.doubleValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.nullValue    !== undefined) obj[k] = null;
    else if (v.arrayValue)                obj[k] = (v.arrayValue.values||[]).map(i=>Object.values(i)[0]);
    else if (v.mapValue)                  obj[k] = parseFields(v.mapValue.fields||{});
    else obj[k] = '';
  }
  return obj;
}

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════
async function getAccessToken(env) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token', iat, exp,
    scope: 'https://www.googleapis.com/auth/datastore',
  }));
  const sigInput = `${header}.${payload}`;
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----/g,'').replace(/-----END PRIVATE KEY-----/g,'').replace(/\s+/g,'');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(sigInput));
  const jwt = `${sigInput}.${base64url(new Uint8Array(sigBytes))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token failed: ' + JSON.stringify(data));
  return data.access_token;
}

function base64url(input) {
  const str = typeof input === 'string'
    ? btoa(unescape(encodeURIComponent(input)))
    : btoa(String.fromCharCode(...Array.from(input)));
  return str.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function sanitize(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function htmlResponse(html, headers={}, status=200) {
  return new Response(html, { status, headers: { 'Content-Type':'text/html;charset=UTF-8', ...headers }});
}
function jsonResponse(data, headers={}, status=200) {
  return new Response(JSON.stringify(data,null,2), { status, headers: { 'Content-Type':'application/json;charset=UTF-8', ...headers }});
}

// ══════════════════════════════════════════════════════════════
//  HTML PAGES
// ══════════════════════════════════════════════════════════════
function verifiedPage(t, code, schoolCfg) {
  const hasPhoto     = t.PHOTO && t.PHOTO.length > 10;
  const hasStamp     = schoolCfg?.stamp && schoolCfg.stamp.length > 10;
  const hasSignature = schoolCfg?.signature && schoolCfg.signature.length > 10;
  const hasLogo      = schoolCfg?.logo && schoolCfg.logo.length > 10;

  const line1 = schoolCfg?.schoolLine1 || t.SCHOOL_ID || 'SCHOOL';
  const line2 = schoolCfg?.schoolLine2 || '';
  const line3 = schoolCfg?.schoolLine3 || '';
  const line4 = schoolCfg?.schoolLine4 || '';

  const field = (label, value) => value
    ? `<div class="info-row"><span class="label">${label}</span><span class="value">${sanitize(String(value))}</span></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Verified — ${sanitize(t.NAME||'Teacher')}</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@600;700;800&family=Rajdhani:wght@400;600;700&family=Barlow+Condensed:wght@700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:'Rajdhani',sans-serif;
  background:linear-gradient(160deg,#0f3d36,#0f766e);
  min-height:100vh;
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  padding:16px;gap:0;
}
.card{
  background:#fff;
  border-radius:20px;
  width:100%;max-width:460px;
  overflow:visible;
  box-shadow:0 20px 60px rgba(0,0,0,.4);
}
/* ══ HEADER: text LEFT, logo RIGHT ══ */
.header{
  background:linear-gradient(135deg,#0f3d36,#0f766e);
  padding:16px 18px 14px;
  border-radius:20px 20px 0 0;
}
.header-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
}
.header-text{ flex:1; text-align:left; }
.school-name{
  font-family:'Barlow Condensed',sans-serif;
  font-size:19px;font-weight:900;
  color:#fff;letter-spacing:1px;
  text-transform:uppercase;line-height:1.15;
}
.school-sub{
  font-size:9.5px;color:#6ee7b7;
  margin-top:2px;line-height:1.5;
  letter-spacing:.2px;
}
.school-logo{
  width:54px;height:54px;
  border-radius:50%;
  border:2px solid rgba(255,255,255,.45);
  object-fit:contain;
  background:rgba(255,255,255,.1);
  flex-shrink:0;
}
.school-logo-ph{
  width:54px;height:54px;
  border-radius:50%;
  background:rgba(255,255,255,.15);
  border:2px solid rgba(255,255,255,.3);
  display:flex;align-items:center;justify-content:center;
  font-size:26px;flex-shrink:0;
}
.badge-row{ text-align:center; margin-top:10px; }
.badge{
  display:inline-flex;align-items:center;gap:6px;
  background:#22c55e;color:#fff;
  font-family:'Oswald',sans-serif;
  font-weight:700;font-size:12px;
  padding:5px 18px;border-radius:20px;
  letter-spacing:1px;
  animation:pop .4s ease;
  box-shadow:0 4px 14px rgba(34,197,94,.4);
}
@keyframes pop{0%{transform:scale(.5);opacity:0}100%{transform:scale(1);opacity:1}}
/* ══ BODY ══ */
.body{padding:16px 16px 12px;}
/* ══ PHOTO WRAP: stamp at bottom-right ══ */
.photo-wrap{
  position:relative;width:110px;
  margin:0 auto 22px;
}
.photo{
  width:110px;height:130px;
  object-fit:cover;border-radius:10px;
  border:3px solid #0f3d36;display:block;
}
.photo-ph{
  width:110px;height:130px;
  background:#ccfbf1;border-radius:10px;
  border:3px solid #0f3d36;
  display:flex;align-items:center;justify-content:center;font-size:52px;
}
.stamp-overlay{
  position:absolute;bottom:-14px;right:-14px;
  width:68px;height:68px;
  object-fit:contain;opacity:0.88;pointer-events:none;
  filter:drop-shadow(0 2px 6px rgba(0,0,0,.28));
  animation:stamp-drop .55s .3s cubic-bezier(.175,.885,.32,1.275) both;
}
.stamp-overlay-default{
  position:absolute;bottom:-14px;right:-14px;
  width:58px;height:58px;border-radius:50%;
  background:rgba(34,197,94,.82);border:3px solid #fff;
  display:flex;align-items:center;justify-content:center;font-size:26px;
  pointer-events:none;box-shadow:0 4px 14px rgba(34,197,94,.5);
  animation:stamp-drop .55s .3s cubic-bezier(.175,.885,.32,1.275) both;
}
@keyframes stamp-drop{0%{transform:scale(0) rotate(-20deg);opacity:0}100%{transform:scale(1) rotate(0deg);opacity:1}}
.teacher-name{
  font-family:'Barlow Condensed',sans-serif;
  font-size:24px;font-weight:900;
  color:#0f3d36;text-align:center;
  letter-spacing:1px;margin-bottom:14px;text-transform:uppercase;
}
/* ══ INFO GRID ══ */
.info-grid{display:grid;gap:5px;margin-bottom:10px;}
.info-row{
  display:grid;grid-template-columns:130px 1fr;
  background:#f0fdfa;border-radius:8px;
  padding:7px 10px;border-left:3px solid #0f766e;
}
.label{font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;}
.value{font-size:13px;font-weight:700;color:#0f3d36;word-break:break-word;}
/* ══ PRINCIPAL SIGNATURE — right aligned ══ */
.signature-block{
  display:flex;flex-direction:column;
  align-items:flex-end;
  padding:10px 10px 6px;
  border-top:1px dashed #cbd5e1;margin-top:8px;
}
.signature-img{max-height:36px;max-width:130px;object-fit:contain;display:block;margin-bottom:4px;}
.signature-line{width:130px;height:1px;background:#0f3d36;margin-bottom:4px;}
.signature-lbl{
  font-family:'Barlow Condensed',sans-serif;
  font-size:11px;font-weight:800;color:#0f3d36;
  text-transform:uppercase;letter-spacing:1px;
}
/* ══ FOOTER ══ */
.footer{
  background:#f0fdfa;padding:10px 16px;text-align:center;
  border-top:1px solid #e2e8f0;
  border-radius:0 0 20px 20px;
  font-size:10px;color:#64748b;line-height:1.6;
}
.footer strong{color:#0f3d36;}
/* ══ CREDIT ══ */
.credit{
  color:rgba(255,255,255,.5);
  font-family:'Rajdhani',sans-serif;
  font-size:10px;text-align:center;
  padding:10px 16px;width:100%;max-width:460px;
}
.credit strong{color:rgba(255,255,255,.85);}
</style>
</head>
<body>
<div class="card">

  <!-- HEADER: school text LEFT, logo RIGHT -->
  <div class="header">
    <div class="header-row">
      <div class="header-text">
        <div class="school-name">${sanitize(line1)}</div>
        ${line2 ? `<div class="school-sub">${sanitize(line2)}</div>` : ''}
        ${line3 ? `<div class="school-sub" style="opacity:.85">${sanitize(line3)}</div>` : ''}
        ${line4 ? `<div class="school-sub" style="opacity:.7">${sanitize(line4)}</div>` : ''}
      </div>
      ${hasLogo
        ? `<img src="${sanitize(schoolCfg.logo)}" class="school-logo" alt="Logo">`
        : '<div class="school-logo-ph">🏫</div>'}
    </div>
    <div class="badge-row">
      <span class="badge">✅ TEACHER IDENTITY VERIFIED</span>
    </div>
  </div>

  <div class="body">

    <!-- PHOTO: stamp at bottom-right corner -->
    <div class="photo-wrap">
      ${hasPhoto
        ? `<img src="${sanitize(t.PHOTO)}" class="photo"
             onerror="this.outerHTML='<div class=\\'photo-ph\\'>👤</div>'"
             alt="Teacher Photo">`
        : '<div class="photo-ph">👤</div>'}
      ${hasStamp
        ? `<img src="${sanitize(schoolCfg.stamp)}" class="stamp-overlay" alt="Verified Stamp">`
        : '<div class="stamp-overlay-default">✅</div>'}
    </div>

    <!-- TEACHER NAME -->
    <div class="teacher-name">${sanitize(t.NAME||'TEACHER')}</div>

    <!-- INFO FIELDS -->
    <div class="info-grid">
      ${field('Employee ID',    t.EMPLOYEE_ID||code)}
      ${field('Designation',    t.DESIGNATION)}
      ${field('Subject',        t.DEPARTMENT)}
      ${field('Blood Group',    t.BLOOD_GROUP)}
      ${field('Date of Birth',t.DATE_OF_JOINING)}
      ${field('Phone No.',      t.PHONE_NO)}
    </div>

    

  </div>

  <!-- FOOTER -->
  <div class="footer">
    Verified from <strong>${sanitize(line1)}</strong> database &nbsp;·&nbsp;
    ${new Date().toLocaleString('en-IN',{
      timeZone:'Asia/Kolkata',
      dateStyle:'medium',
      timeStyle:'short'
    })}
  </div>

</div>

<!-- CREDIT -->
<div class="credit">
  Designed by <strong>Hrishav Ranjan</strong> &nbsp;❤️&nbsp; © 2026 · Teacher ID Card Verification System
</div>

</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════
function notFoundPage(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Not Found</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:sans-serif;
  background:linear-gradient(135deg,#7f1d1d,#991b1b);
  min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:20px;gap:12px;
}
.card{
  background:#fff;border-radius:20px;
  padding:36px 28px;max-width:420px;width:100%;
  text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);
}
.icon{font-size:64px;margin-bottom:14px;}
h1{font-size:24px;font-weight:800;color:#991b1b;margin-bottom:8px;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px;}
p{font-size:13px;color:#64748b;line-height:1.6;margin-bottom:6px;}
.code-box{background:#fee2e2;padding:8px 16px;border-radius:8px;font-weight:700;color:#991b1b;font-size:15px;display:inline-block;margin:10px 0;letter-spacing:2px;}
.warning{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-top:14px;font-size:12px;color:#92400e;font-weight:600;}
.credit{color:rgba(255,255,255,.5);font-size:10px;text-align:center;font-family:sans-serif;}
.credit strong{color:rgba(255,255,255,.85);}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🔍</div>
  <h1>TEACHER NOT FOUND</h1>
  <p>No record found for employee ID:</p>
  <div class="code-box">${sanitize(code)}</div>
  <div class="warning">⚠️ This ID may be invalid, or teacher data has not been uploaded yet.</div>
</div>
<div class="credit">
  Designed by <strong>Hrishav Ranjan</strong> &nbsp;❤️&nbsp; © 2026 · Teacher ID Card Verification System
</div>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════
function errorPage(msg) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#0f172a;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:12px;}
.box{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:32px;max-width:520px;width:100%;text-align:center;}
h1{color:#ef4444;font-size:20px;margin-bottom:12px;}
p{color:#94a3b8;font-size:13px;line-height:1.7;}
code{background:#0f172a;padding:2px 7px;border-radius:4px;font-size:12px;color:#34d399;}
.credit{color:rgba(255,255,255,.3);font-size:10px;}
.credit strong{color:rgba(255,255,255,.6);}
</style>
</head>
<body>
<div class="box">
  <h1>⚠️ Error</h1>
  <p>${msg}</p>
</div>
<div class="credit">
  Designed by <strong>Hrishav Ranjan</strong> &nbsp;❤️&nbsp; © 2026 · Teacher ID Card Verification System
</div>
</body>
</html>`;
}
