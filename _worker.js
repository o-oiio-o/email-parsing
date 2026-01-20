import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // =========================================================
    // 1. 配置读取 (优先从环境变量获取，否则使用默认值)
    // =========================================================
    const FORWARD_TO = env.FORWARD_TO; 
    // 默认模型，如果没有在环境变量设置 AI_MODEL，则使用原来的 mistral
    const AI_MODEL = env.AI_MODEL || '@cf/mistral/mistral-7b-instruct-v0.2';

    if (!FORWARD_TO) {
      console.error("❌ 错误: 未设置 FORWARD_TO 环境变量，无法转发邮件。");
    }

    // =========================================================
    // 2. 邮件解析 (使用 postal-mime 完美处理各种格式)
    // =========================================================
    let subject = "无主题";
    let from = "未知发件人";
    let cleanBody = "";

    try {
      // 获取原始数据的 ArrayBuffer
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parser = new PostalMime();
      const parsedEmail = await parser.parse(rawEmail);

      subject = parsedEmail.subject || "无主题";
      from = parsedEmail.from ? `${parsedEmail.from.name} <${parsedEmail.from.address}>` : message.from;

      // 智能提取内容：优先用纯文本，如果没有则用 HTML (AI 能读懂 HTML 标签，不用完全清洗)
      if (parsedEmail.text) {
        cleanBody = parsedEmail.text;
      } else if (parsedEmail.html) {
        cleanBody = parsedEmail.html; // AI 可以处理 HTML，不需要硬正则去清洗
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
      // 限制输入长度，防止 token 溢出 (截取前 4000 字符)
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
    // 4. 推送 & 转发
    // =========================================================
    ctx.waitUntil(sendToWeComBot(env, from, subject, summary));
    
    // 只有配置了转发地址才执行转发
    if (FORWARD_TO) {
      await message.forward(FORWARD_TO);
    }
  }
};

// =========================================================
// 辅助函数：企业微信推送 (保持原样，未修改)
// =========================================================
async function sendToWeComBot(env, from, subject, summary) {
  const webhookUrl = env.WECOM_WEBHOOK_URL;
  if (!webhookUrl) return;

  // 优化：基于关键词智能匹配图标
  const iconMap = [
    { icon: "🚨", keywords: ["报警", "紧急", "错误", "失败", "Alert", "Error"] },
    { icon: "💰", keywords: ["金额", "账单", "支付", "Payment", "Bill"] },
    { icon: "🔐", keywords: ["验证码", "OTP", "Code", "登录", "verify"] },
    { icon: "📦", keywords: ["快递", "发货", "Delivery"] }
  ];

  let icon = "📧"; // 默认图标
  for (const item of iconMap) {
    if (item.keywords.some(k => summary.includes(k))) {
      icon = item.icon;
      break;
    }
  }

  const textContent = `${icon} 新邮件到达
--------------------
发件人: ${from}
主　题: ${subject}
--------------------
${summary}
`;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "msgtype": "text",
        "text": { "content": textContent }
      })
    });
  } catch (err) { console.error(err); }
}
