require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const path    = require("path");
const fs      = require("fs");

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Serve the HTML file explicitly — works regardless of working directory
app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "community-publisher-agent (2).html");
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send("community-publisher-agent (2).html not found. Make sure it's in the same folder as server.js.");
  }
});

app.get("/community-publisher-agent.html", (req, res) => {
  res.sendFile(path.join(__dirname, "community-publisher-agent (2).html"));
});

// ── AI provider setup ─────────────────────────────────────────────────────────
const crypto = require("crypto");

const AI_KEY      = process.env.ANTHROPIC_API_KEY;
const AI_ENABLED  = !!(AI_KEY && !AI_KEY.includes("paste-your-key"));

const VERTEX_SA   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const VERTEX_PROJ = process.env.GOOGLE_PROJECT_ID;
const VERTEX_LOC  = process.env.VERTEX_LOCATION || "us-central1";
const VERTEX_MODEL= process.env.VERTEX_MODEL    || "gemini-1.5-flash";
const VERTEX_ENABLED = !!(VERTEX_SA && VERTEX_PROJ);

// Token cache for Vertex AI (1-hour tokens)
let _vtok = { token: null, exp: 0 };
async function vertexToken() {
  if (_vtok.token && Date.now() < _vtok.exp) return _vtok.token;
  const creds = JSON.parse(VERTEX_SA);
  const now   = Math.floor(Date.now() / 1000);
  const hdr   = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const pay   = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud:  "https://oauth2.googleapis.com/token",
    iat:  now, exp: now + 3600
  })).toString("base64url");
  const sig = crypto.createSign("RSA-SHA256").update(`${hdr}.${pay}`).sign(creds.private_key, "base64url");
  const jwt = `${hdr}.${pay}.${sig}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion:jwt })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Vertex auth failed: ${JSON.stringify(d)}`);
  _vtok = { token: d.access_token, exp: Date.now() + 3500000 };
  console.log("✅ Vertex AI token refreshed");
  return _vtok.token;
}

async function generateWithVertex(userContent) {
  const token = await vertexToken();
  const url = `https://${VERTEX_LOC}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJ}/locations/${VERTEX_LOC}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
  const r = await fetch(url, {
    method:"POST",
    headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      contents:[{ role:"user", parts:[{ text: userContent }] }],
      generationConfig:{ maxOutputTokens:1500, temperature:0.7 }
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function generateWithAnthropic(userContent) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{ "x-api-key":AI_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json" },
    body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:1500,
      messages:[{ role:"user", content: userContent }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
  return d.content?.[0]?.text || "";
}

app.get("/health", (_, res) => res.json({
  status:"ok", port:PORT,
  ai: VERTEX_ENABLED ? "vertex" : AI_ENABLED ? "anthropic" : "disabled"
}));

// ── shared generate helper ────────────────────────────────────────────────────
async function runGenerate(prompt, url) {
  if (!VERTEX_ENABLED && !AI_ENABLED) throw new Error("No AI provider configured. Add GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_PROJECT_ID or ANTHROPIC_API_KEY.");
  const instruction = "Line 1 = plain title (no # prefix). Then 4–6 paragraphs. Plain text, no markdown. 400–600 words. Practical and educational.";
  let content;
  if (url) {
    const pageRes = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0 (compatible; CommunityPublisher/1.0)" } });
    const html = await pageRes.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
      .replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&")
      .replace(/\s+/g," ").trim().substring(0, 6000);
    content = `Based on this content from ${url}:\n\n${text}\n\n${prompt || "Write a community article summarising the key insights."}\n\n${instruction}`;
    console.log(`→ generate from URL (${text.length} chars)`);
  } else {
    content = `Write a community article about: ${prompt}. ${instruction}`;
    console.log(`→ generate: "${prompt.substring(0,60)}"`);
  }
  const raw = VERTEX_ENABLED ? await generateWithVertex(content) : await generateWithAnthropic(content);
  const lines = raw.trim().split("\n").filter(l => l.trim());
  const title = lines[0].replace(/^[#*\s]+/,"").trim();
  const body  = lines.slice(1).join("\n\n").trim();
  console.log(`← generate done: "${title.substring(0,50)}"`);
  return { title, body };
}

// ── POST /proxy/generate ──────────────────────────────────────────────────────
app.post("/proxy/generate", async (req, res) => {
  const { prompt, url } = req.body;
  if (!prompt && !url) return res.status(400).json({ error: "prompt or url required" });
  try {
    res.json(await runGenerate(prompt, url));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /proxy/token ─────────────────────────────────────────────────────────
app.post("/proxy/token", async (req, res) => {
  const { region, client_id, client_secret } = req.body;
  if (!region || !client_id || !client_secret)
    return res.status(400).json({ error: "region, client_id and client_secret required" });
  try {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret, scope: "read write" });
    const r = await fetch(`${region}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    console.log(`✅ Token issued for client_id=${client_id.substring(0,8)}… token=${data.access_token ? data.access_token.substring(0,20)+"…" : "none"}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/me ─────────────────────────────────────────────────────────────
app.get("/proxy/me", async (req, res) => {
  const { region } = req.query;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!region || !token) return res.status(400).json({ error: "region and Authorization header required" });
  try {
    const r = await fetch(`${region}/v2/user/me`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await r.text();
    console.log("← /v2/user/me", r.status, text.substring(0, 300));
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /proxy/translate (MyMemory — free, no key needed) ───────────────────
const LANG_CODES = {
  "French": "fr", "Spanish": "es", "German": "de",
  "Portuguese (Brazilian)": "pt-BR", "Japanese": "ja",
  "Korean": "ko", "Simplified Chinese": "zh-CN",
};

async function myMemoryTranslate(text, langCode) {
  // Split into chunks ≤ 490 chars on paragraph or sentence boundaries
  const chunks = [];
  const paragraphs = text.split(/\n+/);
  let current = "";
  for (const para of paragraphs) {
    const line = para.trim();
    if (!line) { current += "\n\n"; continue; }
    if ((current + line).length > 490) {
      if (current.trim()) chunks.push(current.trim());
      current = line + "\n\n";
    } else {
      current += line + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const translated = [];
  for (const chunk of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${langCode}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.responseStatus !== 200) throw new Error(`MyMemory error: ${d.responseDetails || d.responseStatus}`);
    translated.push(d.responseData.translatedText);
  }
  return translated.join("\n\n");
}

app.post("/proxy/translate", async (req, res) => {
  const { targetLang, title, body } = req.body;
  if (!targetLang || !title || !body) return res.status(400).json({ error: "targetLang, title and body required" });
  const langCode = LANG_CODES[targetLang];
  if (!langCode) return res.status(400).json({ error: `Unknown language: ${targetLang}` });
  try {
    console.log(`→ translate [${targetLang}/${langCode}] "${title.substring(0, 40)}…"`);
    const [translatedTitle, translatedBody] = await Promise.all([
      myMemoryTranslate(title, langCode),
      myMemoryTranslate(body, langCode),
    ]);
    console.log(`← translate [${targetLang}] done`);
    res.json({ title: translatedTitle, body: translatedBody });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /proxy/categories ─────────────────────────────────────────────────────
app.get("/proxy/categories", async (req, res) => {
  const { region } = req.query;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!region || !token)
    return res.status(400).json({ error: "region and Authorization header required" });
  try {
    const r = await fetch(`${region}/v2/categories?page=1&pageSize=50`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /proxy/articles ──────────────────────────────────────────────────────
app.post("/proxy/articles", async (req, res) => {
  const { region, authorId, publishAfterCreate, ...payload } = req.body;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!region || !authorId || !token)
    return res.status(400).json({ error: "region, authorId, and Authorization header required" });
  try {
    // Step 1: Create article (always created as draft)
    console.log("→ POST", `${region}/v2/articles/create?authorId=${authorId}&moderatorId=${authorId}`, JSON.stringify(payload));
    const r = await fetch(`${region}/v2/articles/create?authorId=${authorId}&moderatorId=${authorId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    console.log("← create", r.status, text.substring(0, 300));
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) return res.status(r.status).json(data);

    // Step 2: Publish if requested
    if (publishAfterCreate && data.id) {
      console.log("→ POST", `${region}/v2/articles/${data.id}/publish?moderatorId=${authorId}`);
      const pr = await fetch(`${region}/v2/articles/${data.id}/publish?moderatorId=${authorId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const ptext = await pr.text();
      console.log("← publish", pr.status, ptext.substring(0, 300));
      let pdata; try { pdata = JSON.parse(ptext); } catch { pdata = { raw: ptext }; }
      if (!pr.ok) return res.status(pr.status).json({ createId: data.id, publishError: pdata });
    }

    // Step 3: Fetch full article to get seoCommunityUrl for the correct link
    if (data.id) {
      const gr = await fetch(`${region}/v2/articles/${data.id}?moderatorId=${authorId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (gr.ok) {
        const gdata = await gr.json();
        const result = gdata.result || gdata;
        data.seoCommunityUrl = result.seoCommunityUrl || null;
        data.status = result.status || null;
        console.log("← article url:", data.seoCommunityUrl, "status:", data.status);
      }
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /widget — single endpoint for Gainsight widget ───────────────────────────
// Reads inSided credentials from env vars so the Gainsight connector needs no auth config.
// Set in .env: INSIDED_REGION, INSIDED_CLIENT_ID, INSIDED_CLIENT_SECRET, INSIDED_AUTHOR_ID

const W_REGION    = process.env.INSIDED_REGION         || "https://api2-us-west-2.insided.com";
const W_CLIENT_ID = process.env.INSIDED_CLIENT_ID      || "";
const W_CLIENT_SEC= process.env.INSIDED_CLIENT_SECRET  || "";
const W_AUTHOR_ID = process.env.INSIDED_AUTHOR_ID      || "2011";

let _tok = { token: null, exp: 0 };
async function widgetToken() {
  if (_tok.token && Date.now() < _tok.exp) return _tok.token;
  if (!W_CLIENT_ID || !W_CLIENT_SEC) throw new Error("INSIDED_CLIENT_ID / INSIDED_CLIENT_SECRET not set in .env");
  const body = new URLSearchParams({ grant_type:"client_credentials", client_id:W_CLIENT_ID, client_secret:W_CLIENT_SEC, scope:"read write" });
  const r = await fetch(`${W_REGION}/oauth2/token`, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(`Auth failed: ${JSON.stringify(d)}`);
  _tok = { token: d.access_token, exp: Date.now() + ((d.expires_in||3600)*1000) - 60000 };
  console.log(`✅ Widget token refreshed`);
  return _tok.token;
}

app.post("/widget", async (req, res) => {
  const { action, ...p } = req.body || {};
  if (!action) return res.status(400).json({ error: "action required: categories | articles | translate | generate" });
  try {
    // ── categories ──
    if (action === "categories") {
      const token = await widgetToken();
      const r = await fetch(`${W_REGION}/v2/categories?page=1&pageSize=50`, {
        headers: { Authorization:`Bearer ${token}` }
      });
      const data = await r.json();
      return r.ok ? res.json(data) : res.status(r.status).json(data);
    }

    // ── articles — create → publish → get URL ──
    if (action === "articles") {
      const token    = await widgetToken();
      const authorId = p.authorId || W_AUTHOR_ID;
      console.log(`→ widget create: "${(p.title||"").substring(0,40)}" cat=${p.categoryId}`);
      const r = await fetch(`${W_REGION}/v2/articles/create?authorId=${authorId}&moderatorId=${authorId}`, {
        method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
        body: JSON.stringify({ title:p.title, content:p.content, categoryId:parseInt(p.categoryId) })
      });
      const text = await r.text();
      let data; try { data=JSON.parse(text); } catch { data={raw:text}; }
      if (!r.ok) return res.status(r.status).json(data);
      console.log(`← widget create: id=${data.id}`);

      if (p.publishAfterCreate && data.id) {
        const pr = await fetch(`${W_REGION}/v2/articles/${data.id}/publish?moderatorId=${authorId}`, {
          method:"POST", headers:{ Authorization:`Bearer ${token}` }
        });
        console.log(`← widget publish: ${pr.status}`);
      }
      if (data.id) {
        const gr = await fetch(`${W_REGION}/v2/articles/${data.id}?moderatorId=${authorId}`, {
          headers:{ Authorization:`Bearer ${token}` }
        });
        if (gr.ok) { const gd=await gr.json(); const result=gd.result||gd; data.seoCommunityUrl=result.seoCommunityUrl||null; data.status=result.status||null; }
      }
      return res.json(data);
    }

    // ── translate ──
    if (action === "translate") {
      const langCode = LANG_CODES[p.targetLang];
      if (!langCode) return res.status(400).json({ error:`Unknown language: ${p.targetLang}` });
      const [title, body] = await Promise.all([myMemoryTranslate(p.title, langCode), myMemoryTranslate(p.body, langCode)]);
      return res.json({ title, body });
    }

    // ── generate ──
    if (action === "generate") {
      if (!p.prompt && !p.url) return res.status(400).json({ error:"prompt or url required" });
      try {
        return res.json(await runGenerate(p.prompt, p.url));
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error:`Unknown action: ${action}` });
  } catch (e) {
    console.error(`/widget [${action}] error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Proxy running — open this in your browser:`);
  console.log(`   http://localhost:${PORT}`);
  if (AI_ENABLED) {
    console.log(`✅ AI generation enabled (ANTHROPIC_API_KEY loaded)`);
  } else {
    console.log(`ℹ️  AI generation disabled (optional) — to enable:`);
    console.log(`   Add ANTHROPIC_API_KEY=sk-ant-... to .env`);
  }
  console.log("");
});