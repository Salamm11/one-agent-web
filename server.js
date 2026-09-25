const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const REQUEST_TIMEOUT = 30000;
const MAX_BODY_SIZE = 100000;
const MAX_RESULTS = 5;

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";

      res.setEncoding("utf8");

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: data
        });
      });

      res.on("error", reject);
    });

    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error("انتهت مهلة الاتصال."));
    });

    req.on("error", reject);

    if (body !== null) {
      req.write(body);
    }

    req.end();
  });
}

function decodeHtml(text) {
  return String(text)
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(text) {
  return decodeHtml(
    String(text)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function webSearch(query) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  let response;

  try {
    response = await request(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OneAgentWeb/1.0)",
        Accept: "text/html"
      }
    });
  } catch {
    return [];
  }

  if (response.status < 200 || response.status >= 300) {
    return [];
  }

  const results = [];

  const regex =
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(response.body)) !== null) {
    if (results.length >= MAX_RESULTS) {
      break;
    }

    const title = cleanText(match[2]);
    let link = match[1];

    try {
      const parsed = new URL(link, "https://html.duckduckgo.com");

      const realUrl = parsed.searchParams.get("uddg");

      if (realUrl) {
        link = decodeURIComponent(realUrl);
      }
    } catch {
      continue;
    }

    if (!title || !link) {
      continue;
    }

    results.push({
      title,
      url: link
    });
  }

  return results;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function sendPage(res) {
  const file = path.join(__dirname, "index.html");

  if (!fs.existsSync(file)) {
    throw new Error("ملف index.html غير موجود.");
  }

  const html = fs.readFileSync(file, "utf8");

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(html);
}

function extractGeminiText(data) {
  if (!data || !Array.isArray(data.candidates)) {
    return "";
  }

  return data.candidates
    .flatMap((candidate) => {
      const parts = candidate?.content?.parts;

      return Array.isArray(parts) ? parts : [];
    })
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

async function runGemini(prompt) {
  const requestBody = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2
    }
  });

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(MODEL) +
    ":generateContent";

  const response = await request(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
        "x-goog-api-key": API_KEY
      }
    },
    requestBody
  );

  let data;

  try {
    data = JSON.parse(response.body);
  } catch {
    throw new Error("استجابة Gemini غير صالحة.");
  }

  if (response.status < 200 || response.status >= 300) {
    const message =
      data?.error?.message ||
      "فشل الاتصال بخدمة Gemini.";

    throw new Error("Gemini API: " + message);
  }

  const result = extractGeminiText(data);

  if (!result) {
    throw new Error("Gemini لم تُرجع نتيجة نصية.");
  }

  const usage = data.usageMetadata || {};

  return {
    result,
    usage: {
      input_tokens: Number(usage.promptTokenCount) || 0,
      output_tokens: Number(usage.candidatesTokenCount) || 0,
      total_tokens: Number(usage.totalTokenCount) || 0
    }
  };
}

async function runTask(task) {
  if (!API_KEY) {
    throw new Error(
      "متغير GEMINI_API_KEY غير مضبوط في إعدادات Render."
    );
  }

  const started = Date.now();

  const sources = await webSearch(task);

  const sourceText =
    sources.length > 0
      ? sources
          .map(
            (source, index) =>
              `[${index + 1}] ${source.title}\n${source.url}`
          )
          .join("\n\n")
      : "لم يتم العثور على نتائج ويب.";

  const prompt = [
    "أنت وكيل بحث ويب بسيط.",
    "نفّذ المهمة التالية بدقة.",
    "استخدم نتائج البحث المرفقة كمصادر مساعدة.",
    "لا تخترع مصادر أو معلومات غير موجودة.",
    "اكتب الإجابة بالعربية الواضحة.",
    "إذا استخدمت نتيجة من نتائج البحث، أشر إليها برقمها مثل [1] أو [2].",
    "",
    "المهمة:",
    task,
    "",
    "نتائج البحث:",
    sourceText
  ].join("\n");

  const gemini = await runGemini(prompt);

  return {
    result: gemini.result,
    sources,
    model: MODEL,
    usage: gemini.usage,
    elapsed_ms: Date.now() - started
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let finished = false;

    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      if (finished) {
        return;
      }

      body += chunk;

      if (body.length > MAX_BODY_SIZE) {
        finished = true;
        reject(new Error("حجم الطلب كبير جدًا."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!finished) {
        finished = true;
        resolve(body);
      }
    });

    req.on("error", (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      sendPage(res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/run") {
      const body = await readRequestBody(req);

      let data;

      try {
        data = JSON.parse(body || "{}");
      } catch {
        sendJson(res, 400, {
          error: "بيانات الطلب غير صالحة."
        });
        return;
      }

      const task = String(data.task || "").trim();

      if (!task) {
        sendJson(res, 400, {
          error: "اكتب المهمة أولًا."
        });
        return;
      }

      const result = await runTask(task);

      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, {
      error: "المسار غير موجود."
    });
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      sendJson(res, 500, {
        error: error?.message || "حدث خطأ غير متوقع."
      });
    }
  }
});

server.on("error", (error) => {
  console.error("Server error:", error);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("One Agent Web running on port " + PORT);
});
