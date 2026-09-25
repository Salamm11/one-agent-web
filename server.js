const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const REQUEST_TIMEOUT = 60000;
const MAX_BODY_SIZE = 100000;

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

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
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
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store"
  });

  res.end(html);
}

function extractInteractionText(data) {
  if (
    typeof data?.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const steps = Array.isArray(data?.steps)
    ? data.steps
    : [];

  return steps
    .filter(
      (step) =>
        step &&
        step.type === "model_output"
    )
    .flatMap((step) =>
      Array.isArray(step.content)
        ? step.content
        : []
    )
    .filter(
      (item) =>
        item &&
        item.type === "text"
    )
    .map((item) => item.text || "")
    .join("")
    .trim();
}

function extractSources(data) {
  const sources = [];
  const seen = new Set();

  const steps = Array.isArray(data?.steps)
    ? data.steps
    : [];

  for (const step of steps) {
    if (step?.type !== "model_output") {
      continue;
    }

    const content = Array.isArray(step.content)
      ? step.content
      : [];

    for (const item of content) {
      if (!Array.isArray(item?.annotations)) {
        continue;
      }

      for (const annotation of item.annotations) {
        if (
          annotation?.type !== "url_citation"
        ) {
          continue;
        }

        const url =
          annotation.url ||
          annotation.uri;

        const title =
          annotation.title ||
          url;

        if (!url || seen.has(url)) {
          continue;
        }

        seen.add(url);

        sources.push({
          title,
          url
        });
      }
    }
  }

  return sources;
}

async function runGemini(task) {
  if (!API_KEY) {
    throw new Error(
      "متغير GEMINI_API_KEY غير مضبوط في Render."
    );
  }

  const input = [
    "أنت وكيل بحث ويب بسيط.",
    "نفّذ مهمة المستخدم بدقة.",
    "استخدم Google Search للحصول على المعلومات الحديثة عند الحاجة.",
    "إذا استخدمت البحث، اعتمد على المصادر التي أعادها البحث.",
    "لا تخترع معلومات أو مصادر.",
    "أجب بالعربية الواضحة ما لم يطلب المستخدم لغة أخرى.",
    "إذا كانت المعلومات غير كافية، قل ذلك بوضوح.",
    "",
    "مهمة المستخدم:",
    task
  ].join("\n");

  const requestBody = JSON.stringify({
    model: MODEL,
    input,
    tools: [
      {
        type: "google_search"
      }
    ],
    store: false
  });

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/interactions";

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
    throw new Error(
      "استجابة Gemini غير صالحة."
    );
  }

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    const message =
      data?.error?.message ||
      `HTTP ${response.status}`;

    throw new Error(
      "Gemini API: " + message
    );
  }

  if (
    data.status &&
    data.status !== "completed"
  ) {
    throw new Error(
      `Gemini لم تُكمل المهمة. الحالة: ${data.status}`
    );
  }

  const result =
    extractInteractionText(data);

  if (!result) {
    throw new Error(
      "Gemini لم تُرجع نتيجة نصية."
    );
  }

  const sources =
    extractSources(data);

  const usage = data.usage || {};

  return {
    result,
    sources,
    usage: {
      input_tokens:
        Number(
          usage.total_input_tokens
        ) || 0,

      output_tokens:
        Number(
          usage.total_output_tokens
        ) || 0,

      total_tokens:
        Number(
          usage.total_tokens
        ) || 0
    }
  };
}

async function runTask(task) {
  const started = Date.now();

  const gemini =
    await runGemini(task);

  return {
    result: gemini.result,
    sources: gemini.sources,
    model: MODEL,
    usage: gemini.usage,
    elapsed_ms:
      Date.now() - started
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

      if (
        Buffer.byteLength(body) >
        MAX_BODY_SIZE
      ) {
        finished = true;

        reject(
          new Error(
            "حجم الطلب كبير جدًا."
          )
        );

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

const server = http.createServer(
  async (req, res) => {
    try {
      if (
        req.method === "GET" &&
        (
          req.url === "/" ||
          req.url === "/index.html"
        )
      ) {
        sendPage(res);
        return;
      }

      if (
        req.method === "POST" &&
        req.url === "/api/run"
      ) {
        const body =
          await readRequestBody(req);

        let data;

        try {
          data = JSON.parse(
            body || "{}"
          );
        } catch {
          sendJson(res, 400, {
            error:
              "بيانات الطلب غير صالحة."
          });
          return;
        }

        const task =
          typeof data.task === "string"
            ? data.task.trim()
            : "";

        if (!task) {
          sendJson(res, 400, {
            error:
              "اكتب المهمة أولًا."
          });
          return;
        }

        if (task.length > 4000) {
          sendJson(res, 400, {
            error:
              "المهمة طويلة جدًا."
          });
          return;
        }

        const result =
          await runTask(task);

        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, {
        error:
          "المسار غير موجود."
      });
    } catch (error) {
      console.error(
        "Request error:",
        error
      );

      if (!res.headersSent) {
        sendJson(res, 500, {
          error:
            error?.message ||
            "حدث خطأ غير متوقع."
        });
      }
    }
  }
);

server.on("error", (error) => {
  console.error(
    "Server error:",
    error
  );
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "One Agent Web running on port " +
        PORT
    );
  }
);
