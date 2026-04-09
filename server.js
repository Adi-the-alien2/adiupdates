const http = require("http");
const fs = require("fs");
const path = require("path");

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
  return cleaned ? `Quick Take: ${cleaned}` : "Quick Take: Top Story";
}

function createSubheading(item) {
  const sourcePart = item.title.includes(" - ")
    ? item.title.split(" - ").pop()
    : "Multiple sources";
  return `What people are discussing now, via ${sourcePart}.`;
}

function paraphrase(text) {
  const base = text && text.length > 30 ? text : "Details are still emerging.";
  const sentence = base.replace(/\s+/g, " ").trim().slice(0, 260);
  return `This report highlights the key developments around the story and explains why it is drawing attention right now. ${sentence} As more verified updates are published, this overview should be read as a concise briefing rather than a final account.`;
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

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && parsedUrl.pathname === "/api/news") {
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
