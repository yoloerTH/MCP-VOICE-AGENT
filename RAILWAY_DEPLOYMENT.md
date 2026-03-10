# 🚂 Railway Deployment Guide - Voice AI Backend

## Quick Deploy to Railway

### Method 1: Deploy via Railway Dashboard (Recommended)

1. **Push to GitHub**
   ```bash
   cd voice-ai-backend
   git init
   git add .
   git commit -m "Initial Voice AI Backend"
   git push origin main
   ```

2. **Deploy on Railway**
   - Go to [Railway.app](https://railway.app)
   - Click **New Project** → **Deploy from GitHub repo**
   - Select your `voice-ai-backend` repository
   - Railway auto-detects Node.js and deploys

3. **Add Environment Variables**

   In Railway dashboard, go to **Variables** and add:

   ```env
   # Required
   DEEPGRAM_API_KEY=your_deepgram_key
   OPENAI_API_KEY=your_openai_key
   CARTESIA_API_KEY=your_cartesia_key

   # LLM Provider (openai or gemini)
   LLM_PROVIDER=openai
   OPENAI_MODEL=gpt-5.1-chat-latest

   # n8n Webhooks
   N8N_GOOGLE_WORKSPACE_WEBHOOK_URL=https://n8nsaved-production.up.railway.app/webhook/voiceaimcp

   # Optional
   PORT=3001
   NODE_ENV=production
   ```

4. **Get Your Railway URL**
   - After deployment, Railway gives you a URL like:
   - `https://voice-ai-backend-production-xyz.up.railway.app`
   - **SAVE THIS URL** - you'll need it for the frontend!

---

### Method 2: Deploy via Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
cd voice-ai-backend
railway init

# Deploy
railway up

# Add environment variables
railway variables set DEEPGRAM_API_KEY=your_key
railway variables set OPENAI_API_KEY=your_key
railway variables set CARTESIA_API_KEY=your_key
railway variables set N8N_GOOGLE_WORKSPACE_WEBHOOK_URL=https://n8nsaved-production.up.railway.app/webhook/voiceaimcp
```

---

## Post-Deployment Setup

### 1. Test Health Endpoint

```bash
curl https://your-voice-ai-backend.railway.app/health
```

Should return:
```json
{"status":"ok","timestamp":"2026-01-25T..."}
```

### 2. Test WebSocket Connection

Open browser console and run:
```javascript
const socket = io('https://your-voice-ai-backend.railway.app')
socket.on('connect', () => console.log('Connected!'))
```

### 3. Update CORS Origins (if needed)

If you deploy the frontend to a custom domain, update CORS in `server.js`:

```javascript
const allowedOrigins = [
  'https://your-frontend.netlify.app',
  'https://your-custom-domain.com',
  'http://localhost:5173'
]
```

---

## Update n8n Workflow

After deployment, update your n8n workflow to send responses to:

```
POST https://your-voice-ai-backend.railway.app/webhook/n8n-response
```

**Payload:**
```json
{
  "sessionId": "{{$json.sessionId}}",
  "status": "success",
  "summary": "Natural language summary of results"
}
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | Yes | Speech-to-text API key |
| `OPENAI_API_KEY` | Yes (if using OpenAI) | GPT API key |
| `GOOGLE_API_KEY` | Yes (if using Gemini) | Google AI API key |
| `CARTESIA_API_KEY` | Yes | Text-to-speech API key |
| `N8N_GOOGLE_WORKSPACE_WEBHOOK_URL` | Yes | n8n webhook endpoint |
| `LLM_PROVIDER` | No | `openai` or `gemini` (default: openai) |
| `OPENAI_MODEL` | No | Model name (default: gpt-5.1-chat-latest) |
| `PORT` | No | Server port (default: 3001) |

---

## Troubleshooting

### WebSocket Connection Fails
- Check Railway logs: `railway logs`
- Verify CORS origins include your frontend URL
- Ensure WebSocket is enabled (Railway supports it by default)

### Audio Not Working
- Check Deepgram API key is valid
- Check Cartesia API key is valid
- Verify microphone permissions in browser

### n8n Not Receiving Webhooks
- Verify `N8N_GOOGLE_WORKSPACE_WEBHOOK_URL` is correct
- Check n8n workflow is active
- Test webhook manually with curl

### n8n Can't Send Responses Back
- Verify Railway URL is accessible
- Check `/webhook/n8n-response` endpoint
- Verify sessionId matches

---

## Monitoring

**View Logs:**
```bash
railway logs
```

**View Metrics:**
- Go to Railway dashboard
- Check CPU, Memory, Network usage

**Common Log Messages:**
```
✅ Connected to backend: <socket-id>
📧 Google Workspace action: { action: 'gmail', request: '...' }
📤 Sending Google Workspace action to n8n
📥 Received n8n response for session: <session-id>
✅ Sent n8n response to client via voice
```

---

## Scaling

Railway auto-scales based on traffic. For production:

1. **Enable Auto-scaling** (Railway Pro plan)
2. **Add Health Checks** (already included at `/health`)
3. **Monitor Response Times**
4. **Set up Alerts** (Railway dashboard)

---

You're all set! 🚀

After deployment, update the frontend `.env` with your Railway URL!
