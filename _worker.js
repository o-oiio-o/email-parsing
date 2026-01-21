import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // =========================================================
    // 1. 配置读取
    // =========================================================
    const FORWARD_TO = env.FORWARD_TO; 
    const AI_MODEL = env.AI_MODEL || '@cf/mistral/mistral-7b-instruct-v0.2';
    const GEMINI_API_KEY = env.GEMINI_API_KEY; // 新增 Gemini API Key

    if (!FORWARD_TO) {
      console.error("❌ 错误: 未设置 FORWARD_TO 环境变量，无法转发邮件。");
    }

    // =========================================================
    // 2. 邮件解析
    // =========================================================
    let subject = "无主题";
    let from = "未知发件人";
    let cleanBody = "";

    try {
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsedEmail = await parser.parse(rawEmail);

      subject = parsedEmail.subject || "无主题";
      from = parsedEmail.from ? `${parsedEmail.from.name} <${parsedEmail.from.address}>` : message.from;

      if (parsedEmail.text) {
        cleanBody = parsedEmail.text;
      } else if (parsedEmail.html) {
        cleanBody = parsedEmail.html;
      } else {
        cleanBody = "邮件内容无法识别或为空。";
      }
    } catch (e) {
      console.error("解析邮件失败:", e);
      cleanBody = "解析邮件正文失败，无法生成摘要。";
    }

    // =========================================================
    // 3. AI 处理 (优先 Gemini 2.5 Flash)
    // =========================================================
    let summary = "";
    const inputContent = cleanBody.substring(0, 4000);
    const systemPrompt = `你是邮件审计专家。请直接输出结果，严禁重复指令中的问题，严禁使用任何 Markdown 格式（如星号 *、加粗 ** 等）。
            请按以下格式回答：
            1. 内容摘要：[在此处直接写一段话总结谁发的、什么事，不要分项，不要带星号]
            2. ⚡️抓取关键数据：[在此处直接列出验证码、金额、日期等，若没有则写“无关键数据”]`;
    const userPrompt = `邮件发件人: ${from}\n邮件主题: ${subject}\n邮件内容:\n${inputContent}`;

    try {
      if (GEMINI_API_KEY) {
        // --- 优先尝试使用 Gemini 2.5 Flash ---
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const geminiResp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [{ text: `${systemPrompt}\n\n待处理邮件如下：\n${userPrompt}` }]
            }]
          })
        });

        const geminiData = await geminiResp.json();
        if (geminiData.candidates && geminiData.candidates[0]?.content?.parts[0]?.text) {
          summary = geminiData.candidates[0].content.parts[0].text;
          console.log("✅ 使用 Gemini 2.5 Flash 生成摘要");
        } else {
          throw new Error("Gemini 返回数据异常，尝试回退到 Workers AI");
        }
      } else {
        // 未配置 Key，直接进入 Workers AI
        throw new Error("未配置 GEMINI_API_KEY");
      }
    } catch (geminiError) {
      // --- Fallback: 回退到原有的 Workers AI 逻辑 ---
      console.warn(`⚠️ 无法使用 Gemini (${geminiError.message})，正在尝试 Workers AI...`);
      try {
        const aiResponse = await env.AI.run(AI_MODEL, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        });
        summary = aiResponse.response;
        console.log("✅ 使用 Workers AI 生成摘要");
      } catch (aiError) {
        summary = `所有 AI 均不可用。Gemini 错误: ${geminiError.message}; Workers AI 错误: ${aiError.message}`;
      }
    }

    // =========================================================
    // 4. 多平台推送 & 转发
    // =========================================================
    
    // 匹配图标
    const icon = getSmartIcon(summary);
    const pushText = `${icon} 新邮件到达\n--------------------\n发件人: ${from}\n主　题: ${subject}\n--------------------\n${summary}`;

    // 企业微信推送
    if (env.WECOM_WEBHOOK_URL) {
      ctx.waitUntil(sendToWeComBot(env.WECOM_WEBHOOK_URL, pushText));
    }

    // Telegram 推送
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
      ctx.waitUntil(sendToTelegramBot(env.TG_BOT_TOKEN, env.TG_CHAT_ID, pushText));
    }
    
    // 邮件转发
    if (FORWARD_TO) {
      await message.forward(FORWARD_TO);
    }
  }
};

// =========================================================
// 辅助函数：智能图标识别
// =========================================================
function getSmartIcon(summary) {
  const iconMap = [
    { icon: "🚨", keywords: ["报警", "紧急", "错误", "失败", "Alert", "Error"] },
    { icon: "💰", keywords: ["金额", "账单", "支付", "Payment", "Bill"] },
    { icon: "🔐", keywords: ["验证码", "OTP", "Code", "登录", "verify"] },
    { icon: "📦", keywords: ["快递", "发货", "Delivery"] }
  ];
  for (const item of iconMap) {
    if (item.keywords.some(k => summary.includes(k))) return item.icon;
  }
  return "📧";
}

// =========================================================
// 辅助函数：企业微信推送
// =========================================================
async function sendToWeComBot(webhookUrl, content) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "msgtype": "text",
        "text": { "content": content }
      })
    });
  } catch (err) { console.error("WeCom推送失败:", err); }
}

// =========================================================
// 辅助函数：Telegram 推送
// =========================================================
async function sendToTelegramBot(token, chatId, content) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: content
      })
    });
    if (!resp.ok) {
      const errDetail = await resp.json();
      console.error("TG推送返回错误:", errDetail);
    }
  } catch (err) { console.error("TG网络请求失败:", err); }
}

