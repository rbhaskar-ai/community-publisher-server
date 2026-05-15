# Community Publisher Agent — Product Code

This is the **actual product** sold on Agentify. It is a Node.js/Express server + single-page web app that lets Gainsight Community teams write, translate, and publish articles.

## What this project is
- `server.js` — Express server, runs on Render (free tier)
- `app.html` — The full web UI served by the server
- `render.yaml` — One-click Render deploy config
- `.env.example` — Template for environment variables
- `.env` — Real credentials (gitignored, never commit)

## GitHub repo
`rbhaskar-ai/community-publisher-server` (private)

## Deployed to
Buyers deploy their own instance to Render. This repo is the source they push to their own GitHub.

## Separate from
The Agentify marketing website (`rbhaskarrr/agentify`). Do NOT mix code between these two projects.

## Key env vars
- `INSIDED_CLIENT_ID` / `INSIDED_CLIENT_SECRET` — Gainsight API credentials
- `INSIDED_REGION` — e.g. `https://api2-us-west-2.insided.com`
- `INSIDED_AUTHOR_ID` — numeric user ID for article authorship
- `ANTHROPIC_API_KEY` — optional, enables AI article generation

## Running locally
```
npm install
node server.js
# open http://localhost:3001
```

## How to release a new version
1. Make changes here
2. `git push origin main`
3. Rebuild the ZIP: `zip -r community-publisher-agent-v{N}.zip . --exclude "*.git*" --exclude "node_modules/*" --exclude ".env" --exclude ".claude/*"`
4. Upload new ZIP to Gumroad product
