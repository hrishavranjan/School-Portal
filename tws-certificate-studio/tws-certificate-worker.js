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
        return jsonResponse({ status: 'ok', version: '4.0-tws', project: projectId }, corsHeaders);
      }

      // /verify?id=SHORT_CODE   (or ?certId= for backward compatibility)
      if (url.pathname === '/verify') {
        const code = (url.searchParams.get('id') || url.searchParams.get('certId') || '').trim();
        if (!code) return htmlResponse(errorPage('Missing ?id='), corsHeaders, 400);
        const token = await getAccessToken(env);
        const { cert, schoolCfg, debug } = await fetchCertificateById(env, code, token, baseUrl);
        if (!cert) return htmlResponse(notFoundPage(code, debug), corsHeaders, 404);
        return htmlResponse(verifiedCertPage(cert, schoolCfg), corsHeaders);
      }

      if (url.pathname === '/api/certificate') {
        const code = (url.searchParams.get('id') || url.searchParams.get('certId') || '').trim();
        if (!code) return jsonResponse({ success: false, error: 'Missing id' }, corsHeaders, 400);
        const token = await getAccessToken(env);
        const { cert, schoolCfg, debug } = await fetchCertificateById(env, code, token, baseUrl);
        if (!cert) return jsonResponse({ success: false, error: 'Not found', id: code, debug }, corsHeaders, 404);
        return jsonResponse({ success: true, certificate: cert, branch: schoolCfg }, corsHeaders);
      }

      // /debug/query?id=SHORT_CODE&field=shortCode|certId  -> raw Firestore response
      if (url.pathname === '/debug/query') {
        const value = (url.searchParams.get('id') || '').trim();
        const field = (url.searchParams.get('field') || 'shortCode').trim();
        const token = await getAccessToken(env);
        const raw = await rawQuery(env, value, field, token, baseUrl);
        return jsonResponse(raw, corsHeaders);
      }

      return htmlResponse(errorPage(
        `Route not found: <code>${sanitize(url.pathname)}</code><br><br>
        Available routes:<br>
        <code>GET /verify?id=SHORT_CODE</code><br>
        <code>GET /api/certificate?id=SHORT_CODE</code><br>
        <code>GET /debug/query?id=SHORT_CODE&field=shortCode</code><br>
        <code>GET /health</code>`
      ), corsHeaders, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    }
  }
};

// ══════════════════════════════════════════════════════════════
//  FETCH CERTIFICATE (collection-group query across all branches/sessions)
//  TWS Firestore layout:
//    twsBranches/{branchId}
//    twsBranches/{branchId}/sessions/{session}/certificates/{docId}
//  Each certificate doc has: certId, shortCode, BRANCH_ID, SESSION, values, etc.
// ══════════════════════════════════════════════════════════════
async function rawQuery(env, value, field, token, baseUrl) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'certificates', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: field || 'shortCode' },
          op: 'EQUAL',
          value: { stringValue: value }
        }
      },
      limit: 1
    }
  };
  const res = await fetch(`${baseUrl}:runQuery`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

async function queryCertificateByField(fieldPath, value, token, baseUrl) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'certificates', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath },
          op: 'EQUAL',
          value: { stringValue: value }
        }
      },
      limit: 1
    }
  };
  const res = await fetch(`${baseUrl}:runQuery`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text();
    console.error('Firestore query failed:', res.status, errText);
    return { doc: null, error: { status: res.status, error: errText } };
  }
  const results = await res.json();
  if (!Array.isArray(results)) return { doc: null, error: { note: 'unexpected response shape', results } };
  const docRes = results.find(r => r.document);
  return { doc: docRes ? docRes.document : null, error: docRes ? null : { note: 'no matching document' } };
}

async function fetchCertificateById(env, code, token, baseUrl) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // QR codes carry the short 5-char code (shortCode). Fall back to the full
  // certId field so older links / manual ID entry still resolve.
  let { doc, error } = await queryCertificateByField('shortCode', code, token, baseUrl);
  if (!doc) {
    ({ doc, error } = await queryCertificateByField('certId', code, token, baseUrl));
  }
  if (!doc) return { cert: null, schoolCfg: null, debug: error };

  const cert = parseFields(doc.fields);

  // ── Fetch TWS branch config: twsBranches/{BRANCH_ID} ──
  // (fbSaveCertificate in the app stores BRANCH_ID + SESSION on every cert doc)
  let schoolCfg = {};
  const branchId = cert.BRANCH_ID;
  if (branchId) {
    const safeId = branchId.replace(/[^\w]/g, '_');
    try {
      const brRes = await fetch(`${baseUrl}/twsBranches/${safeId}`, { headers });
      if (brRes.ok) {
        const brJson = await brRes.json();
        if (brJson.fields) {
          const branch = parseFields(brJson.fields);
          schoolCfg.schoolLine1 = branch.name ? `${branch.name}${branch.code ? ' (' + branch.code + ')' : ''}` : '';
          schoolCfg.schoolLine2 = branch.line2 || '';
          schoolCfg.schoolLine3 = branch.line3 || '';
          schoolCfg.schoolLine4 = branch.line4 || '';
          if (branch.logo) schoolCfg.logo = branch.logo; // supported if you add a logo field later
        }
      }
    } catch (e) { console.warn('twsBranches fetch failed:', e.message); }

    cert._schoolName = schoolCfg.schoolLine1 || branchId;
  }

  return { cert, schoolCfg, debug: null };
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
    else if (v.arrayValue)                obj[k] = (v.arrayValue.values||[]).map(i=>parseSingle(i));
    else if (v.mapValue)                  obj[k] = parseFields(v.mapValue.fields||{});
    else obj[k] = '';
  }
  return obj;
}
function parseSingle(v){
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return v.integerValue;
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.mapValue) return parseFields(v.mapValue.fields||{});
  return null;
}

// ══════════════════════════════════════════════════════════════
//  AUTH (Firebase service account JWT -> OAuth2 access token)
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
function fmtDateVal(iso){
  if(!iso) return '';
  const d = new Date(iso+'T00:00:00');
  if (isNaN(d)) return iso;
  const dd=String(d.getDate()).padStart(2,'0');
  const mm=String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function fmtDateOrdinal(iso){
  if(!iso) return '';
  const d = new Date(iso+'T00:00:00');
  if (isNaN(d)) return iso;
  const day = d.getDate();
  const suffix = (day>=11 && day<=13) ? 'th' :
    ({1:'st',2:'nd',3:'rd'}[day%10] || 'th');
  const month = d.toLocaleString('en-US',{month:'long'});
  return `${day}${suffix} ${month} ${d.getFullYear()}`;
}

function fmtIssuedDate(ts){
  if(!ts) return '—';
  const d = new Date(Number(ts));
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});
}

// ══════════════════════════════════════════════════════════════
//  CREDIT FOOTER — shared across all HTML pages
// ══════════════════════════════════════════════════════════════
function creditFooter() {
  return `<div class="credit">
  Designed by <strong>Hrishav Ranjan</strong> &nbsp;❤️&nbsp; © 2026 · TWS Certificate Verification System
</div>`;
}
const CREDIT_CSS = `
.credit{color:rgba(255,255,255,.5);font-size:10px;text-align:center;padding:10px 16px;width:100%;max-width:520px;margin:0 auto;font-family:'Raleway',sans-serif;}
.credit strong{color:rgba(255,255,255,.85);}
`;

// ══════════════════════════════════════════════════════════════
//  FALLBACK RENDER — only used for old certificates saved before
//  certImageUrl existed (no hosted Cloudinary image to show).
// ══════════════════════════════════════════════════════════════
const ORIENTATIONS = { landscape: { w: 900, h: 636 }, portrait: { w: 636, h: 900 } };

function renderCertificateFallbackHtml(cert) {
  const snap = cert.snapshot || {};
  const orientation = snap.orientation || 'landscape';
  const dim = ORIENTATIONS[orientation] || ORIENTATIONS.landscape;
  const labels = Array.isArray(snap.labels) ? snap.labels : [];
  const values = cert.values || {};
  const templateImage = snap.templateImage || '';

  const labelDivs = labels.map(lb => {
    const st = lb.style || {};
    if (lb.type === 'image') {
      const val = values[lb.key] || '';
      const w = st.imgWidth || 100, h = st.imgHeight || 100;
      const x = st.x || 0, y = st.y || 0;
      if (!val) return '';
      return `<img src="${sanitize(val)}" style="position:absolute;left:calc(50% + ${x}px);top:${y}px;
        width:${w}px;height:${h}px;object-fit:cover;border-radius:${st.imgRound||0}px;
        transform:translate(-50%,0) scale(${(st.imgZoom||100)/100});"/>`;
    }
    let val = values[lb.key] || '';
    if (lb.type === 'date' && val) val = fmtDateVal(val);
    const x = st.x || 0, y = st.y || 0;
    const fontFamily = (st.fontFamily || "'Playfair Display',serif").replace(/"/g,"'");
    return `<div style="position:absolute;left:50%;top:${y}px;transform:translate(calc(-50% + ${x}px),0);
      font-family:${fontFamily};font-size:${st.fontSize||16}px;color:${st.color||'#1c2430'};
      font-weight:${st.bold?800:500};font-style:${st.italic?'italic':'normal'};text-align:${st.align||'center'};
      letter-spacing:${st.letterSpacing||0}px;white-space:nowrap;">${sanitize(String(val||''))}</div>`;
  }).join('');

  const idt = snap.idText || {};
  const idDiv = (idt.show!==false) ? `<div style="position:absolute;left:${12+(idt.x||0)}px;bottom:${10+(-(idt.y||0))}px;
    font-family:'Courier New',monospace;letter-spacing:.5px;font-size:${idt.fontSize||9}px;color:${idt.color||'#333'};">
    ID: ${sanitize(cert.certId)}</div>` : '';

  return `
  <div style="position:relative;width:${dim.w}px;height:${dim.h}px;max-width:100%;margin:0 auto;background:#fff;
    box-shadow:0 8px 40px rgba(0,0,0,.22);border-radius:4px;overflow:hidden;">
    ${templateImage ? `<img src="${sanitize(templateImage)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;" alt="certificate"/>` : ''}
    ${labelDivs}
    ${idDiv}
  </div>`;
}

// ══════════════════════════════════════════════════════════════
//  VERIFIED PAGE — TWS branch header (name/code/address/reg no/ESTD),
//  certificate image, "Certificate Verified" badge with category,
//  and "Issued by X on <date>" line.
// ══════════════════════════════════════════════════════════════
function verifiedCertPage(cert, schoolCfg) {
  const primaryEntry = Object.entries(cert.values || {}).find(([k]) => k.toUpperCase().includes('NAME'));
  const primaryName = (primaryEntry && primaryEntry[1]) || Object.values(cert.values || {})[0] || 'Certificate Holder';

  const line1 = schoolCfg?.schoolLine1 || cert._schoolName || cert.BRANCH_ID || 'Teachers Welfare Society';
  const line2 = schoolCfg?.schoolLine2 || ''; // city/address
  const line3 = schoolCfg?.schoolLine3 || ''; // registration no.
  const line4 = schoolCfg?.schoolLine4 || ''; // founded / ESTD
  const hasLogo = schoolCfg?.logo && String(schoolCfg.logo).length > 10;

  const hasHostedImage = cert.certImageUrl && String(cert.certImageUrl).length > 10;
  const certVisual = hasHostedImage
    ? `<img src="${sanitize(cert.certImageUrl)}" class="cert-img" alt="Certificate for ${sanitize(primaryName)}"/>`
    : renderCertificateFallbackHtml(cert);

  const issuedDate = cert.issueDate ? fmtDateOrdinal(cert.issueDate) : fmtIssuedDate(cert.createdAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>TWS Verified — ${sanitize(primaryName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;900&family=Cinzel:wght@400;700;900&family=Raleway:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#1c2430; --gold:#b8912f; --gold2:#e6c975; --navy:#0e1b33; --deep:#152238;
  --bg:#f4efe4; --bg2:#ece3d0; --panel:#fffdf8;
  --tx:#241f14; --tx2:#5a5344; --tx3:#948a72;
  --bdr:#e2d6b8; --bdr2:#d3c496;
  --grn:#127a52; --red:#c23b3b; --org:#c07d1d; --purple:#6b3fa0;
}
body{
  font-family:'Raleway',sans-serif;
  background:linear-gradient(160deg,var(--navy),var(--deep));
  min-height:100vh;display:flex;flex-direction:column;align-items:center;
  padding:22px 14px;gap:16px;
}
.card{
  background:var(--panel);border-radius:20px;width:100%;max-width:520px;overflow:hidden;
  box-shadow:0 24px 90px rgba(0,0,0,.5);border-top:5px solid var(--gold);
}

.header{background:linear-gradient(135deg,var(--navy),var(--deep));padding:18px 20px 16px;}
.header-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.header-text{flex:1;text-align:left;}
.school-name{
  font-family:'Cinzel',serif;font-size:17px;font-weight:900;color:#fff;
  letter-spacing:.6px;text-transform:uppercase;line-height:1.25;
}
.school-sub{font-size:9.5px;color:var(--gold2);margin-top:3px;line-height:1.6;letter-spacing:.2px;}
.school-logo{
  width:52px;height:52px;border-radius:50%;object-fit:contain;
  border:2px solid var(--gold);background:rgba(255,255,255,.1);flex-shrink:0;
}
.school-logo-ph{
  width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.15);
  border:2px solid var(--gold);display:flex;align-items:center;justify-content:center;
  font-size:24px;flex-shrink:0;
}
.badge-row{text-align:center;margin-top:12px;}
.badge{
  display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,#0d5c3d,var(--grn));
  color:#fff;font-family:'Cinzel',serif;font-weight:700;font-size:11.5px;padding:7px 18px;border-radius:50px;
  letter-spacing:.6px;box-shadow:0 4px 16px rgba(18,122,82,.45);
}
.badge-cat{color:var(--gold2);font-size:10.5px;font-weight:700;margin-top:6px;letter-spacing:.4px;}

.body{padding:18px;background:var(--panel);}
.cert-img{width:100%;height:auto;display:block;border-radius:10px;border:1px solid var(--bdr);box-shadow:0 8px 30px rgba(0,0,0,.15);}

.issued-line{
  background:#fff;border:1px solid var(--bdr);border-left:3px solid var(--gold);border-radius:10px;padding:12px 16px;margin-top:16px;
  font-size:12px;color:var(--tx2);text-align:center;line-height:1.6;
}
.issued-line strong{color:var(--navy);}
.verified-from{
  text-align:center;font-size:10.5px;color:var(--tx3);margin-top:8px;letter-spacing:.2px;
}
.verified-from strong{color:var(--tx2);}
${CREDIT_CSS}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="header-row">
      <div class="header-text">
        <div class="school-name">${sanitize(line1)}</div>
        ${line2 ? `<div class="school-sub">${sanitize(line2)}</div>` : ''}
        ${line3 ? `<div class="school-sub" style="opacity:.85">${sanitize(line3)}</div>` : ''}
        ${line4 ? `<div class="school-sub" style="opacity:.7">${sanitize(line4)}</div>` : ''}
      </div>
      ${hasLogo ? `<img src="${sanitize(schoolCfg.logo)}" class="school-logo" alt="Logo">` : '<div class="school-logo-ph">🏅</div>'}
    </div>
    <div class="badge-row">
      <span class="badge">✅ CERTIFICATE VERIFIED</span>
      ${cert.listName ? `<div class="badge-cat">${sanitize(cert.listName)}</div>` : ''}
    </div>
  </div>
  <div class="body">
    ${certVisual}
    <div class="issued-line">
      Issued by <strong>${sanitize(line1)}</strong> on <strong>${sanitize(issuedDate)}</strong>
    </div>
    <div class="verified-from">
      Verified from <strong>${sanitize(line1)}</strong> database &nbsp;·&nbsp; ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'long',hour:'numeric',minute:'2-digit',hour12:true})}
    </div>
  </div>
</div>
${creditFooter()}
</body>
</html>`;
}

function notFoundPage(code, debug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Not Found</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#1c2430; --gold:#b8912f; --gold2:#e6c975; --navy:#0e1b33; --deep:#152238;
  --bg:#f4efe4; --bg2:#ece3d0; --panel:#fffdf8;
  --tx:#241f14; --tx2:#5a5344; --tx3:#948a72;
  --bdr:#e2d6b8; --bdr2:#d3c496;
  --grn:#127a52; --red:#c23b3b; --org:#c07d1d; --purple:#6b3fa0;
}
body{font-family:'Raleway',sans-serif;background:linear-gradient(135deg,#7f1d1d,var(--red));min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:12px;}
.card{background:var(--panel);border-radius:20px;padding:36px 28px;max-width:460px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);border-top:5px solid var(--red);}
.icon{font-size:64px;margin-bottom:14px;}
h1{font-family:'Cinzel',serif;font-size:22px;font-weight:800;color:var(--red);margin-bottom:8px;letter-spacing:1px;}
p{font-size:13px;color:var(--tx2);line-height:1.6;margin-bottom:6px;}
.code-box{background:#fee2e2;padding:8px 16px;border-radius:8px;font-weight:700;color:var(--red);font-size:15px;display:inline-block;margin:10px 0;letter-spacing:2px;}
.warning{background:#fef3c7;border:1px solid var(--org);border-radius:8px;padding:10px 14px;margin-top:14px;font-size:12px;color:#92400e;font-weight:600;}
.credit{color:rgba(255,255,255,.5);font-size:10px;text-align:center;font-family:'Raleway',sans-serif;}
.credit strong{color:rgba(255,255,255,.85);}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🔍</div>
  <h1>CERTIFICATE NOT FOUND</h1>
  <p>No record found for certificate code:</p>
  <div class="code-box">${sanitize(code)}</div>
  <div class="warning">⚠️ This certificate code may be invalid, or the record has been removed.</div>
</div>
${creditFooter()}
</body>
</html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#1c2430; --gold:#b8912f; --gold2:#e6c975; --navy:#0e1b33; --deep:#152238;
  --bg:#f4efe4; --bg2:#ece3d0; --panel:#fffdf8;
  --tx:#241f14; --tx2:#5a5344; --tx3:#948a72;
  --bdr:#e2d6b8; --bdr2:#d3c496;
  --grn:#127a52; --red:#c23b3b; --org:#c07d1d; --purple:#6b3fa0;
}
body{font-family:'Raleway',sans-serif;background:linear-gradient(160deg,var(--navy),var(--deep));min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:12px;}
.box{background:var(--panel);border:1px solid var(--bdr);border-radius:14px;padding:32px;max-width:520px;width:100%;text-align:center;border-top:5px solid var(--gold);}
h1{font-family:'Cinzel',serif;color:var(--red);font-size:20px;margin-bottom:12px;}
p{color:var(--tx2);font-size:13px;line-height:1.7;}
code{background:var(--bg2);padding:2px 7px;border-radius:4px;font-size:12px;color:var(--navy);}
.credit{color:rgba(255,255,255,.5);font-size:10px;text-align:center;font-family:'Raleway',sans-serif;}
.credit strong{color:rgba(255,255,255,.85);}
</style>
</head>
<body>
<div class="box">
  <h1>⚠️ Configuration Error</h1>
  <p>${msg}</p>
</div>
${creditFooter()}
</body>
</html>`;
}