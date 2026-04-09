const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const NEWS_RSS_URLS = [
  "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/SCIENCE?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en",
];
const DEFAULT_NEWS_LIMIT = 100;
const MAX_NEWS_LIMIT = 300;
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "changeme123";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_COOKIE = "session_token";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(";").forEach((part) => {
    const [rawKey, ...rawVal] = part.trim().split("=");
    if (!rawKey) return;
    cookies[rawKey] = decodeURIComponent(rawVal.join("=") || "");
  });

  return cookies;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[SESSION_COOKIE] || "";
}

function isAuthenticated(req) {
  cleanupExpiredSessions();
  const token = getSessionToken(req);
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function setSessionCookie(res, token, expiresAt) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(
      expiresAt
    ).toUTCString()}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(0).toUTCString()}`
  );
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function stripHtml(input) {
  return input
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlEntities(input) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'");
}

function normalizeDescription(rawDescription) {
  // Decode first, then strip tags so encoded HTML doesn't leak into UI text.
  const decoded = decodeXmlEntities(rawDescription || "");

  // If Google returns list-style HTML, prefer the first linked sentence only.
  const firstListLink = decoded.match(/<li>[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/i);
  if (firstListLink && firstListLink[1]) {
    const cleanedListText = stripHtml(firstListLink[1]);
    if (cleanedListText.length > 20) {
      return cleanedListText.replace(/\s+/g, " ").trim();
    }
  }

  const plain = stripHtml(decoded);

  if (!plain) return "";

  // Google News descriptions often contain multiple bullet-like headlines.
  // Keep only the first strong fragment for a clean "See more" preview.
  const firstFragment = plain
    .split(/\s{2,}|\s\|\s|;\s|\u00A0{2,}/)
    .map((part) => part.trim())
    .find((part) => part.length > 40);

  return (firstFragment || plain).replace(/\s+/g, " ").trim();
}

function captureTagValue(xml, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[1] : "";
}

function extractItems(xml, limit = 8) {
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const items = [];
  let match;

  while ((match = itemRegex.exec(xml)) && items.length < limit) {
    const itemXml = match[1];
    const title = decodeXmlEntities(stripHtml(captureTagValue(itemXml, "title")));
    const description = normalizeDescription(captureTagValue(itemXml, "description"));
    const link = decodeXmlEntities(stripHtml(captureTagValue(itemXml, "link")));
    const pubDate = decodeXmlEntities(stripHtml(captureTagValue(itemXml, "pubDate")));

    items.push({ title, description, link, pubDate });
  }

  return items;
}

function parsePublishedTimestamp(pubDate) {
  const parsed = Date.parse(pubDate || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rewriteHeadline(headline) {
  const cleaned = headline
    .replace(/\s*-\s*[^-]+$/, "")
    .replace(/\b(Breaking|Latest|Update)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Top Story";
}

function createSubheading(item) {
  const sourcePart = item.title.includes(" - ")
    ? item.title.split(" - ").pop()
    : "Multiple sources";
  return `Key development update from ${sourcePart}, with the core context and next major detail to watch.`;
}

function paraphrase(text) {
  const base = text && text.length > 30 ? text : "Details are still emerging.";
  const cleaned = base.replace(/\s+/g, " ").trim().slice(0, 520);
  const sentenceParts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const lead = sentenceParts[0] || cleaned;
  const followup = sentenceParts.slice(1).join(" ") || "Additional details are still developing.";
  return `This article focuses on the central development and the context behind it. ${lead}\n\nThe broader takeaway is how this update could evolve over the next cycle, with new reporting likely to add clarity. ${followup}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(requested).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(__dirname, "public", safePath);

  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
    res.end(data);
  });
}

async function handleNews(res, requestedLimit) {
  try {
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_NEWS_LIMIT, requestedLimit))
      : DEFAULT_NEWS_LIMIT;
    const perFeedLimit = Math.max(30, Math.ceil(safeLimit / NEWS_RSS_URLS.length) * 3);

    const feedResponses = await Promise.all(
      NEWS_RSS_URLS.map((url) =>
        fetch(url, {
          headers: { "User-Agent": "MinimalNewsApp/1.0" },
        })
      )
    );

    feedResponses.forEach((response) => {
      if (!response.ok) {
        throw new Error(`Google News request failed: ${response.status}`);
      }
    });

    const xmlBodies = await Promise.all(feedResponses.map((response) => response.text()));
    const mergedItems = xmlBodies.flatMap((xml) => extractItems(xml, perFeedLimit));

    const uniqueByLink = new Map();
    for (const item of mergedItems) {
      const key = item.link || item.title;
      if (!uniqueByLink.has(key)) {
        uniqueByLink.set(key, item);
      }
    }

    const rankedItems = Array.from(uniqueByLink.values())
      .sort((a, b) => parsePublishedTimestamp(b.pubDate) - parsePublishedTimestamp(a.pubDate))
      .slice(0, safeLimit);

    const items = rankedItems.map((item) => ({
      originalHeadline: item.title,
      headline: rewriteHeadline(item.title),
      subheading: createSubheading(item),
      paraphrased: paraphrase(item.description),
      link: item.link,
      published: item.pubDate,
    }));

    sendJson(res, 200, { items });
  } catch (error) {
    sendJson(res, 500, {
      error: "Could not fetch Google News right now.",
      details: error.message,
    });
  }
}

async function handleLogin(req, res) {
  try {
    const payload = await readJsonBody(req);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");

    if (username !== AUTH_USER || password !== AUTH_PASS) {
      sendJson(res, 401, { error: "Invalid username or password." });
      return;
    }

    startSession(res);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Login failed." });
  }
}

function startSession(res) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expiresAt);
  setSessionCookie(res, token, expiresAt);
}

async function handleGoogleLogin(req, res) {
  if (!googleClient || !GOOGLE_CLIENT_ID) {
    sendJson(res, 503, { error: "Google sign-in is not configured." });
    return;
  }

  try {
    const payload = await readJsonBody(req);
    const credential = String(payload.credential || "");
    if (!credential) {
      sendJson(res, 400, { error: "Missing Google credential token." });
      return;
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const googlePayload = ticket.getPayload();
    if (!googlePayload || !googlePayload.email_verified) {
      sendJson(res, 401, { error: "Google account could not be verified." });
      return;
    }

    startSession(res);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 401, { error: "Google sign-in failed." });
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && parsedUrl.pathname === "/api/config") {
    sendJson(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/session") {
    sendJson(res, 200, { authenticated: isAuthenticated(req) });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/login") {
    handleLogin(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/logout") {
    const token = getSessionToken(req);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/login/google") {
    handleGoogleLogin(req, res);
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/news") {
    if (!isAuthenticated(req)) {
      sendJson(res, 401, { error: "Please sign in first." });
      return;
    }
    const requestedLimit = Number.parseInt(
      parsedUrl.searchParams.get("limit") || "",
      10
    );
    handleNews(res, requestedLimit);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
