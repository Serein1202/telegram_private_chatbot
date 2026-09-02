# 🤖 Telegram Private Chatbot (v5.4)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jikssha/telegram_private_chatbot)
![GitHub stars](https://img.shields.io/github/stars/jikssha/telegram_private_chatbot?style=social)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
[![Telegram](https://img.shields.io/badge/Telegram-DM-blue?style=social&logo=telegram)](https://t.me/vaghr_wegram_bot)

[🇺🇸 English](README_EN.md) | [🇨🇳 简体中文](README.md)

**Telegram Private Chatbot** is a high-performance, two-way private messaging bot based on **Cloudflare Workers**. It is designed to solve the problem of spam harassment on Telegram, featuring Cloudflare Turnstile human verification and smart content filtering, a powerful set of administrator commands, and a seamless message forwarding experience.

Deploy a free, enterprise-grade customer service system utilizing Cloudflare's powerful edge computing network without purchasing any servers.

---

## 📑 Table of Contents

* [✨ Key Features](#-key-features)
* [🛠️ Administrator Commands](#-administrator-commands)
* [🚀 Deployment Tutorial](#-deployment-tutorial)
    * [Method 1: One-Click Deploy via GitHub (Recommended)](#method-1-one-click-deploy-via-github-recommended-)
    * [Method 2: Manual Deployment](#method-2-manual-deployment-simple--direct)
    * [Final Step: Activate Webhook](#final-step-activate-webhook-crucial)
* [❓ FAQ](#-faq)
* [📈 Star History](#-star-history)

---

## ✨ Key Features

Version 4.0 removes all unstable external API dependencies, focusing on **extreme speed** and **absolute stability**.

| Feature | Description |
| :--- | :--- |
| **⚡ Human Verification** | Supports **Cloudflare Turnstile** enterprise-grade human verification (embedded webpage, ~5 seconds). Falls back to a local trivia quiz when Turnstile is not configured — 100% success rate. |
| **🧠 Smart Content Filtering** | Pure local rule scoring (keywords / regex / link entities). Automatically blocks ads, lead-gen, scams and porn; warns the user, does not forward, and auto-bans after 3 strikes. |
| **🛡️ Smart Anti-Spam** | **Short ID mechanism** fixes the Telegram button click failure bug. One-time verification grants **permanent disturbance-free** access; problematic users are handled by the admin via `/ban`. |
| **💬 Topic Group Management** | Utilizes **Telegram Forum Topics** to automatically create a separate topic for each private chat user, isolating messages for organized management. |
| **👮 Invisible Command System** | Automatically **intercepts** commands starting with `/` sent by users to prevent harassment. Admin commands are only effective within the administrator group. |
| **🔒 Permission Control** | Powerful command set: **Ban (/ban)**, **Unban (/unban)**, **Close (/close)**, **Trust (/trust)**, **Info (/info)**, **Cleanup (/cleanup)** and more. |
| **☁️ Serverless** | Runs entirely on Cloudflare Workers. **Zero cost**, server-free, maintenance-free, and handles high concurrency. |
| **📸 Multimedia Support** | Perfectly supports two-way forwarding of text, images, videos, files, and other message formats without losing any details. |

---

## 🛠️ Administrator Commands

> **Note**: The following commands are only effective within **topics in the administrator group**. Commands sent by users in private chats will be silently intercepted and will not disturb administrators.

| Command | Action | Scenario |
| :--- | :--- | :--- |
| `/help` | **Command Help**<br>Lists all admin commands and their purpose. | Whenever you forget a command. |
| `/close` | **Force Close Chat**<br>The bot will notify the user that the chat has ended and reject new messages. | Ticket resolved; politely ending the consultation. |
| `/open` | **Reopen Chat**<br>Resumes message forwarding for the user. | Accidental closure, or the user needs to contact again. |
| `/ban` | **Ban User**<br>The bot will completely ignore all messages from this user (no notification). | Malicious spamming, ad bots. |
| `/unban` | **Unban User**<br>Restores the user's normal communication permissions. | Giving a second chance. |
| `/trust` | **Permanent Trust**<br>The user will be permanently exempt from human verification (never expires). | Acquaintances, VIP clients, long-term partners. |
| `/reset` | **Reset Verification**<br>Forcibly clears the user's verification status; re-verification required next time. | Testing verification flow, or suspected account compromise. |
| `/info` | **View Info**<br>Displays the current user's UID, Topic ID, and profile link. | Checking user details. |
| `/cleanup` | **Batch Cleanup**<br>Scans and cleans up data for users whose topics have been deleted. | Clearing stale users. |

---

## 🔐 Advanced: Turnstile Verification + Smart Content Filtering (v5.4)

v5.4 upgrades the local trivia quiz to **Cloudflare Turnstile** and adds **smart content filtering**. New workflow:

```
Stranger DMs → Turnstile human verification (embedded page) → content analysis (local rule scoring)
    → Normal message: forwarded to the admin topic
    → Ad/abusive content: warn user + not forwarded + strike recorded (auto-ban after 3 strikes)
```

### Enable Turnstile (Optional)

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Turnstile** → **Add site**.
2. Fill in your Worker domain (e.g. `xxx.workers.dev`; also add any custom domain).
3. Copy the **Site Key** and **Secret Key**, then add them under Worker **Settings → Variables**:
    * `TURNSTILE_SITEKEY`: Site Key (plain variable)
    * `TURNSTILE_SECRET`: Secret Key (**recommended: store as Secret**)
4. If using a custom domain, also add `PUBLIC_BASE_URL` (e.g. `https://chat.example.com`); otherwise skip it.

> If these two variables are not set, the bot automatically falls back to the local trivia quiz — existing features remain unaffected.

### Smart Content Filtering (enabled by default, pure local rules)

Before forwarding, every message is scored by local rules (keywords + regex + link entities) and then triaged:

* **Block**: score reaches the threshold (default 60) — ads, lead-gen, scams and porn are blocked: the user is warned (with the reason), the message is not forwarded, and a strike is recorded. After 3 strikes the user is auto-banned (adjust `CONFIG.FILTER_STRIKE_LIMIT` at the top of `worker.js`).
* **Flag**: score is in the gray zone (default 20~59) — the message is forwarded, but the admin is first notified in the topic with the suspicious signals to review.
* **Pass**: score below threshold — forwarded normally.

Rules live in `worker.js`: `SPAM_RULE_GROUPS` (keyword weights) and `SPAM_PATTERNS` (regex features); thresholds are `FILTER_BLOCK_SCORE` / `FILTER_GRAY_SCORE` in the top `CONFIG`.

### Optional: Webhook Secret

Set the environment variable `WEBHOOK_SECRET` (any random string) and change the webhook activation URL to:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>&secret_token=<WEBHOOK_SECRET>
```

All requests without the correct secret token will be rejected (HTTP 403).

---

## 🚀 Deployment Tutorial

### Prerequisites
1.  **Telegram Bot**: Apply for a bot from [@BotFather](https://t.me/BotFather) and get the `Token`.
    * *Important*: Turn off **Group Privacy** in BotFather (`/mybots` > Settings > Group Privacy > Turn off).
2.  **Administrator Group**: Create a Telegram group and **enable Topics**.
    * Add the bot to the group and set it as an **Administrator** (grant "Manage Topics" permission).
    * Get the Group ID (usually starts with `-100`).
    > **Tip for getting SUPERGROUP_ID**: In Telegram Desktop, right-click any message in the group and copy the message link. The link will contain a segment like `-100xxxxxxxxxx` or `xxxxxxxxxx`. If you only see numbers `xxxxxxxxxx`, add `-100` in front to get the full `SUPERGROUP_ID` (same applies to private channels/groups).

### Method 1: One-Click Deploy via GitHub (Recommended ★)

This is the simplest automated deployment method. Cloudflare will automatically redeploy your Worker when you update your GitHub repository.

1.  **Fork this repository** to your GitHub account.
2.  Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
3.  Navigate to **Workers & Pages** -> **Create Application**.
4.  Click the **Connect to Git** tab.
5.  Authorize Cloudflare to access your GitHub and select the `telegram_private_chatbot` repository you just forked.
6.  **Configure Deployment**:
    * Project Name: `telegram-private-chatbot` (or any name).
    * Production Branch: Usually `main` or `master`.
    * Keep others as default and click **Save and Deploy**.
7.  **⚠️ Crucial Step: Bind Database & Variables**
    * After deployment, go to the **Settings** -> **Variables** page of the Worker.
    * **Bind KV Database** (Required):
        * In the Cloudflare sidebar menu **KV**, create a new Namespace (e.g., named `TOPIC_MAP`).
        * Go back to the Worker's Variables page, scroll down to **KV Namespace Bindings**.
        * Click **Add binding**, set Variable name to `TOPIC_MAP` (must be uppercase), and select the Namespace you just created.
    * **Add Environment Variables**:
        * `BOT_TOKEN`: Your bot token.
        * `SUPERGROUP_ID`: Your group ID (e.g., -100123...).
8.  **Final Step**: After configuration, go to the **Deployments** tab at the top, find the latest deployment record, and click **Retry deployment** on the right to apply variables.

### Method 2: Manual Deployment (Simple & Direct)

If you don't want to link GitHub, you can copy the code directly.

1.  Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/).
2.  Go to **Workers & Pages** -> **Create Application** -> **Create Worker**, start from `Hello World`.
3.  Name your Worker and click **Deploy**.
4.  Click **Edit code**, copy and paste all code from `worker.js` in this project, overwriting the original code.
5.  Click **Deploy** in the top right corner.
6.  **Configure KV & Variables**:
    * Go to **Settings** -> **Variables**.
    * Add KV Binding: Variable name `TOPIC_MAP`, bind to a KV database.
    * Add Environment Variables: `BOT_TOKEN` and `SUPERGROUP_ID`.
    * Click **Save and Deploy**.

---

### Final Step: Activate Webhook (Crucial)

Regardless of the deployment method, you must manually tell Telegram your Worker address. Visit the following URL in your browser **strictly in order**:

 **Set New Webhook**:
    ```
    [https://api.telegram.org/bot](https://api.telegram.org/bot)<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
    ```
    *Replace `<YOUR_TOKEN>` with your bot token, and `<YOUR_WORKER_URL>` with your Worker's full domain or custom domain (e.g., `https://xxx.workers.dev`).*

If it returns `{"ok":true, "result":true, "description":"Webhook was set"}`, the deployment is successful!

---

## ❓ FAQ

**Q: Why does clicking the verification button do nothing?**
A: Please check if the Webhook is set correctly. You must ensure Telegram is allowed to send `callback_query` events. Please perform the reset operation in the "Final Step" above.

**Q: Why can't the bot create topics in the group?**
A: Please ensure: 1. Group ID is correct (starts with -100); 2. Topics are enabled in the group; 3. The bot is an administrator and has "Manage Topics" permission.

**Q: Why can I pass verification but not receive forwarded messages?**
A: Carefully check all variable names and IDs, then delete the webhook and reactivate it:
 `(https://api.telegram.org/bot)<YOUR_TOKEN>/deleteWebhook?drop_pending_updates=true`

If messages still can't be forwarded, try completing all steps and add the bot's admin permission last.

**Q: Why does webhook setup fail?**
A: If your custom domain doesn't work, switch the webhook back to the `workers.dev` domain and retry. This is usually caused by domain resolution failure or network restrictions.

---

## 🔒 Security Note

> [!IMPORTANT]
> Please keep your Bot API Token (and Webhook Secret, if set) safe and never leak them — they are critical to the security of your service.

---

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jikssha/telegram_private_chatbot&type=Date)](https://star-history.com/#jikssha/telegram_private_chatbot&Date)

---
**If this project helps you, please give it a Star ⭐️!**
