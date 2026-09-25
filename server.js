const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function decodeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function webSearch(query) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await request(url.toString(), {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  const results = [];

  const regex =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
