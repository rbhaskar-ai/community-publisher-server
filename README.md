# Agentify — Community Publisher Server

The backend server for the **Community Publisher** AI agent by [Agentify](https://agentify.pages.dev).

Handles AI article generation, 8-language translation, image upload, and publishing directly to your Gainsight Community (inSided).

---

## One-click deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rbhaskar-ai/community-publisher-server)

After deploying, add these environment variables in the Render dashboard:

| Variable | Where to find it |
|---|---|
| `INSIDED_CLIENT_ID` | Gainsight Community → Control Panel → Integrations → API |
| `INSIDED_CLIENT_SECRET` | Same as above |
| `INSIDED_REGION` | Your API region e.g. `https://api2-us-west-2.insided.com` |
| `INSIDED_AUTHOR_ID` | Your community user ID (numeric) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) — needed for AI generation only |

---

## What it does

| Action | Description |
|---|---|
| `categories` | Lists all community sections for the dropdown |
| `generate` | Uses Claude AI to write an article from a topic or URL |
| `translate` | Translates title + HTML body to any of 8 languages (Google Translate, free) |
| `articles` | Creates and optionally publishes an article via inSided API |
| `upload-image` | Uploads an image to inSided media, returns community-hosted URL |
| `fetch-article` | Fetches an existing community article URL and extracts its HTML body |

---

## Run locally

```bash
git clone https://github.com/rbhaskar-ai/community-publisher-server
cd community-publisher-server
cp .env.example .env   # fill in your credentials
npm install
node server.js
# → running on http://localhost:3001
```

---

## Widget repo

The Gainsight Community widget that connects to this server lives at:  
**[github.com/rbhaskar-ai/gainsight-publisher](https://github.com/rbhaskar-ai/gainsight-publisher)**

---

## Part of Agentify

This connector is the first agent in the **Agentify** suite — AI agents built for Gainsight Community teams.  
Learn more at [agentify.pages.dev](https://agentify.pages.dev)
