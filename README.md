# 🪄 ClaudeProxy — Gemini AI Gateway for Claude Code

A production-grade **Anthropic API-compatible gateway** that routes Claude Code requests to Google's Gemini models. Run Claude Code for free using your Gemini API keys instead of Anthropic credits.


---

## ✨ Features

- 🔄 **Full Anthropic API compatibility** — drop-in replacement, no Claude Code config changes needed
- 🚀 **Multi-key rotation** with automatic cooldown and self-healing pool
- 🧠 **Async context compaction** — handles long sessions without blocking requests
- 🔁 **Smart retry engine** — instant key rotation on 429s, fallback model switching
- 🛠️ **Tool-use support** — full MCP tool call translation between Anthropic ↔ Gemini formats
- 💭 **Extended thinking support** — Gemini thinking blocks surfaced as Anthropic thinking blocks
- 📦 **Redis-backed** — key health, compaction cache, tool ID mapping via Upstash

---

## 🚀 Quick Start

Once deployed (locally or on a hosting platform), create `.claude/settings.json` in your project root to point Claude Code at the gateway:

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://your-deployed-gateway.onrender.com",
        "ANTHROPIC_AUTH_TOKEN": "your-secret-gateway-key"
    },
    "model": "gemini-2.5-flash"
}
```

Replace `ANTHROPIC_BASE_URL` with your deployed URL and `ANTHROPIC_AUTH_TOKEN` with the `MASTER_API_KEY` you set in your `.env`.

---

## 🛠️ Self-Hosted Setup

### Prerequisites

- Node.js 18+
- An [Upstash Redis](https://upstash.com/) database (free tier works)
- One or more [Google AI Studio](https://aistudio.google.com/apikey) API keys

---

### 1. Clone the Repository

```bash
git clone https://github.com/thecoatcard/ClaudeProxy.git
cd ClaudeProxy
npm install
```

---

### 2. Configure Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Gateway authentication key (put this in ANTHROPIC_AUTH_TOKEN in Claude Code)
MASTER_API_KEY=your-secret-gateway-key

# Upstash Redis
REDIS_URL=https://your-instance.upstash.io
REDIS_TOKEN=your-upstash-token

# Gemini models
DEFAULT_MODEL=gemini-3.1-flash-lite-preview
FALLBACK_MODEL=gemini-2.5-flash

# Admin dashboard
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=your-strong-password
CRON_SECRET=any-random-secret
```

> ⚠️ Never commit `.env` — it is in `.gitignore` by default.

---

### 3. Add Your Gemini API Keys

Start the server, then open the admin dashboard at `http://localhost:3000/admin` and add your Gemini API keys through the UI.

Alternatively use the API directly:
```bash
curl -X POST http://localhost:3000/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-cron-secret" \
  -d '{"key": "AIza..."}'
```

---

### 4. Run Locally

```bash
npm run dev
```

Server starts at `http://localhost:3000`.

**Configure Claude Code for local use** — create `.claude/settings.json` in your project:

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "http://localhost:3000",
        "ANTHROPIC_AUTH_TOKEN": "your-secret-gateway-key"
    },
    "model": "gemini-2.5-flash"
}
```

---

## ☁️ Deploy to Vercel

### Fork & Deploy

1. **Fork** the repo on GitHub: `https://github.com/thecoatcard/ClaudeProxy`

2. **Import to Vercel:**
   - Go to [vercel.com/new](https://vercel.com/new)
   - Select your forked repo
   - Click **Deploy**

3. **Add Environment Variables** in Vercel dashboard → Settings → Environment Variables:

   | Variable | Value |
   |---|---|
   | `MASTER_API_KEY` | Your secret gateway key |
   | `REDIS_URL` | Your Upstash Redis URL |
   | `REDIS_TOKEN` | Your Upstash Redis token |
   | `DEFAULT_MODEL` | `gemini-3.1-flash-lite-preview` |
   | `FALLBACK_MODEL` | `gemini-2.5-flash` |
   | `ADMIN_EMAIL` | Your admin email |
   | `ADMIN_PASSWORD` | Your admin password |
   | `CRON_SECRET` | Any random string |

4. **Redeploy** after adding variables.

5. **Point Claude Code** at your Vercel URL:

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://your-app.vercel.app",
        "ANTHROPIC_AUTH_TOKEN": "your-secret-gateway-key"
    },
    "model": "gemini-2.5-flash"
}
```

> **Note:** Vercel free tier has a 60s function timeout. For long agentic sessions, Render (below) is recommended.

---

## 🐳 Deploy to Render

Render supports long-running servers — better for extended Claude Code sessions.

1. **Fork** the repo: `https://github.com/thecoatcard/ClaudeProxy`

2. **Create a new Web Service** at [render.com](https://render.com):
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (or Starter for better performance)

3. **Add Environment Variables** in Render → Environment tab (same variables as Vercel above).

4. **Deploy** — Render builds and starts the server automatically.

5. **Point Claude Code** at your Render URL:

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://your-app.onrender.com",
        "ANTHROPIC_AUTH_TOKEN": "your-secret-gateway-key"
    },
    "model": "gemini-2.5-flash"
}
```

> **Tip:** Free Render instances sleep after 15 minutes of inactivity. Use a cron job or [UptimeRobot](https://uptimerobot.com/) to ping `/api/health` every 10 minutes to keep it alive.

---

## 📁 Project Structure

```
ClaudeProxy/
├── app/
│   ├── api/
│   │   ├── v1/messages/route.ts   # Main Anthropic-compatible endpoint
│   │   ├── admin/                 # Admin dashboard APIs
│   │   └── auth/                  # Session management
│   └── admin/                     # Admin UI pages
├── lib/
│   ├── retry-engine.ts            # Multi-key rotation & retry logic
│   ├── key-manager.ts             # Redis-backed API key pool
│   ├── model-router.ts            # Anthropic→Gemini model mapping
│   └── transformers/
│       ├── request.ts             # Anthropic→Gemini request transform
│       ├── response.ts            # Gemini→Anthropic response transform
│       ├── stream.ts              # SSE streaming transformer
│       ├── compaction.ts          # Context compaction engine
│       └── tools.ts               # Tool schema translation
├── .env.example                   # Environment variable template
└── .env                           # Your local credentials (gitignored)
```

---

## 🔧 Supported Models

| Claude Code Request | Routed to |
|---|---|
| `claude-opus-4-7` | `gemini-3.1-flash-lite-preview` (default) |
| `claude-sonnet-*` | `gemini-2.5-flash` |
| `claude-haiku-*` | `gemini-2.5-flash-lite` |

Model routing is configurable via `DEFAULT_MODEL` and `FALLBACK_MODEL` env vars.

---

## 🙋 FAQ

**Q: Is this free to use?**  
A: Yes — Gemini API keys have a generous free tier at [Google AI Studio](https://aistudio.google.com/apikey). The gateway itself is open-source and free to self-host.

**Q: Where do I get Gemini API keys?**  
A: Free at [Google AI Studio](https://aistudio.google.com/apikey). The free tier includes generous daily quotas.

**Q: Can I add multiple API keys for higher throughput?**  
A: Yes. Add as many keys as you have through the admin dashboard. The gateway load-balances across all healthy keys automatically.

**Q: Does it support MCP tools?**  
A: Yes. All Anthropic tool_use blocks are translated to Gemini function calls and back, including MCP tools with special characters in their names.

---

## 📄 License

MIT — fork, deploy, and use freely.
