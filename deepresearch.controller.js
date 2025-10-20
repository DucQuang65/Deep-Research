import axios from "axios";
import Message from "../models/message.model.js";
import { generateReport } from "./report.controller.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "path";
import https from "https";
import { createRequire } from "module";
const require = createRequire(import.meta.url); // ensure declared once
const PDFParser = require("pdf2json"); // fallback PDF parser

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

if (!OPENROUTER_API_KEY || !GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
  throw new Error("[SECURITY] Missing required environment variables. Please check your .env file.");
}

const TOP_SOURCES = Number(process.env.DEEPSEARCH_TOP_SOURCES || 5);
const CONCURRENCY = Number(process.env.DEEPSEARCH_CONCURRENCY || 5);

// ========== UTILS==========
// async function saveChatStep(...) { }

// Update chat step function
// export async function updateChatStep(...) { }

// async function logAnalytics(...) { }

// Feedback collection - Step 11
// export async function collectFeedback(...) { }

// async function performFactCheck(...) { }

// ========== SSE EMITTER ==========
function makeSSEEmitter(res) {
  return {
    emit: (step, type, data = {}) => {
      const event = `step-${step}`;
      let payload = '';
      if (typeof data === 'object' && data !== null) {
        payload = JSON.stringify(data);
      } else {
        payload = String(data);
      }
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    },
    emitProgress: (step, progress, message) => {
      const event = 'progress';
      const payload = `${progress}${message ? ' - ' + message : ''}`;
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    },
    emitError: (step, error, details = {}) => {
      const event = 'error';
      let payload = '';
      if (typeof error === 'string') {
        payload = error;
      } else if (error && typeof error === 'object') {
        payload = error.message || error.text || error.error || String(error);
      } else {
        payload = String(error);
      }
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    },
    emitCompleted: (summary = {}) => {
      const event = 'completed';
      let payload = '';
      if (typeof summary === 'string') {
        payload = summary;
      } else if (summary && typeof summary === 'object') {
        payload = summary.message || summary.text || summary.result || String(summary);
      } else {
        payload = String(summary);
      }
      res.write(`event: ${event}\ndata: ${payload}\n\n`);
      res.end();
    }
  };
}

// Helper function for debug
function getStepName(step) {
  const stepNames = {
    1: 'Initialize',
    2: 'Confirm Topic',
    3: 'Generate Plan',
    4: 'Create Subquestions',
    5: 'Execute Research',
    6: 'Generate Report',
    7: 'Fact Check',
    8: 'Generate File',
    9: 'Complete'
  };
  return stepNames[step] || `Step ${step}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function stripCodeFencesAndPreface(text = "") {
  let t = String(text).trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json|markdown|text)?/, "").replace(/```$/, "").trim();
  }
  return t;
}

function extractYearPrefFromText(text = "") {
  const s = String(text);
  const range = s.match(/\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/);
  if (range) {
    const [from, to] = range[0].split(/[-–]/).map(x => parseInt(x.trim(), 10));
    return { fromYear: from, toYear: to };
  }
  const single = s.match(/\b(19|20)\d{2}\b/g);
  if (single && single.length) {
    const years = single.map(y => parseInt(y, 10));
    const max = Math.max(...years);
    return { fromYear: max, toYear: max };
  }
  // last X years pattern
  const last = s.match(/\blast\s+(\d{1,2})\s+years?\b/i);
  if (last) {
    const n = Math.min(parseInt(last[1], 10), 10);
    const now = new Date().getFullYear();
    return { fromYear: now - n, toYear: now };
  }
  return null;
}

function buildDateRestrictFromPref(pref) {
  // CSE hỗ trợ dateRestrict: d[n], w[n], m[n], y[n]
  if (!pref) return "y2"; // mặc định 2 năm gần nhất
  const now = new Date().getFullYear();
  const from = pref.fromYear ?? (now - 2);
  const to = pref.toYear ?? now;
  const years = Math.max(1, Math.min(10, to - from + 1));
  return `y${years}`;
}

function recencyBoostFromText(text = "", pref) {
  const years = Array.from(String(text).matchAll(/\b(19|20)\d{2}\b/g)).map(m => parseInt(m[0], 10));
  if (!years.length) return 0;
  const maxY = Math.max(...years);
  const base = pref?.fromYear || (new Date().getFullYear() - 5);
  return Math.max(0, Math.min(3, (maxY - base) * 0.5)); // boost tối đa ~3
}

// Error handling with timeout and fallback - Step 12
async function withTimeoutAndFallback(fn, timeoutMs = 300000, fallbackFn = null) {
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = await fn();
      clearTimeout(timeoutId);
      resolve(result);
    } catch (error) {
      clearTimeout(timeoutId);
      console.warn(`Primary operation failed: ${error.message}`);

      if (fallbackFn) {
        try {
          console.log("Attempting fallback operation...");
          const fallbackResult = await fallbackFn();
          resolve(fallbackResult);
        } catch (fallbackError) {
          console.error(`Fallback also failed: ${fallbackError.message}`);
          reject(error); // Return original error
        }
      } else {
        reject(error);
      }
    }
  });
}

// ========== LLM CALLER ==========
async function callLLM(messages, model, max_tokens = 16000, retries = 3, options = {}) {
  // Ensure model is a string
  if (typeof model !== 'string') {
    console.error(`Model parameter must be string, got: ${typeof model}`, JSON.stringify(model, null, 2));
    throw new Error(`Model parameter must be string, got: ${typeof model} - ${JSON.stringify(model)}`);
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (options.stream) {
        const { onStreamChunk } = options;
        const response = await axios({
          method: "post",
          url: "https://openrouter.ai/api/v1/chat/completions",
          data: { model, messages, max_tokens, stream: true },
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream"
          },
          responseType: "stream",
          timeout: 0, //không giới hạn thời gian cho stream dài
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
        let fullText = "";
        let buffer = "";
        return await new Promise((resolve, reject) => {
          response.data.on("data", (chunk) => {
            buffer += chunk.toString();
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";
            for (const evt of events) {
              const dataLines = evt.split("\n").filter((l) => l.startsWith("data:"));
              if (dataLines.length === 0) continue;
              const dataPayload = dataLines.map((l) => l.slice(5).trim()).join("\n");
              if (!dataPayload || dataPayload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(dataPayload);
                const delta = parsed.choices?.[0]?.delta?.content || "";
                if (delta) {
                  fullText += delta;
                  onStreamChunk?.(delta, fullText);
                }
              } catch {
                // bỏ qua event không phải JSON hoàn chỉnh
              }
            }
          });
          response.data.on("end", () => resolve(fullText));
          response.data.on("error", (err) => reject(err));
        });
      } else {
        const response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model, messages, max_tokens },
          {
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 120000,
          }
        );
        return response.data.choices?.[0]?.message?.content || "";
      }
    } catch (err) {
      console.error(`Lỗi gọi ${String(model)}: ${err.message}`);
      if (attempt < retries - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

// ========== FILTER GOOGLE SEARCH ==========
// Helper: Retry Axios request với exponential backoff
//async function fetchWithRetry(targetUrl, options = {}, retries, backoff) { }

// Helper: resolve thư mục asset của pdfjs-dist
function getPdfAssetPaths() {
  const buildPath = path.dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  return {
    workerSrc: "pdfjs-dist/legacy/build/pdf.worker.mjs",
    standardFontsPath: path.join(buildPath, "standard_fonts") + '/',
    cMapPath: path.join(buildPath, "cmaps") + '/',
  };
}

// Cấu hình pdfjs-dist để set standardFontDataUrl/cMapUrl
async function configurePdfjs() {
  const pdfjsPath = "pdfjs-dist/legacy/build/pdf.mjs";
  console.log("[DEBUG] Configuring pdfjs-dist from:", pdfjsPath);
  const pdfjsLib = await import(pdfjsPath);

  const assets = getPdfAssetPaths();
  pdfjsLib.GlobalWorkerOptions.workerSrc = assets.workerSrc;
  pdfjsLib.GlobalWorkerOptions.standardFontDataUrl = assets.standardFontsPath;
  pdfjsLib.GlobalWorkerOptions.cMapUrl = assets.cMapPath;
  pdfjsLib.GlobalWorkerOptions.cMapPacked = true;

  console.log("[DEBUG] Worker configured:", pdfjsLib.GlobalWorkerOptions.workerSrc);
  return { pdfjsLib, assets };
}

// Import và cấu hình pdfjs-dist (chỉ gọi 1 lần)
const { pdfjsLib, assets: pdfAssets } = await configurePdfjs();



// function extractPdfWithPdf2Json(uint8) { /* HIDDEN FOR PUBLIC RELEASE */ }

// async function extractPdfText(buffer) { /* HIDDEN FOR PUBLIC RELEASE */ }

// ========== GOOGLE SEARCH ==========
async function googleSearchAndFetch(query, onStep, category) {
  let cleanQuery = String(query).replace(/site:[^\s)]+/g, "").replace(/\s{2,}/g, " ").trim();

  const yearPref = extractYearPrefFromText(cleanQuery);

  const q = `${cleanQuery}${yearPref
      ? ` ${yearPref.fromYear === yearPref.toYear ? yearPref.toYear : `${yearPref.fromYear}-${yearPref.toYear}`}`
      : ""
    }`.trim();

  const params = {
    key: GOOGLE_API_KEY,
    cx: GOOGLE_CSE_ID,
    q,
    dateRestrict: buildDateRestrictFromPref(yearPref),
    num: Math.min(10, TOP_SOURCES * 2),
  };

  // Thông báo bắt đầu search
  onStep?.({ type: "search-start", data: { q, category, dateRestrict: params.dateRestrict } });
  console.log(`\n Search Google CSE: ${q} | dateRestrict=${params.dateRestrict}`);

  try {
    const gcsResponse = await axios.get("https://www.googleapis.com/customsearch/v1", { params });

    const rawItems = gcsResponse.data.items || [];

    const seenHosts = new Set();
    const items = [];
    for (const it of rawItems) {
      try {
        const h = new URL(it.link).hostname.toLowerCase();
        if (seenHosts.has(h)) continue;
        seenHosts.add(h);
        items.push(it);
      } catch { }
    }

    if (!items.length) {
      onStep?.({ type: "search-empty", data: { q, category } });
      onStep?.({ type: "search-done", data: { q, count: 0 } });
      return [];
    }

    const pages = items.slice(0, TOP_SOURCES);

    const fetchContents = await Promise.all(
      pages.map(async (item, index) => {
        await sleep(400 * index);
        try {
          // PDF
          if (item.link.toLowerCase().endsWith(".pdf")) {
            const pdfResponse = await fetchWithRetry(
              item.link,
              {
                responseType: "arraybuffer",
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
                  Accept: "application/pdf,*/*;q=0.8",
                  "Accept-Language": "vi,en;q=0.9",
                  Referer: "https://www.google.com/",
                },
                maxRedirects: 5,
                httpsAgent: insecureAgent,
                validateStatus: (s) => s < 400,
              },
              3,
              1500
            );
            const pdfText = await extractPdfText(pdfResponse.data);
            if (pdfText.length < 80) return null;

            onStep?.({ type: "google-fetch", data: { title: item.title, url: item.link, length: pdfText.length, type: "pdf" } });
            return { url: item.link, title: item.title, content: pdfText };
          }

          // HTML
          const page = await fetchWithRetry(
            item.link,
            {
              responseType: "arraybuffer",
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "vi,en;q=0.9",
                Referer: "https://www.google.com/",
              },
              maxRedirects: 5,
              httpsAgent: insecureAgent,
              validateStatus: (s) => s < 400,
            },
            3,
            1000
          );

          const contentType = page.headers["content-type"] || "";
          if (contentType.includes("application/pdf")) return null;

          let html = decodeBufferBestEffort(page.data, contentType);
          
          // Nếu phát hiện cookie/consent wall hoặc cloudflare, dùng playwright
          if (html.length < 200 || 
              /(cookie|consent|gdpr|onetrust|cf-chl|cloudflare|captcha)/i.test(html.substring(0, 5000))) {
            console.log(`[Playwright] Rendering ${item.link} for consent/JS...`);
            try {
              const rendered = await fetchWithPlaywright(item.link);
              if (rendered?.data) html = rendered.data;
            } catch (pwError) {
              console.warn(`[Playwright] Failed for ${item.link}:`, pwError.message);
              // Continue with original HTML
            }
          }

          const { load } = await import("cheerio");
          const $ = load(html, { decodeEntities: true });

          // Loại bỏ các elements không cần thiết
          $("script, style, nav, header, footer, aside, form, iframe, noscript, svg, img, video, audio").remove();
          $(".ad, .advertisement, .cookie-notice, .cookie-banner, .consent, .popup, .modal").remove();
          $("[class*='cookie'], [class*='consent'], [class*='banner'], [id*='cookie']").remove();
          $("button, input, select, textarea").remove();

          const norm = (s = "") => String(s)
            .replace(/\s+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          
          const candidates = [];
          const pushIf = (sel, priority = 1) => {
            const t = norm($(sel).text() || "");
            if (t && t.length > 50) candidates.push({ sel, text: t, priority });
          };
          
          // Priority-based extraction
          pushIf("article", 10);
          pushIf("main article", 9);
          pushIf("div[itemprop='articleBody']", 9);
          pushIf("main", 8);
          pushIf(".post-content, .entry-content, .article-content", 8);
          pushIf("#content, #main, .content", 7);
          pushIf(".post, .article", 6);
          
          const headings = norm($("h1, h2, h3").text() || "");
          if (headings) candidates.push({ sel: "headings", text: headings, priority: 5 });
          
          const paragraphs = norm($("p").text() || "");
          if (paragraphs) candidates.push({ sel: "paragraphs", text: paragraphs, priority: 4 });
          
          const listItems = norm($("li").text() || "");
          if (listItems) candidates.push({ sel: "lists", text: listItems, priority: 3 });
          
          const metaDesc = norm($('meta[name="description"]').attr("content") || "");
          if (metaDesc) candidates.push({ sel: "meta", text: metaDesc, priority: 2 });
          
          const bodyText = norm($("body").text() || "");
          if (bodyText) candidates.push({ sel: "body", text: bodyText, priority: 1 });

          const terms = String(query).toLowerCase().split(/[^a-zA-Z0-9\u00C0-\u024F]+/).filter((w) => w.length >= 4);
          const uniqueTerms = Array.from(new Set(terms));
          
          const scoreOf = (text, priority) => {
            const low = text.toLowerCase();
            const hits = uniqueTerms.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
            const lenBoost = Math.min(text.length / 2000, 1.0);
            const recency = recencyBoostFromText(text, yearPref);
            return (hits * 3) + lenBoost + recency + (priority * 0.5);
          };
          
          const ranked = candidates
            .map((c) => ({ ...c, score: scoreOf(c.text, c.priority) }))
            .sort((a, b) => b.score - a.score);

          const MAX = 8000; // Tăng lên để có nhiều context hơn
          let acc = "";
          for (const c of ranked) {
            if (acc.length >= MAX) break;
            // Chỉ thêm nếu không trùng lặp quá nhiều
            if (!acc || !acc.includes(c.text.substring(0, 100))) {
              acc += (acc ? "\n\n" : "") + c.text;
            }
          }
          
          let cleanText = norm(acc);
          
          // Loại bỏ các patterns không mong muốn
          cleanText = cleanText
            .replace(/cookies?\s+policy/gi, '')
            .replace(/privacy\s+policy/gi, '')
            .replace(/terms\s+of\s+service/gi, '')
            .replace(/subscribe\s+to/gi, '')
            .replace(/newsletter/gi, '')
            .replace(/\b(click here|read more|learn more)\b/gi, '')
            .replace(/^\s*[-•]\s*/gm, '') // Remove bullet points
            .trim();
          
          if (cleanText.length < 100) {
            const meta = norm($('meta[name="description"]').attr("content") || "");
            if (meta.length >= 100) cleanText = meta;
          }
          if (cleanText.length < 100) return null;

          const BAD = [
            "page not found", "404", "enable javascript", "captcha", 
            "access denied", "forbidden", "error", "not available",
            "cookie consent", "gdpr", "please wait"
          ];
          if (BAD.some((p) => cleanText.toLowerCase().includes(p))) {
            console.warn(`[Skip] Bad pattern detected in ${item.link}`);
            return null;
          }
          
          console.log(`Extracted ${cleanText.length} chars from ${item.link}`);
          onStep?.({ type: "google-fetch", data: { title: item.title, url: item.link, length: cleanText.length } });
          return { url: item.link, title: item.title, content: cleanText };
        } catch (err) {
          console.warn(`[googleSearchAndFetch] Fetch error for ${item.link}:`, err.message);
          onStep?.({ type: "google-fetch-error", data: { title: item.title, url: item.link, error: err.message } });
          const fallback = (item.snippet || "").trim();
          return fallback ? { url: item.link, title: item.title, content: fallback } : null;
        }
      })
    );

    const results = fetchContents.filter((c) => c && c.content && c.content.length > 0);
    onStep?.({ type: "search-done", data: { q, count: results.length } });
    return results;
  } catch (err) {
    onStep?.({ type: "search-error", data: { q, error: err.message } });
    onStep?.({ type: "search-done", data: { q, count: 0 } });
    return [];
  }
}

// ========== WORKFLOW FUNCTIONS ==========

// Hàm chỉnh sửa kế hoạch nghiên cứu
export async function editResearchPlan({ topic, plan, editInstruction, model, opts = {} }) {
  const messages = [
    {
      role: "user",
      content: `Bạn là Research Plan Editor chuyên nghiệp. Dưới đây là kế hoạch nghiên cứu hiện tại cho chủ đề "${topic}":

**KẾ HOẠCH HIỆN TẠI:**
${plan}

**YÊU CẦU CHỈNH SỬA:**
${editInstruction}
`
    }
  ];

  if (opts.onToken) {
    let acc = "";
    await callLLM(messages, model, 8000, 3, {
      stream: true,
      onStreamChunk: (chunk, full) => {
        acc = full;
        opts.onToken(chunk, full);
      }
    });
    return stripCodeFencesAndPreface(acc);
  } else {
    const raw = await callLLM(messages, model, 8000);
    return stripCodeFencesAndPreface(raw);
  }
}

// Gemini sinh subquestion để search — thêm ràng buộc domain/label + thời gian
export async function generateSubQuestionsGemini(topic, plan, model, opts = {}) {
  const messages = [
    {
      role: "user",
      content: `Bạn là Research Subquestion Generator chuyên nghiệp. 
Dựa trên kế hoạch nghiên cứu sau đây, hãy phân tích chủ đề "${topic}" 
thành TỐI ĐA 20 câu hỏi con, chia theo các mảng và mục tiêu từng bước:

**KẾ HOẠCH NGHIÊN CỨU:**
${plan}
`,
    },
  ];
  if (opts.onToken) {
    let acc = "";
    await callLLM(messages, model, 8000, 3, {
      stream: true,
      onStreamChunk: (chunk, full) => {
        acc = full;
        opts.onToken(chunk, full);
      }
    });
    return stripCodeFencesAndPreface(acc);
  } else {
    const raw = await callLLM(messages, model);
    return stripCodeFencesAndPreface(raw);
  }
}

export async function plan(topic, model , opts = {}) {
  console.log(`\n Planner (${model}): ${topic}`);
  const { fileUrl, onToken } = opts;

  // Kiểm tra đầu vào trước khi lập kế hoạch
  const context = await confirm(topic, model);
  const isDeepResearch = context.deepResearch === true;

  // Trả về kết quả kiểm tra luôn cho FE
  if (!isDeepResearch) {
    return context;
  }

  // Nếu đúng chủ đề nghiên cứu chuyên sâu, sinh kế hoạch như cũ
  const planMessages = [
    {
      role: "user",
      content: [
        { type: "text", text: `Bạn là Research Planner chuyên nghiệp. Hãy lập một kế hoạch nghiên cứu chi tiết cho chủ đề: "${topic}".` },
        ...(fileUrl ? [{
          type: "image_url",
          image_url: { url: fileUrl }
        }] : []),
        {
          type: "text", text: `
        YÊU CẦU:
        ${fileUrl ? '- Tham khảo thông tin từ file đính kèm nếu có.' : ''}`,
        },
      ]
    }
  ];

  const categoryMessages = [
    {
      role: "user",
      content: `Bạn là Research Category Analyst. Dựa trên chủ đề "${topic}", hãy liệt kê các category/mảng nội dung cần phân tích trong nghiên cứu chuyên sâu.`,
    },
  ];
  let plan, category;
  if (opts.onToken) {
    let planAcc = "";
    // Chỉ stream phần plan
    await callLLM(planMessages, model, 8000, 3, {
      stream: true,
      onStreamChunk: (chunk, full) => {
        planAcc = full;
        opts.onToken(chunk, full);
      }
    });
    plan = stripCodeFencesAndPreface(planAcc);
    // Sinh category sau, không stream
    const categoryRaw = await callLLM(categoryMessages, model);
    category = stripCodeFencesAndPreface(categoryRaw);
  } else {
    // Sinh plan và category song song
    const [planRaw, categoryRaw] = await Promise.all([
      callLLM(planMessages, model),
      callLLM(categoryMessages, model)
    ]);
    plan = stripCodeFencesAndPreface(planRaw);
    category = stripCodeFencesAndPreface(categoryRaw);
  }

  return {
    deepResearch: true,
    plan,
    category,
  };
}

export async function planDeepResearch(topic, model, opts = {}) {
  return plan(topic, model, opts);
}

// Input check
export async function confirm(message, model , opts = {}) {
  const prompt = `Kiểm tra nội dung đầu vào của người dùng: "${message}" có liên quan tới deep research hay không:`;
  if (opts.onToken) {
    let acc = "";
    await callLLM([{ role: "user", content: prompt }], model, 8000, 3, {
      stream: true,
      onStreamChunk: (chunk, full) => {
        acc = full;
        opts.onToken(chunk, full);
      }
    });
    const clean = stripCodeFencesAndPreface(acc);
    try {
      return JSON.parse(clean);
    } catch (e) {
      return { deepResearch: false, plan: clean };
    }
  } else {
    const raw = await callLLM([{ role: "user", content: prompt }], model, 8000);
    const clean = stripCodeFencesAndPreface(raw);
    try {
      return JSON.parse(clean);
    } catch (e) {
      return { deepResearch: false, plan: clean };
    }
  }
}

// Executor
export async function* executorGemini(subQuestions, model = "google/gemini-2.5-flash", onStep) {
  console.log(` Executor ${model}`);
  // Normalize subQuestions: accept parsed array OR raw string
  let normalized = [];
  if (!subQuestions) normalized = [];
  else if (Array.isArray(subQuestions)) {
    // Chỉ nhận mảng object có trường subQuestion hoặc mảng string
    if (typeof subQuestions[0] === "object" && subQuestions[0].subQuestion) {
      normalized = subQuestions.map(q => ({
        category: q.category || "misc",
        subQuestion: q.subQuestion
      }));
    } else if (typeof subQuestions[0] === "string") {
      normalized = subQuestions.map(q => ({
        category: "misc",
        subQuestion: q
      }));
    } else {
      normalized = [];
    }
  } else if (typeof subQuestions === 'object' && subQuestions.parsed) {
    // Nếu còn trường hợp đặc biệt, xử lý tại đây
    const p = subQuestions.parsed;
    if (Array.isArray(p) && typeof p[0] === "object" && p[0].subQuestion) {
      normalized = p.map(q => ({
        category: q.category || "misc",
        subQuestion: q.subQuestion
      }));
    } else if (Array.isArray(p) && typeof p[0] === "string") {
      normalized = p.map(q => ({
        category: "misc",
        subQuestion: q
      }));
    } else {
      normalized = [];
    }
  } else if (typeof subQuestions === 'object' && subQuestions.raw) {
    // try to split raw by lines
    const lines = String(subQuestions.raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    normalized = lines.map((l, i) => ({ category: 'misc', subQuestion: l }));
  } else if (typeof subQuestions === 'string') {
    const lines = subQuestions.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    normalized = lines.map((l, i) => ({ category: 'misc', subQuestion: l }));
  } else {
    normalized = [];
  }

  const flat = normalized;
  const queue = [];

  const worker = async (sq) => {
    onStep?.({ 
      type: "subq-start", 
      data: { 
        subQuestion: String(sq.subQuestion || ''), 
        category: String(sq.category || '') 
      } 
    });
    const sources = await googleSearchAndFetch(sq.subQuestion, onStep, sq.category);
    if (!sources.length) {
      const out = {
        ...sq,
        summary: `NO_SOURCES_FOUND: Không tìm thấy nguồn đáng tin cậy cho câu hỏi "${sq.subQuestion}". Cần điều chỉnh từ khóa hoặc mốc thời gian.`,
        sources: [],
        status: "no_sources"
      };
      queue.push(out);
      return out;
    }

    const BAD_PATTERNS = [
      "Register Now", "Join for Free", "Skip to content", "Please enable JavaScript",
      "Page Not Found", "Error", "does not exist", "not available", "Access Denied",
      "startxref", "endobj", "stream", "endstream", "obj", "xref", "trailer", "%%EOF"
    ];
    const validContents = sources
      .filter(c => c && c.content && c.content.length > 50)
      .filter(c => !BAD_PATTERNS.some(pat => c.content.toLowerCase().includes(pat.toLowerCase())));

    let snippets = "";
    if (!validContents.length) {
      const allContents = sources.filter(c => c && c.content && c.content.length > 30);
      if (allContents.length) {
        snippets = allContents.map(c => c.content).join("\n");
        console.log(`[INFO] Using fallback snippets for: ${sq.subQuestion}`);
      } else {
        const out2 = {
          ...sq,
          summary: `NO_SOURCES_FOUND: Không tìm thấy nội dung phù hợp để tóm tắt.`,
          sources: [],
          status: "no_sources"
        };
        queue.push(out2);
        return out2;
      }
    } else {
      snippets = validContents.map(c => c.content).join("\n");
    }

    const MAX_SNIPPETS_LENGTH = 6000;
    if (snippets.length > MAX_SNIPPETS_LENGTH) snippets = snippets.slice(0, MAX_SNIPPETS_LENGTH);
    if (!snippets.trim() || snippets.length < 80) {
      const out3 = {
        ...sq,
        summary: "Không tìm thấy nội dung thực tế để tóm tắt.",
        sources: validContents.map(c => ({ title: c.title, url: c.url })),
        status: "no_content"
      };
      queue.push(out3);
      return out3;
    }

    const messages = [
      {
        role: "system",
        content: "Bạn là Research Executor chuyên nghiệp. Nhiệm vụ của bạn là tóm tắt nội dung từ nguồn đáng tin cậy một cách chính xác và chi tiết."
      },
      {
        role: "user",
        content: `Tóm tắt CHI TIẾT câu trả lời cho câu hỏi: "${sq.subQuestion}"

NGUỒN TÀI LIỆU:
${snippets}`
      }
    ];
    try {
      let streamedSummary = "";
      const summaryRaw = await callLLM(messages, model, 66000, 3, {
        stream: true,
        onStreamChunk: (chunk, fullText) => {
          streamedSummary = fullText;
          onStep?.({ 
            type: "llm-chunk", 
            data: { 
              subQuestion: String(sq.subQuestion || ''), 
              chunk: String(chunk || ''), 
              fullText: String(fullText || '') 
            } 
          });
        }
      });

      const finalText = stripCodeFencesAndPreface(summaryRaw || streamedSummary);
      if (!finalText) {
        const outUndef = {
          ...sq,
          summary: "Không sinh được tóm tắt do model không trả về kết quả.",
          sources: sources.map(c => ({ title: c.title, url: c.url })),
          status: "llm_undefined"
        };
        queue.push(outUndef);
        return outUndef;
      }

      const res = { ...sq, summary: finalText, sources: sources.map(c => ({ title: c.title, url: c.url })), status: "ok" };
      onStep?.({ 
        type: "summary", 
        data: { 
          subQuestion: String(sq.subQuestion || ''), 
          summary: String(finalText) 
        } 
      });
      queue.push(res);
      return res;
    } catch (err) {
      const resErr = {
        ...sq,
        summary: `EXECUTOR_ERROR: ${err.message}`,
        sources: sources.map(c => ({ title: c.title, url: c.url })),
        status: "error",
        error: err.message
      };
      queue.push(resErr);
      return resErr;
    }
  };

  const workers = [];
  for (let c = 0; c < CONCURRENCY; c++) {
    workers.push((async () => {
      for (let i = c; i < flat.length; i += CONCURRENCY) {
        await worker(flat[i], i);
      }
    })());
  }
  let yielded = 0;
  while (yielded < flat.length) {
    if (queue.length > 0) {
      yield queue.shift();
      yielded++;
    } else {
      await sleep(100);
    }
  }
  await Promise.all(workers);
}

// Synthesis
export async function synthesizerOpenAI(topic, answers, model, opts = {}) {
  if (!answers || answers.length === 0) {
    console.warn(`[WARN] Answers rỗng cho topic "${topic}". Trả về report fallback.`);
    return JSON.stringify({
      title: `Báo cáo phân tích chuyên sâu về ${topic}`,
      sections: [],
      conclusion: "Không có dữ liệu từ answers để tổng hợp báo cáo.",
      sources: []
    });
  }

  const answersString = answers.map((a, i) => {
    if (typeof a === "string") return `Q${i + 1}: ${a}`;
    const sub = a.subQuestion || `Q${i + 1}`;
    const summ = a.summary || "";
    return `Q${i + 1}: ${sub}\nSummary:\n${summ}`;
  }).join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "Bạn là Professional Report Synthesizer. Nhiệm vụ của bạn là tổng hợp và phân tích chuyên sâu một chủ đề."
    },
    {
      role: "user",
      content: `
Hãy tạo BÁO CÁO PHÂN TÍCH CHUYÊN SÂU về chủ đề: "${topic}"

INPUT DATA:
${answersString}`
    }
  ];

  if (opts.onToken) {
    let acc = "";
    await callLLM(messages, model, 33000, 3, {
      stream: true,
      onStreamChunk: (chunk, full) => {
        acc = full;
        opts.onToken(chunk, full);
      }
    });
    return acc;
  } else {
    const raw = await callLLM(messages, model, 16000);
    return raw;
  }
}


// Main
export async function deepsearch({ topic, model }) {
  // Input validation
  if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
    throw new Error("Topic phải là string có ít nhất 3 ký tự");
  }
  if (!model || typeof model !== 'string') {
    throw new Error("Model parameter là bắt buộc và phải là string");
  }
  const cleanTopic = topic.trim();
  console.log(`  Starting DeepSearch for: "${cleanTopic}" using model: ${model}`);

  try {
    // 1. Lập kế hoạch nghiên cứu (plan)
    const plan = await planDeepResearch(cleanTopic, model);
    // await saveChatStep({ chat_id, user_id, sender: "assistant", model, type: "deepResearch-plan", content: plan });
    console.log(` Generated research plan`);

    // 2. Sinh subquestions chi tiết cho Gemini
    const subQuestions = await generateSubQuestionsGemini(cleanTopic, plan.plan, model);
    // await saveChatStep({ chat_id, user_id, sender: "assistant", model, type: "deepResearch-subquestions", content: subQuestions });
    console.log(` Generated ${subQuestions?.split('\n').length || 0} subquestions`);

    // 3. Executor để lấy answers từ subQuestions
    const answers = [];
    for await (const a of executorGemini(subQuestions, model)) {
      answers.push(a);
    }
    // await saveChatStep({ chat_id, user_id, sender: "assistant", model, type: "deepResearch-answers", content: JSON.stringify(answers) });
    console.log(`Generated ${answers.length} answers`);

    // 4. Claude viết báo cáo chuyên sâu từ answers
    const report = await synthesizerOpenAI(cleanTopic, answers, model);
    // await saveChatStep({ chat_id, user_id, sender: "assistant", model, type: "deepResearch-report", content: report });
    console.log(` generated report: ${report?.length || 0} chars`);

    const researchData = {
      id: `ds_${Date.now()}`,
      query: cleanTopic,
      report,
      model: model,
      timestamp: new Date().toISOString()
    };
    await generateReport(researchData);

    return report;
  } catch (error) {
    console.error("DeepSearch Error:", error.message);
    throw new Error(`DeepSearch failed: ${error.message}`);
  }
}

// New Playwright fetch function với chromium
// export async function fetchWithPlaywright(url) { / }


// ========== 12-STEP DEEPSEARCH ORCHESTRATION ==========
export async function deepsearchStream({ topic, fileUrl = null }, res) {
  const emitter = makeSSEEmitter(res);
  const workflowStartTime = Date.now();
  res.startTime = workflowStartTime;

  // Heartbeat để tránh timeout (mỗi 30s)
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }, 30000);
  
  // Cleanup function with guard
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(heartbeat);
    console.log('[DeepSearch] Stream cleanup completed');
  };
  
  // Đăng ký cleanup events
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  // Timeout configuration (seconds)
  const STEP_TIMEOUTS = {
    1: 5,      // Initialize
    2: 30,     // Confirm Topic  
    3: 60,     // Generate Plan
    4: 45,     // Create Subquestions
    5: 300,    // Execute Research (5 minutes max)
    6: 180,    // Generate Report (3 minutes max)
    7: 30,     // Fact Check

    8: 60,     // Generate File
    9: 10      // Complete
  };

  // Completion tracking
  let step6Completed = false;

  try {
    // Step 1: Initialize
    const step1Start = Date.now();
    emitter.emit(1, 'initialize', {
      message: 'Khởi tạo nghiên cứu chuyên sâu...',
      topic,
      estimated_duration: '5-10 phút'
    });
    emitter.emitProgress(1, 10, 'Đang khởi tạo workflow...');

    // Step 2: Confirm topic with timeout
    emitter.emit(2, 'confirm-start', { message: 'Đang xác nhận chủ đề nghiên cứu...' });
    emitter.emitProgress(2, 20, 'Phân tích chủ đề...');

    const step2Start = Date.now();
    const confirmResult = await withTimeoutAndFallback(
      () => confirm(topic, "google/gemini-2.5-flash-lite", {
        onToken: (chunk, fullText) => {
          emitter.emit(2, 'confirm-chunk', { chunk });
        }
      }),
      STEP_TIMEOUTS[2] * 1000,
      () => ({ deepResearch: true, category: 'general', message: 'Timeout - accepted by default' })
    );

    if (!confirmResult.deepResearch) {
      emitter.emit(2, 'confirm-rejected', {
        ...confirmResult,
        duration: Date.now() - step2Start
      });
      emitter.emitCompleted({
        reason: 'Topic not suitable for deep research',
        duration: Date.now() - workflowStartTime
      });
      return;
    }

    emitter.emit(2, 'confirm-approved', {
      message: 'Chủ đề đã được xác nhận cho nghiên cứu chuyên sâu',
      category: confirmResult.category,
      duration: Date.now() - step2Start
    });
    emitter.emitProgress(2, 100, 'Xác nhận hoàn tất');

    // Step 3: Generate plan with file support
    emitter.emit(3, 'plan-start', {
      message: 'Đang lập kế hoạch nghiên cứu...',
      hasFile: !!fileUrl
    });
    const planResult = await plan(topic, {
      fileUrl,
      onToken: (chunk, fullText) => {
        // Emit plain text chunk directly
        emitter.emit(3, 'plan-chunk', String(chunk));
      }
    });

    emitter.emit(3, 'plan-completed', { 
      plan: String(planResult.plan || ''), 
      category: String(planResult.category || '') 
    });

    // Step 4: Generate subquestions
    emitter.emit(4, 'subquestions-start', { message: 'Đang sinh câu hỏi nghiên cứu con...' });
    const subQuestions = await generateSubQuestionsGemini(topic, planResult.plan, {
      onToken: (chunk, fullText) => {
        // Emit plain text chunk directly
        emitter.emit(4, 'subquestions-chunk', String(chunk));
      }
    });

    emitter.emit(4, 'subquestions-completed', { subQuestions: String(subQuestions || '') });

    // Step 5: Execute research with timeout and analytics
    emitter.emit(5, 'research-start', { message: 'Bắt đầu nghiên cứu và thu thập dữ liệu...' });
    const answers = [];
    const researchStartTime = Date.now();

    try {
      for await (const answer of executorGemini(subQuestions, (event) => {
        if (event?.type && event?.data) {
          // Đảm bảo data là object thuần, không có circular reference
          const safeData = typeof event.data === 'object' && event.data !== null 
            ? { ...event.data } 
            : { message: String(event.data) };
          emitter.emit(5, event.type, safeData);
        }
      })) {
        answers.push(answer);
        emitter.emit(5, 'answer-completed', {
          question: String(answer.subQuestion || answer.question || ''),
          totalAnswers: answers.length
        });
      }

      await logAnalytics({
        step: 5,
        action: 'research-execution',
        duration: Date.now() - researchStartTime,
        success: true,
        metadata: {
          total_answers: answers.length,
          subquestions_count: subQuestions.split('\n').filter(l => l.match(/^\d+\./)).length
        }
      });

      emitter.emit(5, 'research-completed', { totalAnswers: answers.length });
    } catch (error) {
      await logAnalytics({
        step: 5,
        action: 'research-execution',
        duration: Date.now() - researchStartTime,
        success: false,
        error,
        metadata: { answers_collected: answers.length }
      });
      throw error;
    }

    // Step 6: Synthesize report
    emitter.emit(6, 'report-start', { message: 'Đang viết báo cáo tổng hợp...' });
    step6Completed = false;
    
    const report = await synthesizerOpenAI(topic, answers, {
      onToken: (chunk, fullText) => {
        // Emit plain text chunk directly
        emitter.emit(6, 'report-chunk', String(chunk));
      }
    });

    // Mark step 6 as completed
    step6Completed = true;
    emitter.emit(6, 'report-completed', { report: String(report || '') });

    // Validate step 6 completion before continuing
    if (!step6Completed || !report || report.length < 100) {
      throw new Error('Step 6: Báo cáo chưa hoàn thành hoặc quá ngắn');
    }

    // Step 7: Fact-check and cross-validation
    emitter.emit(7, 'analyze-start', { message: 'Đang phân tích và kiểm tra chéo dữ liệu...' });

    const startTime = Date.now();
    try {
      // Basic fact-check by analyzing report consistency
      const factCheckResult = await performFactCheck(report, answers);

      await logAnalytics({
        step: 7,
        action: 'fact-check',
        duration: Date.now() - startTime,
        success: true,
        metadata: {
          confidence: factCheckResult.confidence,
          issues_found: factCheckResult.issues?.length || 0
        }
      });

      emitter.emit(7, 'analyze-completed', {
        message: 'Kiểm tra chéo hoàn tất',
        confidence: Number(factCheckResult.confidence || 0),
        issues: Array.isArray(factCheckResult.issues) ? factCheckResult.issues : []
      });
    } catch (error) {
      await logAnalytics({
        step: 7,
        action: 'fact-check',
        duration: Date.now() - startTime,
        success: false,
        error
      });
      emitter.emit(7, 'analyze-completed', { message: 'Bỏ qua kiểm tra chéo do lỗi' });
    }

    // Step 8: Generate file
    emitter.emit(8, 'file-start', { message: 'Đang tạo file DOCX...' });

    const titleMatch = typeof report === "string" ? report.match(/Title:\s*(.+)/i) : null;
    const shortTitle = titleMatch ? titleMatch[1].replace(/\r?\n.*/g, "").trim() : topic.trim();

    function toFileName(str) {
      str = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      str = str.replace(/[^\w\d]+/g, "_");
      str = str.replace(/^_+|_+$/g, "").replace(/_+/g, "_");
      if (str.length > 60) {
        const idx = str.lastIndexOf("_", 60);
        str = str.slice(0, idx > 0 ? idx : 60);
      }
      return str;
    }

    const fileName = `${toFileName(shortTitle)}.docx`;
    const researchData = {
      id: `ds_${Date.now()}`,
      query: topic,
      report: { markdown: report },
      timestamp: new Date().toISOString(),
      fileName
    };
    const generatedFileName = await generateReport(researchData);
    const generatedFileUrl = `/reports/${generatedFileName}`;

    emitter.emit(8, 'file-completed', { 
      url: String(generatedFileUrl), 
      fileName: String(generatedFileName) 
    });

    // Step 9: Analytics summary and completion
    const totalDuration = Date.now() - (res.startTime || Date.now());
    await logAnalytics({
      step: 9,
      action: 'workflow-completion',
      duration: totalDuration,
      success: true,
      metadata: {
        topic,
        total_steps: 8,
        file_generated: !!generatedFileUrl,
        report_length: report?.length || 0
      }
    });

    // Final completion with source URLs
    const sourceUrls = answers
      .filter(a => a.sources && a.sources.length > 0)
      .flatMap(a => a.sources.map(s => s.url))
      .filter((url, index, self) => url && self.indexOf(url) === index) // Unique URLs
      .slice(0, 20); // Top 20 sources

    emitter.emit(9, 'completed', {
      message: 'Nghiên cứu chuyên sâu hoàn tất!',
      fileUrl: generatedFileUrl,
      totalSteps: 9,
      duration: totalDuration,
      sources: sourceUrls,
      summary: {
        research_questions: answers.length,
        report_sections: (report.match(/##/g) || []).length,
        word_count: String(report).split(/\s+/).length,
        source_count: sourceUrls.length
      }
    });

    // Properly close stream
    cleanup(); // Clean up heartbeat first
    emitter.emitCompleted(); // This calls res.end() internally

  } catch (error) {
    console.error(' DeepSearch Stream Error:', error);

    // Error analytics
    await logAnalytics({
      step: 0,
      action: 'workflow-error',
      duration: Date.now() - (res.startTime || Date.now()),
      success: false,
      error,
      metadata: { topic }
    });

    cleanup(); // Clean up on error first
    emitter.emitError(0, error); // This calls res.end() internally
  }
}