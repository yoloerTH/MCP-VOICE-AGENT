# 🚀 Google Workspace Integration Guide

## Overview

Your Voice AI is now integrated with Google Workspace via n8n! Users can naturally request Gmail, Calendar, Drive, Docs, and Sheets actions through voice.

## 🎯 How It Works

### The Flow:

```
User speaks: "Check my emails from today"
    ↓
Voice AI (Deepgram): Transcribes speech to text
    ↓
LLM (GPT/Gemini): Detects Google Workspace intent
    ↓
Voice AI: "Got it! Give me a second to check that for you."
    ↓
Webhook OUT: Sends request to n8n
    |
    |  (n8n processes in background)
    |  - Uses MCP tools
    |  - Searches Gmail
    |  - Formats results
    |
Webhook IN: n8n sends results back
    ↓
Voice AI: "You have 5 unread emails. The most recent is from..."
    ↓
User hears response
```

---

## 🔧 What Was Changed

### 1. **LLM Service (`services/llm.js`)**

**Updated System Prompt:**
- Added Google Workspace capabilities awareness
- Taught AI when to use the `google_workspace_action` tool
- Instructed natural conversation style

**Added New Tool:**
```javascript
{
  name: 'google_workspace_action',
  description: 'Performs Google Workspace actions',
  parameters: {
    action: 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets',
    request: 'natural language request'
  }
}
```

### 2. **Webhook Service (`services/webhook.js`)**

**Added New Method:**
```javascript
async sendGoogleWorkspaceAction(actionData, sessionId) {
  // Sends request to n8n
  // URL: https://n8nsaved-production.up.railway.app/webhook/voiceaimcp
}
```

### 3. **Server (`server.js`)**

**Added Tool Handler:**
- Detects when AI calls `google_workspace_action`
- Sends webhook to n8n (non-blocking)
- Continues conversation immediately

**Added Webhook Receiver:**
- Endpoint: `POST /webhook/n8n-response`
- Receives results from n8n
- Generates natural voice response
- Sends back to user via Socket.io

---

## 📡 n8n Workflow Setup

### Your n8n Workflow Should:

1. **Webhook Trigger**
   - URL: `https://n8nsaved-production.up.railway.app/webhook/voiceaimcp`
   - Receives: `{ sessionId, action, request, timestamp }`

2. **AI Agent Node (with MCP Tool)**
   - Connects to Google Workspace MCP server
   - Executes the requested action
   - Uses appropriate tools (gmail_search, calendar_list_events, etc.)

3. **Format Results**
   - Convert MCP response to natural language summary
   - Example: "You have 5 emails. Most recent from John about..."

4. **Webhook Response**
   - Send to Voice AI: `POST https://your-voice-ai.railway.app/webhook/n8n-response`
   - Payload:
   ```json
   {
     "sessionId": "abc123",
     "status": "success",
     "summary": "You have 5 unread emails. The most recent is from John about the project deadline."
   }
   ```

---

## 🎤 Example Conversations

### Example 1: Check Emails
```
User: "Check my emails from today"
Voice AI: "Got it! Give me a second to check that for you."
[n8n processes...]
Voice AI: "You have 3 new emails. The first one is from Sarah about the meeting..."
```

### Example 2: Calendar
```
User: "What's on my calendar tomorrow?"
Voice AI: "Let me check your schedule."
[n8n processes...]
Voice AI: "Tomorrow you have 2 meetings. At 10 AM you have a team standup, and at 2 PM..."
```

### Example 3: Drive Search
```
User: "Find files about Project X in my Drive"
Voice AI: "Searching your Drive now."
[n8n processes...]
Voice AI: "I found 5 files. The most recent is the Project X proposal from..."
```

---

## 🔧 Testing Locally

### 1. Set Environment Variable

Add to `.env`:
```env
N8N_GOOGLE_WORKSPACE_WEBHOOK_URL=https://n8nsaved-production.up.railway.app/webhook/voiceaimcp
```

### 2. Start Voice AI Server

```bash
npm run dev
```

### 3. Test with Voice Client

Say: "Check my emails"

Watch the console:
```
📧 Google Workspace action: { action: 'gmail', request: 'Check my emails' }
📤 Sending Google Workspace action to n8n
✅ Google Workspace action sent to n8n
📥 Received n8n response for session: abc123
✅ Sent n8n response to client via voice
```

---

## 🚀 Deployment

### Railway Environment Variables

Make sure these are set:
```
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
CARTESIA_API_KEY=...
N8N_GOOGLE_WORKSPACE_WEBHOOK_URL=https://n8nsaved-production.up.railway.app/webhook/voiceaimcp
```

### n8n Webhook Response URL

In your n8n workflow, set the webhook response URL to:
```
https://your-voice-ai-backend.railway.app/webhook/n8n-response
```

---

## 🎨 What AI Can Do Now

### Gmail:
- ✅ Check emails
- ✅ Search inbox
- ✅ Read specific messages
- ✅ Send emails

### Calendar:
- ✅ Check schedule
- ✅ List upcoming events
- ✅ Create meetings

### Drive:
- ✅ Search files
- ✅ Read documents
- ✅ Create files

### Docs:
- ✅ Read documents
- ✅ Create documents

### Sheets:
- ✅ Read spreadsheet data
- ✅ Update cells

---

## 🐛 Troubleshooting

### "Voice AI doesn't send webhook"
- Check `N8N_GOOGLE_WORKSPACE_WEBHOOK_URL` is set
- Verify n8n webhook is active
- Check console logs for errors

### "n8n can't send response back"
- Verify webhook response URL points to Voice AI
- Check Railway public URL is correct
- Ensure `/webhook/n8n-response` endpoint is accessible

### "AI doesn't understand Google Workspace requests"
- Check LLM service prompt is updated
- Verify `google_workspace_action` tool is defined
- Test with explicit requests like "check my gmail"

---

## 📊 Monitoring

Watch these logs:

**Voice AI:**
```
📧 Google Workspace action: ...
📤 Sending Google Workspace action to n8n
📥 Received n8n response for session: ...
✅ Sent n8n response to client via voice
```

**n8n:**
- Webhook trigger receives request
- MCP tool executes successfully
- Webhook response sent to Voice AI

---

## 🔥 Next Steps

1. **Test end-to-end** - Say "check my emails" and verify full flow
2. **Customize responses** - Tune how n8n formats results
3. **Add more actions** - Expand Google Workspace capabilities
4. **Error handling** - Improve failure messages
5. **Multi-turn conversations** - Let users ask follow-up questions

---

## 💡 Tips

- Keep n8n summaries concise (2-3 sentences max)
- Use natural language in summaries
- Handle errors gracefully
- Test with various phrasings
- Monitor webhook success rates

---

You're all set! Your Voice AI can now handle Google Workspace tasks naturally through conversation! 🎉
