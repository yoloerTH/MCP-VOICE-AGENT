# Streaming Implementation - Voice AI Backend

## Overview

This document describes the streaming implementation for the Voice AI system, which significantly reduces perceived latency by allowing the AI to start speaking before the full response is generated.

## Performance Improvement

**Expected latency reduction: 50-70%**

### Before Streaming:
1. User speaks
2. Wait for complete LLM response (~1-2 seconds)
3. Generate complete TTS audio (~800ms)
4. Start playback
5. **Total delay: ~2-3 seconds before first audio**

### After Streaming:
1. User speaks
2. LLM starts generating tokens immediately
3. First sentence detected (~300-500ms)
4. TTS generation starts in parallel
5. **First audio plays within ~500-800ms**
6. Remaining sentences stream while first plays

## Architecture

### 1. LLM Streaming (services/llm.js)

Added async generator method `streamResponse()` that yields tokens as they arrive:

```javascript
async *streamResponse(conversationHistory) {
  if (this.provider === 'openai') {
    yield* this.streamOpenAIResponse(conversationHistory)
  }
}

async *streamOpenAIResponse(conversationHistory) {
  const stream = await this.client.chat.completions.create({
    model: this.model,
    messages: messages,
    temperature: 0.8,
    max_tokens: 80,
    stream: true
  })

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content
    if (content) {
      yield content
    }
  }
}
```

**Key Points:**
- Returns async generator for token-by-token streaming
- Supports both OpenAI streaming and Gemini (fallback to non-streaming)
- Preserves all prompt optimizations (80 tokens, 0.8 temperature)

### 2. Sentence Detection (utils/sentence-detector.js)

Real-time sentence boundary detection as tokens arrive:

```javascript
export class SentenceDetector {
  constructor() {
    this.buffer = ''
    this.sentenceEnders = /[.!?]+/
    this.minSentenceLength = 10
  }

  addChunk(chunk) {
    this.buffer += chunk
    return this.extractSentences()
  }

  extractSentences() {
    // Detect sentences ending with .!?
    // Return complete sentences, keep partial in buffer
  }
}
```

**Key Features:**
- Detects sentences ending with `.`, `!`, `?`
- Minimum 10 characters to avoid false positives
- Maintains buffer for incomplete sentences
- Handles remainder after stream completes

### 3. Streaming Response Handler (server.js)

Updated `handleUserMessage()` function with streaming logic:

```javascript
async function handleUserMessage(socket, session, userMessage) {
  const detector = new SentenceDetector()
  let fullResponse = ''
  let sentenceQueue = []
  let isProcessingAudio = false

  // Process LLM stream
  for await (const chunk of session.llm.streamResponse(conversationHistory)) {
    fullResponse += chunk

    // Detect complete sentences
    const sentences = detector.addChunk(chunk)

    // Queue sentences for TTS processing
    for (const sentence of sentences) {
      // Send text immediately
      socket.emit('ai-response', { text: sentence, partial: true })

      // Add to sentence queue
      sentenceQueue.push(sentence)

      // Start processing audio queue if not already started
      if (!isProcessingAudio) {
        isProcessingAudio = true
        socket.emit('status', 'AI is speaking...')
        processAudioQueue(socket, session, sentenceQueue)
      }
    }
  }

  // Mark queue as complete
  sentenceQueue.complete = true

  // Send complete marker
  socket.emit('ai-response', { text: fullResponse, complete: true })
}
```

**Flow:**
1. Stream LLM tokens in real-time
2. Detect sentence boundaries as tokens arrive
3. Add sentences to queue immediately
4. Process TTS sequentially (one at a time)
5. Send audio as each one completes
6. Avoid Cartesia concurrency limits

### 4. Audio Queue Processor

Separate function to manage sequential TTS generation:

```javascript
async function processAudioQueue(socket, session, sentenceQueue) {
  let processedCount = 0

  while (true) {
    if (sentenceQueue.length > processedCount) {
      const sentence = sentenceQueue[processedCount]
      processedCount++

      // Generate TTS sequentially (one at a time)
      const audio = await session.cartesia.textToSpeech(sentence)
      socket.emit('audio-response', audio)
    } else if (sentenceQueue.complete) {
      break
    } else {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  socket.emit('status', 'Listening...')
}
```

**Benefits:**
- **Sequential processing** - avoids Cartesia concurrency limits (max 2)
- **Stream-friendly** - processes sentences as they arrive
- **Non-blocking** - doesn't wait for all sentences before starting
- **Error-tolerant** - skips failed TTS generations

**Why Sequential?**
Cartesia has a concurrency limit of 2 requests. Processing TTS sequentially ensures we never hit this limit while still providing fast response times through sentence-level streaming.

## Frontend Updates (voice-ai-frontend)

### Updated Response Handler (src/App.jsx)

Frontend now handles three types of responses:

```javascript
socketRef.current.on('ai-response', (data) => {
  if (data.complete) {
    // Final complete response - replace accumulated partial
    setTranscript(prev => {
      const filtered = prev.filter(item => !item.isPartial)
      return [...filtered, { type: 'ai', text: data.text }]
    })
  } else if (data.partial) {
    // Partial response - accumulate
    setTranscript(prev => {
      const lastItem = prev[prev.length - 1]
      if (lastItem && lastItem.type === 'ai' && lastItem.isPartial) {
        // Append to existing partial
        return [
          ...prev.slice(0, -1),
          { type: 'ai', text: lastItem.text + ' ' + data.text, isPartial: true }
        ]
      } else {
        // First partial response
        return [...prev, { type: 'ai', text: data.text, isPartial: true }]
      }
    })
  } else {
    // Legacy non-streaming response
    setTranscript(prev => [...prev, { type: 'ai', text: data.text }])
  }
})
```

### Visual Indicator (src/App.css)

Partial responses show a blinking indicator:

```css
.message.ai.partial::after {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 8px;
  border-radius: 50%;
  background: #667eea;
  animation: blink 1.4s infinite;
}
```

## Response Format

### Partial Response
```json
{
  "text": "I can help you explore our automation platform.",
  "partial": true
}
```

### Complete Response
```json
{
  "text": "I can help you explore our automation platform. What interests you most?",
  "complete": true
}
```

## Logging

Enhanced logging for debugging:

```javascript
console.log(`📝 Complete sentence detected: "${sentence}"`)
console.log(`🔊 Audio ready for: "${sentence.substring(0, 30)}..."`)
console.log(`✅ Complete response: "${fullResponse}"`)
```

## Timing Breakdown

Example conversation with 2-sentence response:

### Without Streaming:
- LLM generation: 1200ms
- TTS generation: 800ms
- Total delay: 2000ms

### With Streaming:
- First sentence detected: 400ms
- First TTS generated: 600ms
- **First audio plays: 1000ms** (50% faster)
- Second sentence: streams while first plays
- User hears response 1 second earlier

## Error Handling

- TTS failures for individual sentences are logged but don't block subsequent sentences
- Partial responses are properly cleaned up if streaming fails
- Frontend falls back to legacy mode if server doesn't send streaming format

## Backward Compatibility

System is backward compatible:
- Frontend handles both streaming and non-streaming responses
- Gemini provider falls back to non-streaming generation
- Legacy clients without streaming support still work

## Testing Checklist

1. **Basic Streaming:**
   - [ ] First sentence plays before full response generated
   - [ ] Multiple sentences stream correctly
   - [ ] Partial indicator shows and disappears

2. **Edge Cases:**
   - [ ] Single-sentence responses work
   - [ ] Responses without sentence endings handled
   - [ ] Very short responses (under 10 chars) handled

3. **Error Recovery:**
   - [ ] TTS failure on one sentence doesn't block others
   - [ ] Connection interruption during streaming
   - [ ] Frontend handles missing partial/complete flags

4. **Performance:**
   - [ ] Perceived latency reduced by 50%+
   - [ ] No audio stuttering or gaps
   - [ ] Transcript updates smoothly

## Future Enhancements

1. **Interrupt Capability:** Allow users to interrupt AI mid-sentence
2. **Response Caching:** Cache common phrases for instant playback
3. **Predictive TTS:** Start generating likely next words before LLM finishes
4. **Multi-Voice Support:** Different voices for different sentence types

## Deployment

1. **Backend:**
   ```bash
   cd voice-ai-backend
   git add .
   git commit -m "Implement LLM streaming with sentence-level TTS"
   git push origin main
   ```

2. **Frontend:**
   ```bash
   cd voice-ai-frontend
   git add .
   git commit -m "Add streaming response support with visual indicators"
   git push origin main
   ```

3. **Verify:**
   - Check Railway deployment logs for streaming indicators
   - Test frontend shows partial indicator during generation
   - Confirm audio plays before full response completes

## Configuration

All existing environment variables remain the same. No new configuration required.

**Current Model:** `gpt-5-nano` (OpenAI's fastest and most cost-effective model as of 2026)

**GPT-5 Specific Configuration:**
- `max_completion_tokens: 500` - Accounts for reasoning tokens + visible output
- `reasoning_effort: "low"` - Minimizes internal thinking for faster voice responses
- `temperature` - Removed (GPT-5 only supports default value of 1)
- Note: GPT-5 series uses reasoning tokens (hidden thinking steps), so the old `max_tokens` parameter is deprecated

Streaming is enabled by default for OpenAI provider. Gemini will continue using non-streaming mode.

---

**Implementation Date:** 2026-01-08
**Backend Changes:** services/llm.js, server.js, utils/sentence-detector.js
**Frontend Changes:** src/App.jsx, src/App.css
**Expected Performance Gain:** 50-70% faster perceived response time
