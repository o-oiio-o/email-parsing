import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // =========================================================
    // 1. 配置读取
    // =========================================================
    const FORWARD_TO = env.FORWARD_TO; 
    const AI_MODEL = env.AI_MODEL || '@cf/mistral/mistral-7b-instruct-v0.2';

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
    // 3. AI 处理
    // =========================================================
    let summary = "";
    try {
      const inputContent = cleanBody.substring(0, 4000);
      const aiResponse = await env.AI.run(AI_MODEL, {
        messages: [
          {
            role: "system",
            content: `你是运行在 Cloudflare Workers 上的邮件安全审计与摘要专家。请用【简体中文】回答。
            执行两条指令：
            1. 内容摘要：是谁发的信？什么事？(如：服务器报警、账单待付、验证码)。
            2. ⚡️抓取关键数据：如果文中包含【验证码】、【OTP】、【金额】、【截止日期】，必须单独列出！无数据则不写。`
          },
          {
            role: "user",
            content: `邮件发件人: ${from}\n邮件主题: ${subject}\n邮件内容:\n${inputContent}`
          }
        ]
      });
      summary = aiResponse.response;
    } catch (e) {
      summary = `AI 罢工了 (${AI_MODEL}): ${e.message}`;
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
        // 移除 parse_mode: "HTML" 以避免特殊字符导致发送失败
      })
    });
    if (!resp.ok) {
      const errDetail = await resp.json();
      console.error("TG推送返回错误:", errDetail);
    }
  } catch (err) { console.error("TG网络请求失败:", err); }
}
