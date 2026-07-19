export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

    if (request.headers.get("X-Admin-Key") !== env.ADMIN_SECRET) {
      return json({ error: "Unauthorized" }, 401, cors);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, cors); }

    const { uid, newEmail } = body;
    if (!uid || !newEmail) return json({ error: "uid and newEmail required" }, 400, cors);

    try {
      const accessToken = await getGoogleAccessToken(env);
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ localId: uid, email: newEmail, emailVerified: true })
        }
      );
      const data = await res.json();
      if (!res.ok) return json({ error: data.error?.message || "Update failed" }, 400, cors);
      return json({ success: true, uid: data.localId, email: data.email }, 200, cors);
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function getGoogleAccessToken(env) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const enc = (obj) => base64url(JSON.stringify(obj));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64urlFromBuffer(signature)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(tokenData.error_description || "Token exchange failed");
  return tokenData.access_token;
}

function base64url(str) { return base64urlFromBuffer(new TextEncoder().encode(str)); }

function base64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const normalized = pem.replace(/\\n/g, "\n"); // fix literal \n from copy-paste
  const pemContents = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", binaryDer.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
}