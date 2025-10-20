import express from "express";
import { 
  planDeepResearch, 
  planWithGPT41, 
  confirmWithGPT41, 
  executorGemini, 
  synthesizerOpenAI, 
  generateSubQuestionsGemini,
  editResearchPlan,
  deepsearchStream,
  updateChatStep,
  collectFeedback
} from "../controllers/deepresearch.controller.js";
import Message from "../models/message.model.js";

const router = express.Router();

router.get("/ping", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send("pong deepresearch");
});

// ========== 12-STEP DEEPSEARCH STREAMING ==========
router.post("/stream", async (req, res) => {
  // Setup SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Keep-Alive", "timeout=600, max=1000");
  
  // Extended timeout for long research
  req.setTimeout(0);
  res.setTimeout(0);
  res.socket?.setKeepAlive?.(true, 30_000);
  res.flushHeaders?.();

 const { topic, fileUrl = null } = req.body;
  
  if (!topic || typeof topic !== "string" || topic.trim().length < 3) {
    res.write(`event: error\ndata: ${JSON.stringify({ 
      type: 'error', 
      error: 'Topic phải là chuỗi có ít nhất 3 ký tự' 
    })}\n\n`);
    res.end();
    return;
  }

  // Heartbeat để maintain connection (30s interval)
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }, 60000);
  
  const cleanup = () => clearInterval(heartbeat);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  try {
    await deepsearchStream({ topic, fileUrl }, res);
  } catch (error) {
    console.error('❌ DeepSearch Stream Route Error:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ 
      type: 'error', 
      error: error.message 
    })}\n\n`);
    res.end();
  } finally {
    cleanup();
  }
});

// STREAM EDIT PLAN
router.post("/plan/edit/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const { topic, plan, editInstruction } = req.body;
  
  if (!topic || !plan || !editInstruction) {
    res.write(`event: error\ndata: "Thiếu thông tin: topic, plan, và editInstruction là bắt buộc"\n\n`);
    res.end();
    return;
  }

  // Heartbeat để maintain connection
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: "ping"\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }, 60000);
  
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(heartbeat);
  };
  
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
  
  try {
    let full = "";
    const editedPlan = await editResearchPlan({
      topic,
      plan,
      editInstruction,
      opts: {
        onToken: (chunk, fullText) => {
          full = fullText;
          res.write(`event: plan-edit-chunk\ndata: ${JSON.stringify({ 
            chunk, 
            section: 'plan-edit' 
          })}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        }
      }
    });
    res.write(`event: plan-edited\ndata: ${JSON.stringify({ plan: editedPlan })}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    cleanup();
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    cleanup();
    res.end();
  }
});

// STREAM PLAN
router.post("/plan/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const { topic, fileUrl = null } = req.body;
  
  // Heartbeat để maintain connection
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: "ping"\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }, 60000);
  
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(heartbeat);
  };
  
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
  
  try {
    let full = "";
  const planResult = await planDeepResearch(topic, "google/gemini-2.5-flash-lite", {
      fileUrl,
      onToken: (chunk, fullText) => {
        full = fullText;
        // Luôn section: 'plan' cho mọi chunk
        res.write(`event: plan-chunk\ndata: ${JSON.stringify({ 
          chunk, 
          section: 'plan' 
        })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
    });
    res.write(`event: plan\ndata: ${JSON.stringify(planResult)}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    cleanup();
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    cleanup();
    res.end();
  }
});

// STREAM SUBQUESTIONS
router.post("/subquestions/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const { topic, plan, confirm } = req.body;
  if (!confirm) {
    res.write(`event: error\ndata: "Plan chưa được xác nhận"\n\n`);
    res.end();
    return;
  }

  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: "ping"\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }, 60000);
  
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(heartbeat);
  };
  
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  try {
    let full = "";
    // Xử lý plan có thể là string hoặc object từ restructured planning
    const planText = typeof plan === 'string' ? plan : (plan?.plan || '');
  const subQuestions = await generateSubQuestionsGemini(topic, planText, "google/gemini-2.5-flash", {
      onToken: (chunk, fullText) => {
        full = fullText;
        res.write(`event: subquestions-chunk\ndata: ${JSON.stringify({ chunk })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
    });
    res.write(`event: subquestions\ndata: ${JSON.stringify(subQuestions)}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    cleanup();
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    cleanup();
    res.end();
  }
});

// STREAM EXECUTE (Google fetch + Gemini)
router.post("/execute/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // tránh proxy buffer SSE
  res.setHeader("Keep-Alive", "timeout=600, max=1000");
  req.setTimeout(0);
  res.setTimeout(0);
  res.socket?.setKeepAlive?.(true, 60_000);
  res.flushHeaders?.();

  // Heartbeat để giữ kết nối không idle quá lâu
  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: "keep-alive"\n\n`);
    res.flush?.();
  }, 60000);
  const cleanup = () => clearInterval(heartbeat);
  res.on("close", cleanup);
  res.on("finish", cleanup);
  res.on("error", cleanup);

  const { subQuestions } = req.body;
  const allAnswers = [];
  try {
  for await (const answer of executorGemini(subQuestions, "google/gemini-2.5-flash", (event) => {
      if (event?.type && event?.data) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        res.flush?.();
      }
    })) {
      res.write(`event: answer\ndata: ${JSON.stringify(answer)}\n\n`);
      res.flush?.();
      allAnswers.push(answer);
    }

    // TRẢ MẢNG CÂU TRẢ LỜI TỔNG HỢP CHO FE
    res.write(`event: total-answer\ndata: ${JSON.stringify({ answers: allAnswers, count: allAnswers.length })}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    cleanup();
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    cleanup();
    res.end();
  }
});

// STREAM REPORT
router.post("/report/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Keep-Alive", "timeout=600, max=1000");
  req.setTimeout(0);
  res.setTimeout(0);
  res.socket?.setKeepAlive?.(true, 60_000);
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: "keep-alive"\n\n`);
    res.flush?.();
  }, 60000);
  
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(heartbeat);
  };
  
  res.on("close", cleanup);
  res.on("finish", cleanup);
  res.on("error", cleanup);

  const { topic, answers } = req.body;
  try {
    let full = "";
  const report = await synthesizerOpenAI(topic, answers, "openai/gpt-4.1", {
      onToken: (chunk, fullText) => {
        full = fullText;
        // luôn đẩy chunk để không idle
        res.write(`event: report-chunk\ndata: ${JSON.stringify({ chunk })}\n\n`);
        res.flush?.();
      }
    });
    res.write(`event: report\ndata: ${JSON.stringify(report)}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    cleanup();
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    cleanup();
    res.end();
  }
});

// STREAM GENERATE FILE
router.post("/generate-file/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const { topic, report } = req.body;
  try {
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
    const GeneratedfileName = await import("../handlers/generateReport.js").then(m => m.generateReport(researchData));
    const url = `/reports/${GeneratedfileName}`;
    res.write(`event: url\ndata: ${JSON.stringify(url)}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    res.end();
  }
});

// Check input
router.post("/confirm/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.trim().length < 3) {
    res.write(`event: error\ndata: "Nội dung nhập vào phải là chuỗi có ít nhất 3 ký tự"\n\n`);
    res.end();
    return;
  }

  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: "ping"\n\n`);
    if (typeof res.flush === 'function') res.flush();
  }, 60000);
  
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearInterval(heartbeat);
  };
  
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);

  try {
    let full = "";
  const confirmResult = await confirmWithGPT41(message, "google/gemini-2.5-flash-lite", {
      onToken: (chunk, fullText) => {
        full = fullText;
        res.write(`event: confirm-chunk\ndata: ${JSON.stringify({ chunk })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
    });
    res.write(`event: confirm\ndata: ${JSON.stringify(confirmResult)}\n\n`);
    res.write(`event: done\ndata: "completed"\n\n`);
    cleanup();
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    cleanup();
    res.end();
  }
});

// WORKFLOW STEP 11: Feedback Collection API
router.post("/feedback", async (req, res) => {
  try {
    const { chat_id, user_id, step, rating, comment, session_id } = req.body;
    
    if (!chat_id || !rating) {
      return res.status(400).json({ 
        error: "chat_id và rating là bắt buộc" 
      });
    }
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ 
        error: "rating phải từ 1 đến 5" 
      });
    }
    
    const { collectFeedback } = await import("../handlers/deepsearchCore.js");
    const result = await collectFeedback({
      chat_id,
      user_id,
      step,
      rating: parseInt(rating),
      comment,
      session_id
    });
    
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WORKFLOW STEP 11: Update Chat Message API
router.put("/update-message", async (req, res) => {
  try {
    const { chat_id, user_id, message_id, updates } = req.body;
    
    if (!chat_id || !message_id) {
      return res.status(400).json({ 
        error: "chat_id và message_id là bắt buộc" 
      });
    }
    
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ 
        error: "updates phải là object hợp lệ" 
      });
    }
    
    const { updateChatStep } = await import("../handlers/deepsearchCore.js");
    const result = await updateChatStep({
      chat_id,
      user_id,
      message_id,
      updates
    });
    
    if (!result) {
      return res.status(404).json({ 
        error: "Không tìm thấy message để cập nhật" 
      });
    }
    
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json({ 
      success: true, 
      message: "Cập nhật thành công",
      updated_message: result 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;