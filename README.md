This is an email parsing and forwarding project that uses Cloudflare's Email Routing to forward emails to Email Workers, which then forward them to a specified email address.
With this project, you can transform one email address into countless email addresses with arbitrary prefixes, and it supports sending notifications of AI-parsed and summarized emails to WeChat Work, WeChat, and Telegram.

**Parameters:**
AI_MODEL: The Workers AI model, defaults to "@hf/mistral/mistral-7b-instruct-v0.2"

FORWARD_TO: The email address you want to forward to

WECOM_WEBHOOK_URL: The Webhook link for the message push bot in your WeChat Work group

TG_BOT_TOKEN: Your Telegram Bot Token (obtained from @BotFather)

TG_CHAT_ID: Your personal Chat ID, group ID, or channel ID (you can get your ID through @userinfobot), currently using a group ID


<img width="2192" height="790" alt="企业微信截图_17689012207507" src="https://github.com/user-attachments/assets/5a7dfdb4-2388-465c-aab4-c855279ce570" />


