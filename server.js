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

app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

app.get("/app", (_, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

// ── AI provider setup ─────────────────────────────────────────────────────────
const crypto = require("crypto");

const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_ENABLED = !!(ANTHROPIC_KEY && !ANTHROPIC_KEY.includes("paste-your-key"));

const VERTEX_SA      = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const VERTEX_PROJ    = process.env.GOOGLE_PROJECT_ID;
const VERTEX_LOC     = process.env.VERTEX_LOCATION || "us-central1";
const VERTEX_MODEL   = process.env.VERTEX_MODEL    || "gemini-1.5-flash";
const VERTEX_ENABLED = !!(VERTEX_SA && VERTEX_PROJ);

const AI_PROVIDER = ANTHROPIC_ENABLED ? "anthropic" : VERTEX_ENABLED ? "vertex" : "disabled";

// Vertex token cache
let _vtok = { token: null, exp: 0 };
async function vertexToken() {
  if (_vtok.token && Date.now() < _vtok.exp) return _vtok.token;
  const creds = JSON.parse(VERTEX_SA);
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })).toString("base64url");
  const pay = Buffer.from(JSON.stringify({
    iss: creds.client_email, scope:"https://www.googleapis.com/auth/cloud-platform",
    aud:"https://oauth2.googleapis.com/token", iat:now, exp:now+3600
  })).toString("base64url");
  const sig = crypto.createSign("RSA-SHA256").update(`${hdr}.${pay}`).sign(creds.private_key,"base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion:`${hdr}.${pay}.${sig}` })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Vertex auth failed: ${JSON.stringify(d)}`);
  _vtok = { token:d.access_token, exp:Date.now()+3500000 };
  return _vtok.token;
}

// callAI — optional systemPrompt supported (Anthropic top-level; prepended for Vertex)
async function callAI(userContent, systemPrompt = null) {
  if (ANTHROPIC_ENABLED) {
    const body = {
      model: "claude-haiku-4-5-20251001", max_tokens: 4096,
      messages: [{ role: "user", content: userContent }],
    };
    if (systemPrompt) body.system = systemPrompt;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
    return d.content?.[0]?.text || "";
  }
  if (VERTEX_ENABLED) {
    const token = await vertexToken();
    const combined = systemPrompt ? `${systemPrompt}\n\n${userContent}` : userContent;
    const url = `https://${VERTEX_LOC}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJ}/locations/${VERTEX_LOC}/publishers/google/models/${VERTEX_MODEL}:generateContent`;
    const r = await fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: combined }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.7 } }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || JSON.stringify(d));
    return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  throw new Error("No AI provider configured. Add ANTHROPIC_API_KEY to environment.");
}

// ── Claude translation ────────────────────────────────────────────────────────
// Uses Claude when AI is available — preserves HTML tags, brand voice, tech terms.
// Falls back to Google Translate automatically.
async function claudeTranslate(title, body, targetLang) {
  const system = `You are a professional technical writer translating community articles for a B2B technology company. Rules:
- Preserve ALL HTML tags exactly as written — only translate the visible text between tags
- Keep technical terms, product names, company names, URLs, and code snippets unchanged
- Match a professional but approachable tone
- Do not add any explanation or preamble — respond only in the specified format`;

  const user = `Translate this article from English to ${targetLang}.

Respond in EXACTLY this format — no extra text before or after:
TITLE: [translated title]
BODY: [translated HTML body]

---
TITLE:
${title}

BODY:
${body}`;

  const raw = await callAI(user, system);
  const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
  const bodyMatch  = raw.match(/^BODY:\s*([\s\S]+)/m);
  if (!titleMatch || !bodyMatch) throw new Error("Unexpected translation format from AI");
  return { title: titleMatch[1].trim(), body: bodyMatch[1].trim() };
}

app.get("/health", (_, res) => res.json({ status: "ok", port: PORT, ai: AI_PROVIDER }));

// ── Shared generate helper ────────────────────────────────────────────────────
async function runGenerate(prompt, url) {
  if (!ANTHROPIC_ENABLED && !VERTEX_ENABLED) throw new Error("No AI provider configured. Add ANTHROPIC_API_KEY to environment.");
  const instruction = "Line 1 = plain title (no # prefix). Then 4–6 paragraphs. Plain text, no markdown. 400–600 words. Practical and educational.";
  let content;
  if (url) {
    const pageRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CommunityPublisher/1.0)" } });
    const html = await pageRes.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/\s+/g, " ").trim().substring(0, 6000);
    content = `Based on this content from ${url}:\n\n${text}\n\n${prompt || "Write a community article summarising the key insights."}\n\n${instruction}`;
    console.log(`→ generate from URL (${text.length} chars)`);
  } else {
    content = `Write a community article about: ${prompt}. ${instruction}`;
    console.log(`→ generate: "${prompt.substring(0, 60)}"`);
  }
  const raw   = await callAI(content);
  const lines = raw.trim().split("\n").filter(l => l.trim());
  const title = lines[0].replace(/^[#*\s]+/, "").trim();
  const body  = lines.slice(1).join("\n\n").trim();
  console.log(`← generate done: "${title.substring(0, 50)}"`);
  return { title, body };
}

// ── Publish log ───────────────────────────────────────────────────────────────
// Persists to publish-log.json. On Render free tier the filesystem is ephemeral
// across deploys but persists between restarts — good enough for session history.
const LOG_FILE = path.join(__dirname, "publish-log.json");
const MAX_LOG  = 500;

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return []; }
}
function saveLog(entries) {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2)); }
  catch (e) { console.error("log write error:", e.message); }
}
function logPublish(entry) {
  const log = readLog();
  log.unshift({ ...entry, publishedAt: new Date().toISOString() });
  saveLog(log.slice(0, MAX_LOG));
  console.log(`📝 logged: "${(entry.title || "").substring(0, 50)}" [${entry.lang}]`);
}

// ── Title similarity — Jaccard on meaningful words ────────────────────────────
function titleSimilarity(a, b) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const words = s => new Set(norm(s).split(/\s+/).filter(w => w.length > 2));
  const wA = words(a), wB = words(b);
  const intersection = [...wA].filter(w => wB.has(w)).length;
  const union = new Set([...wA, ...wB]).size;
  return union === 0 ? 0 : intersection / union;
}

const LANG_LABELS = {
  en: "English", es: "Spanish", fr: "French", de: "German",
  pt: "Portuguese (Brazilian)", ja: "Japanese", ko: "Korean", zh: "Simplified Chinese",
};

// ── Async job queue ───────────────────────────────────────────────────────────
// publish-async submits all languages as one job; job-status polls progress.
const JOB_STORE = new Map();

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Prune jobs older than 2 hours every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of JOB_STORE) {
    if (new Date(job.startedAt).getTime() < cutoff) JOB_STORE.delete(id);
  }
}, 30 * 60 * 1000);

const LANG_NAMES = {
  es: "Spanish", fr: "French", de: "German",
  pt: "Portuguese (Brazilian)", ja: "Japanese",
  ko: "Korean", zh: "Simplified Chinese",
};

// Runs in background — never awaited by the HTTP handler
async function runPublishJob(jobId) {
  const job = JOB_STORE.get(jobId);
  if (!job) return;
  job.status = "running";

  const token    = await widgetToken();
  const authorId = W_AUTHOR_ID;

  for (const task of job.tasks) {
    task.status = "working";
    try {
      let txTitle = job.title;
      let txBody  = job.body;

      if (task.lang !== "en") {
        const langName = LANG_NAMES[task.lang] || task.lang;
        if (ANTHROPIC_ENABLED || VERTEX_ENABLED) {
          console.log(`→ job ${jobId} claude-translate [${langName}]`);
          ({ title: txTitle, body: txBody } = await claudeTranslate(txTitle, txBody, langName));
        } else {
          console.log(`→ job ${jobId} google-translate [${langName}]`);
          const langCode = LANG_CODES[langName];
          const [t, b] = await Promise.all([googleTranslate(txTitle, langCode), googleTranslate(txBody, langCode)]);
          txTitle = t; txBody = b;
        }
      }

      // Create article
      const cr = await fetch(`${W_REGION}/v2/articles/create?authorId=${authorId}&moderatorId=${authorId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: txTitle, content: txBody, categoryId: parseInt(job.categoryId) }),
      });
      const ctext = await cr.text();
      let cdata; try { cdata = JSON.parse(ctext); } catch { cdata = { raw: ctext }; }
      if (!cr.ok) throw new Error(`Create failed ${cr.status}: ${JSON.stringify(cdata)}`);

      // Publish if not draft
      if (!job.isDraft && cdata.id) {
        const pr = await fetch(`${W_REGION}/v2/articles/${cdata.id}/publish?moderatorId=${authorId}`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`← job ${jobId} publish [${task.lang}]: ${pr.status}`);
      }

      // Fetch URL
      if (cdata.id) {
        const gr = await fetch(`${W_REGION}/v2/articles/${cdata.id}?moderatorId=${authorId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (gr.ok) {
          const gd = await gr.json();
          const result = gd.result || gd;
          cdata.seoCommunityUrl = result.seoCommunityUrl || null;
        }
      }

      task.status    = "done";
      task.articleId = cdata.id;
      task.url       = cdata.seoCommunityUrl || null;

      logPublish({
        lang:          task.lang,
        title:         txTitle,
        originalTitle: job.title,
        categoryId:    job.categoryId,
        articleId:     cdata.id,
        url:           task.url,
        isDraft:       job.isDraft,
      });
    } catch (e) {
      task.status = "error";
      task.error  = e.message;
      console.error(`job ${jobId} [${task.lang}] error:`, e.message);
    }
  }

  const done  = job.tasks.filter(t => t.status === "done").length;
  const total = job.tasks.length;
  job.status     = done === total ? "done" : done > 0 ? "partial" : "error";
  job.finishedAt = new Date().toISOString();
  console.log(`✅ job ${jobId} finished: ${done}/${total} languages`);
}

// ── Proxy routes (used by standalone app.html) ────────────────────────────────

app.post("/proxy/generate", async (req, res) => {
  const { prompt, url } = req.body;
  if (!prompt && !url) return res.status(400).json({ error: "prompt or url required" });
  try { res.json(await runGenerate(prompt, url)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/proxy/token", async (req, res) => {
  const { region, client_id, client_secret } = req.body;
  if (!region || !client_id || !client_secret)
    return res.status(400).json({ error: "region, client_id and client_secret required" });
  try {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret, scope: "read write" });
    const r    = await fetch(`${region}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    console.log(`✅ Token issued for client_id=${client_id.substring(0, 8)}…`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/proxy/me", async (req, res) => {
  const { region } = req.query;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!region || !token) return res.status(400).json({ error: "region and Authorization header required" });
  try {
    const r    = await fetch(`${region}/v2/user/me`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Google Translate (free, no key) ──────────────────────────────────────────
const LANG_CODES = {
  "French": "fr", "Spanish": "es", "German": "de",
  "Portuguese (Brazilian)": "pt-BR", "Japanese": "ja",
  "Korean": "ko", "Simplified Chinese": "zh-CN",
};

function splitIntoChunks(text, maxLen = 470) {
  const chunks = [];
  const sentences = text.match(/[^.!?\n]+[.!?\n]+\s*|[^.!?\n]+$/g) || [text];
  let current = "";
  for (const sentence of sentences) {
    const s = sentence.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if ((current + " " + s).trim().length <= maxLen) {
      current = (current + " " + s).trim();
    } else {
      if (current) chunks.push(current);
      if (s.length <= maxLen) {
        current = s;
      } else {
        const words = s.split(" ");
        current = "";
        for (const word of words) {
          if ((current + " " + word).trim().length > maxLen) {
            if (current) chunks.push(current);
            current = word;
          } else {
            current = (current + " " + word).trim();
          }
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(c => c.trim());
}

function splitHtmlChunks(html, maxLen = 4500) {
  if (html.length <= maxLen) return [html];
  const segments = html.split(/(?=<(?:p|h[1-6]|li|blockquote|div|pre|ul|ol)\b)/i);
  const chunks = [];
  let current = "";
  for (const seg of segments) {
    if (current.length + seg.length > maxLen && current.length > 0) { chunks.push(current); current = seg; }
    else current += seg;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function googleTranslate(text, langCode) {
  const isHtml = /<[^>]+>/.test(text);
  const chunks = isHtml ? splitHtmlChunks(text) : splitIntoChunks(text, 4500);
  const results = await Promise.all(chunks.map(async (chunk) => {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${langCode}&dt=t&q=${encodeURIComponent(chunk)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`Google Translate HTTP ${r.status}`);
    const d = await r.json();
    return (d[0] || []).map(c => c[0] || "").join("");
  }));
  return results.join(isHtml ? "" : " ");
}

app.post("/proxy/translate", async (req, res) => {
  const { targetLang, title, body } = req.body;
  if (!targetLang || !title || !body) return res.status(400).json({ error: "targetLang, title and body required" });
  const langCode = LANG_CODES[targetLang];
  if (!langCode) return res.status(400).json({ error: `Unknown language: ${targetLang}` });
  try {
    console.log(`→ translate [${targetLang}/${langCode}]`);
    const [translatedTitle, translatedBody] = await Promise.all([
      googleTranslate(title, langCode),
      googleTranslate(body, langCode),
    ]);
    res.json({ title: translatedTitle, body: translatedBody });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/proxy/categories", async (req, res) => {
  const { region } = req.query;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!region || !token) return res.status(400).json({ error: "region and Authorization header required" });
  try {
    const r    = await fetch(`${region}/v2/categories?page=1&pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/proxy/articles", async (req, res) => {
  const { region, authorId, publishAfterCreate, ...payload } = req.body;
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!region || !authorId || !token)
    return res.status(400).json({ error: "region, authorId, and Authorization header required" });
  try {
    const r    = await fetch(`${region}/v2/articles/create?authorId=${authorId}&moderatorId=${authorId}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) return res.status(r.status).json(data);
    if (publishAfterCreate && data.id) {
      const pr = await fetch(`${region}/v2/articles/${data.id}/publish?moderatorId=${authorId}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const ptext = await pr.text();
      let pdata; try { pdata = JSON.parse(ptext); } catch { pdata = { raw: ptext }; }
      if (!pr.ok) return res.status(pr.status).json({ createId: data.id, publishError: pdata });
    }
    if (data.id) {
      const gr = await fetch(`${region}/v2/articles/${data.id}?moderatorId=${authorId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (gr.ok) { const gd = await gr.json(); const result = gd.result || gd; data.seoCommunityUrl = result.seoCommunityUrl || null; data.status = result.status || null; }
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /widget — Gainsight connector endpoint ────────────────────────────────────

const W_REGION    = process.env.INSIDED_REGION        || "https://api2-us-west-2.insided.com";
const W_CLIENT_ID = process.env.INSIDED_CLIENT_ID     || "";
const W_CLIENT_SEC= process.env.INSIDED_CLIENT_SECRET || "";
const W_AUTHOR_ID = process.env.INSIDED_AUTHOR_ID     || "2011";

let _tok = { token: null, exp: 0 };
async function widgetToken() {
  if (_tok.token && Date.now() < _tok.exp) return _tok.token;
  if (!W_CLIENT_ID || !W_CLIENT_SEC) throw new Error("INSIDED_CLIENT_ID / INSIDED_CLIENT_SECRET not set");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: W_CLIENT_ID, client_secret: W_CLIENT_SEC, scope: "read write" });
  const r    = await fetch(`${W_REGION}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const d    = await r.json();
  if (!r.ok || !d.access_token) throw new Error(`Auth failed: ${JSON.stringify(d)}`);
  _tok = { token: d.access_token, exp: Date.now() + ((d.expires_in || 3600) * 1000) - 60000 };
  console.log(`✅ Widget token refreshed`);
  return _tok.token;
}

app.post("/widget", async (req, res) => {
  const { action, ...p } = req.body || {};
  if (!action) return res.status(400).json({ error: "action required" });

  try {

    // ── categories ────────────────────────────────────────────────────────────
    if (action === "categories") {
      const token = await widgetToken();
      const r     = await fetch(`${W_REGION}/v2/categories?page=1&pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
      const data  = await r.json();
      return r.ok ? res.json(data) : res.status(r.status).json(data);
    }

    // ── translate — Google Translate (free, no key needed) ──────────────────
    if (action === "translate") {
      if (!p.targetLang || !p.title || !p.body) return res.status(400).json({ error: "targetLang, title and body required" });
      const langCode = LANG_CODES[p.targetLang];
      if (!langCode) return res.status(400).json({ error: `Unknown language: ${p.targetLang}` });
      console.log(`→ translate [${p.targetLang}/${langCode}] "${p.title.substring(0, 40)}" (${p.body.length} chars)`);
      try {
        const [txTitle, txBody] = await Promise.all([
          googleTranslate(p.title, langCode),
          googleTranslate(p.body, langCode),
        ]);
        console.log(`← translate [${p.targetLang}] done`);
        return res.json({ title: txTitle || p.title, body: txBody || p.body });
      } catch (e) {
        console.error(`translate error:`, e.message);
        return res.status(500).json({ error: `Translation failed: ${e.message}` });
      }
    }

    // ── articles — create → publish → get URL → log ───────────────────────────
    if (action === "articles") {
      const token    = await widgetToken();
      const authorId = p.authorId || W_AUTHOR_ID;
      console.log(`→ widget create: "${(p.title || "").substring(0, 40)}" cat=${p.categoryId}`);

      // For translations: check publish log — was this English article already published in this language?
      if (p.lang && p.lang !== "en" && p.originalTitle) {
        const langLabel = LANG_LABELS[p.lang] || p.lang;
        const existing  = readLog().find(e =>
          e.lang === p.lang && e.originalTitle && titleSimilarity(e.originalTitle, p.originalTitle) >= 0.6
        );
        if (existing) {
          console.log(`⚠️  lang-duplicate [${p.lang}] "${p.originalTitle.substring(0, 40)}"`);
          return res.status(409).json({
            error: `⚠️ This article has already been translated and published in ${langLabel}.${existing.url ? " View it here → " + existing.url : ""}`,
          });
        }
      }

      // For English originals: search community for a similar title
      if ((!p.lang || p.lang === "en") && !p.skipDuplicateCheck && p.title) {
        try {
          const sr = await fetch(`${W_REGION}/search?${new URLSearchParams({ q: p.title, page: 1 })}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (sr.ok) {
            const sd    = await sr.json();
            const dupes = (sd.community || []).filter(item =>
              item.contentType === "article" && titleSimilarity(item.title, p.title) >= 0.6
            );
            if (dupes.length > 0) {
              console.log(`⚠️  duplicate detected for "${p.title.substring(0, 40)}": ${dupes.length} match(es)`);
              const names = dupes.map(d => d.title).join(", ");
              return res.status(409).json({
                error: `⚠️ Similar article already exists: "${names}". Edit the existing article instead, or pass skipDuplicateCheck: true to override.`,
              });
            }
          }
        } catch (e) {
          console.warn("duplicate check skipped:", e.message);
        }
      }
      const r    = await fetch(`${W_REGION}/v2/articles/create?authorId=${authorId}&moderatorId=${authorId}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.title, content: p.content, categoryId: parseInt(p.categoryId) }),
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) return res.status(r.status).json(data);
      console.log(`← widget create: id=${data.id}`);

      if (p.publishAfterCreate && data.id) {
        const pr = await fetch(`${W_REGION}/v2/articles/${data.id}/publish?moderatorId=${authorId}`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`← widget publish: ${pr.status}`);
      }
      if (data.id) {
        const gr = await fetch(`${W_REGION}/v2/articles/${data.id}?moderatorId=${authorId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (gr.ok) { const gd = await gr.json(); const result = gd.result || gd; data.seoCommunityUrl = result.seoCommunityUrl || null; data.status = result.status || null; }
      }

      // Log this publish
      logPublish({
        lang:          p.lang || "en",
        title:         p.title,
        originalTitle: p.originalTitle || p.title,
        categoryId:    p.categoryId,
        articleId:     data.id,
        url:           data.seoCommunityUrl || null,
        isDraft:       !p.publishAfterCreate,
      });

      return res.json(data);
    }

    // ── upload-image ──────────────────────────────────────────────────────────
    if (action === "upload-image") {
      if (!p.imageBase64 || !p.mimeType) return res.status(400).json({ error: "imageBase64 and mimeType required" });
      const token    = await widgetToken();
      const authorId = p.authorId || W_AUTHOR_ID;
      const buf      = Buffer.from(p.imageBase64, "base64");
      const ext      = p.mimeType.split("/")[1] || "jpg";
      const filename = p.filename || `image.${ext}`;
      const form     = new FormData();
      form.append("file", new Blob([buf], { type: p.mimeType }), filename);
      console.log(`→ upload-image: ${filename} (${buf.length} bytes)`);
      const r    = await fetch(`${W_REGION}/v2/media?authorId=${authorId}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) return res.status(r.status).json(data);
      const url = data.url || data.imageUrl || data.src || data.link || data.cdnUrl
        || (data.result && (data.result.url || data.result.imageUrl)) || null;
      console.log(`← upload-image: url=${url}`);
      return res.json({ url, ...data });
    }

    // ── fetch-article ─────────────────────────────────────────────────────────
    if (action === "fetch-article") {
      if (!p.url) return res.status(400).json({ error: "url required" });
      console.log(`→ fetch-article: ${p.url}`);
      const r = await fetch(p.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CommunityPublisher/1.0)" } });
      if (!r.ok) return res.status(400).json({ error: `Could not fetch URL: HTTP ${r.status}` });
      const raw = await r.text();
      function extractDiv(html, classFragment) {
        const idx = html.indexOf(classFragment);
        if (idx === -1) return null;
        const tagStart = html.lastIndexOf("<div", idx);
        if (tagStart === -1) return null;
        const contentStart = html.indexOf(">", tagStart) + 1;
        let depth = 1, pos = contentStart;
        while (depth > 0 && pos < html.length) {
          const nextOpen  = html.indexOf("<div",  pos);
          const nextClose = html.indexOf("</div>", pos);
          if (nextClose === -1) break;
          if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
          else { depth--; if (depth === 0) return html.substring(contentStart, nextClose); pos = nextClose + 6; }
        }
        return null;
      }
      let html = extractDiv(raw, "lia-message-body-content")
              || extractDiv(raw, "article-body")
              || extractDiv(raw, "post-content")
              || extractDiv(raw, "entry-content")
              || (() => { const m = raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i); return m ? m[1] : null; })()
              || null;
      if (!html) return res.status(400).json({ error: "Could not locate article body. Try pasting HTML manually." });
      html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").trim();
      console.log(`← fetch-article: ${html.length} chars`);
      return res.json({ html });
    }

    // ── generate ──────────────────────────────────────────────────────────────
    if (action === "generate") {
      if (!p.prompt && !p.url) return res.status(400).json({ error: "prompt or url required" });
      try { return res.json(await runGenerate(p.prompt, p.url)); }
      catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // ── search-articles — full-text search via inSided Search API ───────────────
    if (action === "search-articles") {
      if (!p.q) return res.status(400).json({ error: "q required" });
      const token  = await widgetToken();
      const params = new URLSearchParams({ q: p.q, page: p.page || 1 });
      const types  = p.contentTypes?.length ? p.contentTypes : ["article"];
      types.forEach(t => params.append("contentTypes", t));
      if (p.categoryIds?.length) p.categoryIds.forEach(id => params.append("categoryIds", id));
      if (p.tags?.length) p.tags.forEach(t => params.append("tags", t));
      console.log(`→ search-articles: "${p.q}" types=${types.join(",")}`);
      const r    = await fetch(`${W_REGION}/search?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      const results = (data.community || []).map(item => {
        const plainSnippet = (item.content || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/\s+/g, " ").trim()
          .substring(0, 150);
        return {
          id: item.id,
          title: item.title,
          url: item.url,
          contentType: item.contentType,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          authorName: item.authorName,
          createdAt: item.createdAt,
          snippet: plainSnippet || null,
        };
      });
      console.log(`← search-articles: ${results.length} results`);
      return res.json({ count: results.length, results });
    }

    // ── publish-async — queue multi-language publish job ──────────────────────
    // Returns { jobId } immediately. Poll with action=job-status.
    if (action === "publish-async") {
      const { title, body, categoryId, langs, isDraft } = p;
      if (!title || !body || !categoryId || !langs?.length)
        return res.status(400).json({ error: "title, body, categoryId, langs[] required" });

      // Duplicate detection before queuing
      if (!p.skipDuplicateCheck && title) {
        try {
          const dupToken = await widgetToken();
          const sr       = await fetch(`${W_REGION}/search?${new URLSearchParams({ q: title, page: 1 })}`, {
            headers: { Authorization: `Bearer ${dupToken}` },
          });
          if (sr.ok) {
            const sd    = await sr.json();
            const dupes = (sd.community || []).filter(item =>
              item.contentType === "article" && titleSimilarity(item.title, title) >= 0.6
            );
            if (dupes.length > 0) {
              console.log(`⚠️  publish-async duplicate: "${title.substring(0, 40)}" — ${dupes.length} match(es)`);
              const links = dupes.map(d => d.title).join(", ");
              return res.status(409).json({
                error: `⚠️ Similar article already exists: "${links}". Edit the existing article instead, or publish to a different section.`,
              });
            }
          }
        } catch (e) {
          console.warn("publish-async duplicate check skipped:", e.message);
        }
      }

      const jobId = newJobId();
      const job = {
        jobId, title, body, categoryId, isDraft: !!isDraft,
        status: "queued",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        tasks: langs.map(lang => ({ lang, status: "pending", articleId: null, url: null, error: null })),
      };
      JOB_STORE.set(jobId, job);
      console.log(`→ publish-async job ${jobId}: ${langs.join(",")} isDraft=${isDraft}`);
      runPublishJob(jobId).catch(e => {
        const j = JOB_STORE.get(jobId);
        if (j) { j.status = "error"; j.error = e.message; }
        console.error(`job ${jobId} fatal:`, e.message);
      });
      return res.json({ jobId, status: "queued", langs });
    }

    // ── job-status — poll a publish-async job ─────────────────────────────────
    if (action === "job-status") {
      if (!p.jobId) return res.status(400).json({ error: "jobId required" });
      const job = JOB_STORE.get(p.jobId);
      if (!job) return res.status(404).json({ error: "Job not found (may have expired)" });
      return res.json({
        jobId: job.jobId, status: job.status,
        startedAt: job.startedAt, finishedAt: job.finishedAt,
        tasks: job.tasks.map(t => ({ lang: t.lang, status: t.status, url: t.url, error: t.error })),
      });
    }

    // ── publish-history — recent articles published through this agent ────────
    if (action === "publish-history") {
      const limit = Math.min(parseInt(p.limit) || 50, 200);
      const log   = readLog().slice(0, limit);
      return res.json({ count: log.length, articles: log });
    }

    // ── language-stats — article counts + recent URLs grouped by language ───────
    if (action === "language-stats") {
      const log = readLog();
      const statsMap = {};
      for (const entry of log) {
        const lang = entry.lang || "en";
        if (!statsMap[lang]) statsMap[lang] = { lang, label: LANG_LABELS[lang] || lang, count: 0, articles: [] };
        statsMap[lang].count++;
        if (entry.url && statsMap[lang].articles.length < 20) {
          statsMap[lang].articles.push({
            title: entry.title, url: entry.url,
            publishedAt: entry.publishedAt, isDraft: !!entry.isDraft,
          });
        }
      }
      const languages = Object.values(statsMap).sort((a, b) => b.count - a.count);
      return res.json({ totalArticles: log.length, languages });
    }

    // ── suggest-topics — Claude analyses the log and suggests new topics ──────
    if (action === "suggest-topics") {
      if (!ANTHROPIC_ENABLED && !VERTEX_ENABLED)
        return res.status(400).json({ error: "ANTHROPIC_API_KEY required for topic suggestions" });

      const log    = readLog().slice(0, 30);
      const recent = log.length
        ? log.map(e => `- "${e.title}" (${e.lang}, ${(e.publishedAt || "").substring(0, 10)})`).join("\n")
        : "(no articles published yet)";

      const system = `You are a community content strategist for a B2B technology company. You help community managers decide what to write next to drive engagement and fill content gaps.`;
      const user   = `Based on the articles already published below, suggest 5 new article topics that would:
1. Fill obvious content gaps
2. Appeal to community members with practical, educational value
3. Build on existing themes without duplicating them

${p.categoryContext ? `Community section / context: ${p.categoryContext}\n` : ""}Recent published articles:
${recent}

Respond as a JSON array only — no explanation, no markdown fences:
[{"title": "...", "rationale": "one sentence on why this topic fills a gap"}, ...]`;

      const raw = await callAI(user, system);
      try {
        const match = raw.match(/\[[\s\S]+\]/);
        const suggestions = JSON.parse(match?.[0] || "[]");
        console.log(`← suggest-topics: ${suggestions.length} suggestions`);
        return res.json({ suggestions });
      } catch (e) {
        console.error("suggest-topics parse error:", e.message);
        return res.status(500).json({ error: "Could not parse suggestions", raw });
      }
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (e) {
    console.error(`/widget [${action}] error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Community Publisher Agent — running`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`✅ AI provider  : ${AI_PROVIDER}`);
  console.log(`✅ Translation  : Google Translate (free)`);
  console.log(`✅ Publish log  : ${LOG_FILE}`);
  console.log(`✅ Agent actions: categories | translate | articles | generate | fetch-article`);
  console.log(`                  publish-async | job-status | publish-history | suggest-topics`);
  if (AI_PROVIDER === "disabled") console.log(`⚠️  No AI key — add ANTHROPIC_API_KEY to enable generation, Claude translation, and topic suggestions`);
  console.log("");
});
