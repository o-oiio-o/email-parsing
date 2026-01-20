export default {
  async email(message, env, ctx) {
    // =========================================================
    // 1. 配置读取 (从环境变量获取)
    // =========================================================
    const FORWARD_TO = env.FORWARD_TO;
    const AI_MODEL = env.AI_MODEL || '@cf/mistral/mistral-7b-instruct-v0.2';

    // =========================================================
    // 2. 获取并解析邮件 (增强版逻辑)
    // =========================================================
    const subject = message.headers.get("subject") || "无主题";
    const from = message.from;

    // 获取原始流并转为字符串
    const rawText = await streamToString(message.raw);
    
    // 使用增强版清洗函数，自动处理 HTML 和各种编码
    const cleanBody = smartParseEmail(rawText);

    // =========================================================
    // 3. AI 处理
    // =========================================================
    let summary = "";
    try {
      const aiResponse = await env.AI.run(AI_MODEL, {
        messages: [
          {
            role: "system",
            content: `你是邮件安全审计专家。请用【简体中文】执行：
            1. 内容摘要：是谁发的？什么事？
            2. ⚡️抓取关键数据：列出【验证码】、【OTP】、【金额】、【截止日期】。`
          },
          {
            role: "user",
            content: `主题: ${subject}\n内容:\n${cleanBody.substring(0, 3500)}`
          }
        ]
      });
      summary = aiResponse.response;
    } catch (e) {
      summary = `AI 摘要失败 (${AI_MODEL}): ${e.message}`;
    }

    // =========================================================
    // 4. 推送 & 转发
    // =========================================================
    ctx.waitUntil(sendToWeComBot(env, from, subject, summary));
    
    if (FORWARD_TO) {
      await message.forward(FORWARD_TO);
    }
  }
};

/**
 * 增强版邮件正文提取逻辑
 * 能够识别 Multipart、HTML、Base64 和 Quoted-Printable
 */
function smartParseEmail(raw) {
  try {
    // 移除 HTML 标签的辅助函数
    const stripHtml = (html) => html.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ');

    // 1. 简单的 MIME 分隔符识别
    const contentType = raw.match(/Content-Type:.*boundary="?([^";\s]+)"?/i);
    if (contentType) {
      const boundary = contentType[1];
      const parts = raw.split("--" + boundary);
      
      // 优先找 text/plain，找不到就找 text/html
      let htmlPart = "";
      for (const part of parts) {
        if (part.includes("Content-Type: text/plain")) {
          return decodeMimePart(part);
        }
        if (part.includes("Content-Type: text/html")) {
          htmlPart = decodeMimePart(part);
        }
      }
      if (htmlPart) return stripHtml(htmlPart);
    }

    // 2. 如果不是 Multipart，尝试直接解码
    return decodeMimePart(raw);
  } catch (e) {
    return raw.substring(0, 1000); 
  }
}

function decodeMimePart(part) {
  const bodyIdx = part.indexOf("\r\n\r\n");
  const headers = part.substring(0, bodyIdx);
  let body = part.substring(bodyIdx + 4);

  // 处理 Base64
  if (/Content-Transfer-Encoding: base64/i.test(headers)) {
    try {
      const base64Str = body.replace(/\s/g, "");
      return decodeURIComponent(escape(atob(base64Str)));
    } catch (e) { return body; }
  }

  // 处理 Quoted-Printable
  if (/Content-Transfer-Encoding: quoted-printable/i.test(headers)) {
    return body.replace(/=[\r\n]+/g, "").replace(/=([0-9A-F]{2})/gi, (_, c) => String.fromCharCode(parseInt(c, 16)));
  }

  return body;
}

async function streamToString(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

async function sendToWeComBot(env, from, subject, summary) {
  const webhookUrl = env.WECOM_WEBHOOK_URL;
  if (!webhookUrl) return;

  const textContent = `📧 新邮件摘要\n发件人: ${from}\n主题: ${subject}\n--------------------\n${summary}`;

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ "msgtype": "text", "text": { "content": textContent } })
  });

}
