import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import dotenv from 'dotenv'
import { readFileSync, existsSync } from 'fs'
import { DeepgramService } from './services/deepgram.js'
import { LLMService } from './services/llm.js'
import { CartesiaService } from './services/cartesia.js'
import { WebhookService } from './services/webhook.js'
import { AsyncQueue } from './utils/async-queue.js'
import { SentenceDetector } from './utils/sentence-detector.js'

dotenv.config()

// Load pre-recorded greeting if exists (check for .wav or .mp3)
let prerecordedGreeting = null
const greetingPaths = ['./assets/greeting.wav', './assets/greeting.mp3']
for (const path of greetingPaths) {
  if (existsSync(path)) {
    prerecordedGreeting = readFileSync(path).toString('base64')
    console.log(`✅ Loaded pre-recorded greeting: ${path}`)
    break
  }
}

const app = express()
const httpServer = createServer(app)

// Configure CORS for Socket.io and Express
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://googleassistantai.netlify.app',
      'https://voicecallai.netlify.app',
      'https://voiceagent-backend-production-b679.up.railway.app',
      'http://localhost:5173',
      'http://localhost:3000'
    ]
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      console.log('CORS blocked origin:', origin)
      callback(null, false)
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400 // 24 hours
}

const io = new Server(httpServer, {
  cors: {
    origin: [
      'https://googleassistantai.netlify.app',
      'https://voicecallai.netlify.app',
      'https://voiceagent-backend-production-b679.up.railway.app',
      'http://localhost:5173',
      'http://localhost:3000'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
  transports: ['websocket', 'polling'],
  allowEIO3: true
})

const PORT = process.env.PORT || 3001

// Middleware - CORS must be first
app.use(cors(corsOptions))
app.options('*', cors(corsOptions)) // Handle preflight
app.use(express.json())

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Webhook receiver for n8n responses (Google Workspace results)
app.post('/webhook/n8n-response', async (req, res) => {
  try {
    const { sessionId: rawSessionId, result, status, summary } = req.body

    // Trim sessionId to remove any whitespace
    const sessionId = rawSessionId?.trim()

    console.log('📥 Received n8n response for session:', sessionId)
    console.log('📊 Status:', status)
    console.log('📝 Summary:', summary)

    // Find the session - try exact match first
    let session = activeSessions.get(sessionId)
    let actualSessionId = sessionId

    // Fallback: If not found, find any session with pending workspace action (single-user scenario)
    if (!session) {
      console.log('🔍 Session not found by ID, searching for pending action...')
      for (const [id, sess] of activeSessions.entries()) {
        if (sess.pendingWorkspaceAction) {
          console.log('✅ Found session with pending action:', id)
          session = sess
          actualSessionId = id
          break
        }
      }
    }

    if (!session) {
      console.warn('⚠️ No session found with pending workspace action')
      console.log('📋 Active sessions:', Array.from(activeSessions.keys()))
      return res.status(404).json({ error: 'Session not found' })
    }

    // Send acknowledgment to n8n immediately
    res.status(200).json({ success: true, message: 'Response received' })

    // Get socket for this session
    const socket = io.sockets.sockets.get(actualSessionId)

    if (!socket) {
      // Socket disconnected but session still alive (grace period)
      console.log('ℹ️ Socket disconnected, but session kept alive. Response received after user hung up.')
      console.log('📝 Response summary:', summary)

      // Clear pending action - task is complete even though user left
      session.pendingWorkspaceAction = null
      console.log('✅ Cleared pendingWorkspaceAction for disconnected session:', actualSessionId)
      return
    }

    // Process n8n response through LLM for natural, concise summary
    let responseText = ''

    if (status === 'success' && summary) {
      console.log('🤖 Processing n8n response through LLM for natural summary...')

      // Add n8n response to conversation as system message
      session.conversationHistory.push({
        role: 'user',
        content: `[System: You completed the Google Workspace task. The result is: "${summary}".

CRITICAL: Respond in FIRST PERSON as if YOU did the work yourself. Use "I", not "they" or "the agent".
Take ownership of the action. Don't reveal there's another system involved.

Examples:
- BAD: "They can add the appointment, but they need you to confirm..."
- GOOD: "I can add the appointment, but I need you to confirm..."

- BAD: "The system found 5 emails..."
- GOOD: "I found 5 emails..."

Summarize naturally in 1-2 sentences. Be helpful and conversational.]`
      })

      try {
        // Get natural summary from LLM
        const naturalSummary = await session.llm.generateResponse(session.conversationHistory)
        responseText = naturalSummary

        // Add LLM's natural summary to history
        session.conversationHistory.push({
          role: 'assistant',
          content: responseText
        })
      } catch (error) {
        console.error('❌ Failed to generate natural summary:', error)
        // Fallback to original summary
        responseText = summary
        session.conversationHistory.push({
          role: 'assistant',
          content: responseText
        })
      }
    } else if (status === 'error') {
      responseText = 'I ran into an issue completing that task. Could you try again?'
      session.conversationHistory.push({
        role: 'assistant',
        content: responseText
      })
    } else {
      responseText = 'All done! I completed that task for you.'
      session.conversationHistory.push({
        role: 'assistant',
        content: responseText
      })
    }

    // Send text response
    socket.emit('ai-response', { text: responseText, partial: true })

    // Generate and send audio response
    try {
      const audio = await session.cartesia.textToSpeech(responseText)
      socket.emit('audio-response', audio)
      console.log('✅ Sent n8n response to client via voice')
    } catch (error) {
      console.error('❌ Failed to generate audio for n8n response:', error)
    }

    socket.emit('status', 'Listening...')

    // Clear pending action after successful response
    session.pendingWorkspaceAction = null
    console.log('✅ Cleared pendingWorkspaceAction for session:', actualSessionId)

  } catch (error) {
    console.error('❌ Error handling n8n response:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Store active sessions
const activeSessions = new Map()

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

  // Initialize services for this session
  let session
  try {
    session = {
      id: socket.id,
      conversationHistory: [],
      deepgram: null,
      llm: new LLMService(),
      cartesia: new CartesiaService(),
      webhook: new WebhookService(),
      isCallActive: false,
      lastActivity: Date.now()
    }
    activeSessions.set(socket.id, session)
  } catch (error) {
    console.error(`Error initializing session [${socket.id}]:`, error)
    socket.emit('error', { message: 'Server configuration error. Please contact administrator.' })
    return
  }

  // Handle call start
  socket.on('call-start', async () => {
    console.log(`Call started: ${socket.id}`)
    session.isCallActive = true

    // Reset audio stream state variables for new call
    audioChunkCount = 0
    audioBuffer = []
    deepgramReady = false

    try {
      // Initialize Deepgram
      session.deepgram = new DeepgramService()

      // Aggressive transcript triggering (VAPI-style) with barge-in support
      let transcriptBuffer = ''
      let isProcessing = false  // Master lock to prevent concurrent pipelines
      let aiSpeaking = false
      let currentPipeline = null
      let lastProcessedText = ''  // Track what we've already processed
      let lastTriggerTime = 0  // Timestamp of last LLM trigger (prevent rapid-fire duplicates)

      session.deepgram.onTranscript((data) => {
        const { text, is_final, speech_final, confidence } = data

        // Log interim vs final
        if (!is_final) {
          console.log(`📝 Interim [${socket.id}]: "${text.substring(0, 50)}..." (conf: ${confidence.toFixed(2)})`)
        } else {
          console.log(`✅ Final [${socket.id}]: "${text}"`)
        }

        // BARGE-IN DETECTION: User speaks while AI is speaking
        if (aiSpeaking && text.trim().length > 5 && !text.startsWith(lastProcessedText)) {
          console.log(`🛑 BARGE-IN detected [${socket.id}]! Aborting AI response...`)

          // Abort current pipeline
          if (currentPipeline) {
            currentPipeline.abort()
            currentPipeline = null
          }

          // Signal frontend to stop audio
          socket.emit('barge-in')

          // Reset state for new input
          aiSpeaking = false
          isProcessing = false
          transcriptBuffer = text  // Start fresh with new input
          lastProcessedText = ''
          lastTriggerTime = 0  // Reset cooldown
          return  // Exit early, let next transcript trigger
        }

        // Only update buffer if not currently processing
        if (!isProcessing) {
          transcriptBuffer = text
        }

        // Skip if already processing
        if (isProcessing) {
          return
        }

        // CRITICAL FIX: Prevent duplicate triggers from rapid consecutive transcripts
        // Skip if this text was just processed or if we triggered very recently
        const now = Date.now()
        const timeSinceLastTrigger = now - lastTriggerTime
        const isSameText = text === lastProcessedText
        const isRapidFire = timeSinceLastTrigger < 500  // 500ms cooldown between triggers

        if (isSameText || isRapidFire) {
          if (isRapidFire && !isSameText) {
            console.log(`⏸️ Skipping trigger - too soon after last (${timeSinceLastTrigger}ms)`)
          }
          return
        }

        // Aggressive triggering conditions
        const shouldTrigger = (
          // Condition 1: Final transcript (guaranteed)
          is_final ||
          // Condition 2: High confidence interim with speech endpoint
          (confidence > 0.85 && speech_final) ||
          // Condition 3: Long stable interim with punctuation
          (text.length > 15 && /[.!?]$/.test(text) && confidence > 0.8)
        )

        if (shouldTrigger && transcriptBuffer.trim().length > 0) {
          // Lock immediately to prevent concurrent triggers
          isProcessing = true
          lastProcessedText = text
          lastTriggerTime = now

          console.log(`🚀 Triggering LLM (is_final: ${is_final}, conf: ${confidence.toFixed(2)})`)

          // Send transcript to frontend
          socket.emit('transcript', { text: transcriptBuffer })

          // Capture the text to process
          const textToProcess = transcriptBuffer

          // Clear buffer immediately to prevent re-processing
          transcriptBuffer = ''

          // Create abortable pipeline controller
          let aborted = false
          currentPipeline = {
            abort: () => {
              aborted = true
              console.log('Pipeline abort requested')
            },
            isAborted: () => aborted
          }

          // Set AI speaking flag BEFORE starting response (for barge-in detection)
          aiSpeaking = true

          // Start pipelined response
          handleUserMessage(socket, session, textToProcess, currentPipeline)
            .finally(() => {
              // Reset for next turn
              isProcessing = false
              aiSpeaking = false
              currentPipeline = null

              // Clear lastProcessedText after successful completion
              if (!aborted) {
                lastProcessedText = ''
              }
            })
        }
      })

      // Setup Deepgram error handler
      session.deepgram.onError((error) => {
        console.error(`Deepgram error [${socket.id}]:`, error)
        socket.emit('error', { message: 'Speech recognition error' })
      })

      // Start Deepgram connection
      await session.deepgram.connect()

      socket.emit('status', 'Connected - Start speaking!')

      // Send initial greeting
      const greetingText = "Hey there! I'm Tessa from Apex Solutions. I'm here to help you learn about our AI automation platform. What can I help you with today?"
      session.conversationHistory.push({ role: 'assistant', content: greetingText })
      socket.emit('ai-response', { text: greetingText })

      // Use pre-recorded greeting if available, otherwise generate with TTS
      if (prerecordedGreeting) {
        console.log('🎙️ Using pre-recorded greeting')
        socket.emit('audio-response', prerecordedGreeting)
      } else {
        console.log('🤖 Generating greeting with Cartesia')
        const greetingAudio = await session.cartesia.textToSpeech(greetingText)
        socket.emit('audio-response', greetingAudio)
      }

    } catch (error) {
      console.error(`Error starting call [${socket.id}]:`, error)
      socket.emit('error', { message: 'Failed to start call' })
    }
  })

  // Handle audio stream from client
  let audioChunkCount = 0
  let audioBuffer = [] // Buffer for audio that arrives during Deepgram connection
  let deepgramReady = false

  socket.on('audio-stream', async (audioData) => {
    audioChunkCount++
    if (audioChunkCount === 1) {
      console.log(`📥 Receiving audio from client [${socket.id}]`)
    }

    if (session.deepgram && session.isCallActive) {
      // Decode base64 to Buffer (frontend sends base64-encoded audio)
      let audioBuffer_decoded
      try {
        audioBuffer_decoded = Buffer.from(audioData, 'base64')

        if (audioChunkCount === 1) {
          console.log(`✅ Decoded audio chunk: ${audioBuffer_decoded.length} bytes`)
        }
      } catch (error) {
        console.error(`❌ Failed to decode audio [${socket.id}]:`, error)
        return
      }

      // Check if Deepgram WebSocket is actually open (state 1 = OPEN)
      const connectionState = session.deepgram.getReadyState()

      if (connectionState === 1) {
        // Deepgram is open - flush any buffered audio first
        if (audioBuffer.length > 0 && !deepgramReady) {
          console.log(`📦 Deepgram ready! Flushing ${audioBuffer.length} buffered audio chunks`)
          deepgramReady = true

          for (const bufferedAudio of audioBuffer) {
            try {
              const bufferedDecoded = Buffer.from(bufferedAudio, 'base64')
              session.deepgram.send(bufferedDecoded)
            } catch (error) {
              console.error(`Error sending buffered audio:`, error)
            }
          }
          audioBuffer = []
        }

        // Send current audio chunk (decoded Buffer)
        try {
          session.deepgram.send(audioBuffer_decoded)
        } catch (error) {
          console.error(`Error processing audio [${socket.id}]:`, error)
        }
      } else {
        // Deepgram still connecting (state 0) - buffer the audio (keep as base64 for now)
        if (audioBuffer.length === 0) {
          console.log(`⏳ Deepgram connecting (state: ${connectionState}), buffering audio...`)
        }
        audioBuffer.push(audioData)

        // Safety: limit buffer to last 20 chunks (~5 seconds)
        if (audioBuffer.length > 20) {
          audioBuffer.shift()
        }
      }
    } else {
      if (audioChunkCount === 1) {
        console.warn(`⚠️ Received audio but call not active or Deepgram not ready`)
      }
    }
  })

  // Handle call end
  socket.on('call-end', () => {
    console.log(`Call ended: ${socket.id}`)
    session.isCallActive = false
    session.lastActivity = Date.now()

    if (session.deepgram) {
      session.deepgram.disconnect()
      session.deepgram = null
    }

    socket.emit('status', 'Call ended')
  })

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)

    if (session.deepgram) {
      session.deepgram.disconnect()
    }

    // Don't immediately delete session if there's a pending workspace action
    // Keep it alive for n8n to send response back
    if (session.pendingWorkspaceAction) {
      console.log(`⏳ Session ${socket.id} has pending workspace action - keeping alive for 60s`)
      console.log(`   Action:`, session.pendingWorkspaceAction.args)
      session.disconnectedAt = Date.now()
      // Session will be cleaned up by the interval cleaner after grace period
    } else {
      // No pending actions, safe to delete immediately
      console.log(`✅ No pending actions for session ${socket.id} - deleting immediately`)
      activeSessions.delete(socket.id)
    }
  })
})

// Handle user message with VAPI-style pipelined streaming
async function handleUserMessage(socket, session, userMessage, pipeline = null) {
  try {
    // Add user message to conversation history
    session.conversationHistory.push({
      role: 'user',
      content: userMessage
    })

    socket.emit('status', 'AI is thinking...')

    // Create TTS queue for decoupled processing
    const ttsQueue = new AsyncQueue()
    const detector = new SentenceDetector()
    let fullResponse = ''
    let toolCallDetected = null

    // Start TTS worker in parallel (non-blocking)
    const ttsWorkerPromise = startTTSWorker(socket, session, ttsQueue, pipeline)

    try {
      // Stream LLM tokens (never blocks on TTS)
      console.log('🚀 Starting LLM stream...')
      for await (const chunk of session.llm.streamResponse(session.conversationHistory)) {
        // Check if pipeline was aborted (barge-in)
        if (pipeline && pipeline.isAborted()) {
          console.log('⚠️ Pipeline aborted during LLM streaming')
          break
        }

        // Check if this chunk contains a tool call
        if (chunk.includes('__tool_call')) {
          try {
            const toolData = JSON.parse(chunk)
            if (toolData.__tool_call) {
              toolCallDetected = toolData.__tool_call
              console.log('🔧 Tool call detected:', toolCallDetected.name)
              continue  // Skip this chunk, don't add to response
            }
          } catch (e) {
            // Not a tool call, process normally
          }
        }

        fullResponse += chunk

        // Detect complete sentences as tokens arrive
        const sentences = detector.addChunk(chunk)

        for (const sentence of sentences) {
          // Check abort before processing sentence
          if (pipeline && pipeline.isAborted()) {
            console.log('⚠️ Pipeline aborted during sentence detection')
            break
          }

          console.log(`📝 Sentence detected: "${sentence.substring(0, 50)}..."`)

          // Send text to frontend immediately
          socket.emit('ai-response', { text: sentence, partial: true })

          // Push to TTS queue (fire-and-forget, no await!)
          ttsQueue.push(sentence)
        }

        if (pipeline && pipeline.isAborted()) break
      }

      // Handle any remaining text in buffer
      const remainder = detector.getRemainder()
      if (remainder && remainder.length > 0 && (!pipeline || !pipeline.isAborted())) {
        console.log(`📝 Final fragment: "${remainder.substring(0, 50)}..."`)
        fullResponse += remainder
        socket.emit('ai-response', { text: remainder, partial: true })
        ttsQueue.push(remainder)
      }

      if (!pipeline || !pipeline.isAborted()) {
        console.log(`✅ LLM stream complete: "${fullResponse}"`)
      } else {
        console.log(`🛑 LLM stream aborted: "${fullResponse}"`)
      }

    } finally {
      // Close queue and wait for TTS worker to finish
      ttsQueue.close()
      await ttsWorkerPromise
    }

    // Handle tool call if detected
    if (toolCallDetected && (!pipeline || !pipeline.isAborted())) {
      console.log('🔧 Executing tool:', toolCallDetected.name)

      if (toolCallDetected.name === 'google_workspace_action') {
        try {
          const args = JSON.parse(toolCallDetected.arguments)
          console.log('📧 Google Workspace action:', args)

          // Store pending request (for matching n8n response later)
          session.pendingWorkspaceAction = {
            toolCallId: toolCallDetected.id,
            args: args,
            timestamp: Date.now()
          }
          console.log('✅ Set pendingWorkspaceAction for session:', socket.id)

          // Generate acknowledgment response
          const acknowledgments = [
            "On it, give me a moment.",
            "Let me check that for you.",
            "Sure thing, one second.",
            "Got it, checking now."
          ]
          const acknowledgment = acknowledgments[Math.floor(Math.random() * acknowledgments.length)]

          // Send acknowledgment to user
          socket.emit('ai-response', { text: acknowledgment, partial: true })
          socket.emit('status', 'Processing your request...')

          // Generate and send audio for acknowledgment
          try {
            const ackAudio = await session.cartesia.textToSpeech(acknowledgment)
            socket.emit('audio-response', ackAudio)
          } catch (audioError) {
            console.error('❌ Failed to generate acknowledgment audio:', audioError)
          }

          // Send webhook to n8n (async - don't wait for result)
          session.webhook.sendGoogleWorkspaceAction(args, socket.id)
            .then(() => console.log('✅ Google Workspace action sent to n8n'))
            .catch(err => console.error('❌ Failed to send to n8n:', err))

          // Add to conversation history
          session.conversationHistory.push({
            role: 'assistant',
            content: acknowledgment
          })

        } catch (error) {
          console.error('❌ Google Workspace action failed:', error)
          const errorMsg = "Sorry, I couldn't process that request. Please try again."
          socket.emit('ai-response', { text: errorMsg, partial: true })
          const errorAudio = await session.cartesia.textToSpeech(errorMsg)
          socket.emit('audio-response', errorAudio)
        }

        socket.emit('status', 'Listening...')
        return  // Exit early since we handled everything
      }
    }

    // Only add to history if not aborted and no tool call
    if (!pipeline || !pipeline.isAborted()) {
      // Add full response to conversation history
      session.conversationHistory.push({
        role: 'assistant',
        content: fullResponse
      })

      // Don't send complete marker - we already streamed all sentences
      // Sending it again causes "reanswering" effect on frontend
      socket.emit('status', 'Listening...')
    }

  } catch (error) {
    console.error(`Error handling message [${socket.id}]:`, error)
    socket.emit('error', { message: 'Failed to generate response' })
    socket.emit('status', 'Error - Please try again')
  }
}

// TTS Worker - processes queue sequentially (respects Cartesia concurrency limit)
async function startTTSWorker(socket, session, ttsQueue, pipeline = null) {
  console.log('🎙️ TTS worker started')
  let sentenceCount = 0

  try {
    for await (const sentence of ttsQueue) {
      // Check if pipeline was aborted
      if (pipeline && pipeline.isAborted()) {
        console.log('🛑 TTS worker aborted')
        break
      }

      if (!sentence) break

      sentenceCount++
      console.log(`🔊 TTS worker processing sentence ${sentenceCount}: "${sentence.substring(0, 30)}..."`)

      // Update status on first sentence
      if (sentenceCount === 1) {
        socket.emit('status', 'AI is speaking...')
      }

      try {
        // Generate TTS (sequential, one at a time)
        const audio = await session.cartesia.textToSpeech(sentence)

        // Check abort again before sending audio
        if (pipeline && pipeline.isAborted()) {
          console.log('🛑 TTS worker aborted before sending audio')
          break
        }

        // Send audio immediately
        socket.emit('audio-response', audio)
        console.log(`✅ TTS worker sent audio for sentence ${sentenceCount}`)
      } catch (err) {
        console.error(`❌ TTS error for sentence ${sentenceCount}:`, err.message)
        // Continue processing other sentences
      }
    }
  } finally {
    const status = (pipeline && pipeline.isAborted()) ? 'aborted' : 'completed'
    console.log(`🏁 TTS worker ${status} (processed ${sentenceCount} sentences)`)
  }
}

// Cleanup stale sessions every minute
setInterval(() => {
  const now = Date.now()
  let cleanedCount = 0

  activeSessions.forEach((session, socketId) => {
    // Clean disconnected sessions after grace period (60 seconds)
    if (session.disconnectedAt) {
      const timeSinceDisconnect = now - session.disconnectedAt
      if (timeSinceDisconnect > 60 * 1000) {
        console.log(`🧹 Cleaning disconnected session ${socketId} (${Math.round(timeSinceDisconnect / 1000)}s after disconnect)`)
        if (session.deepgram) {
          session.deepgram.disconnect()
        }
        activeSessions.delete(socketId)
        cleanedCount++
      }
    }
    // Also clean sessions inactive for more than 30 minutes
    else if (!session.isCallActive && session.lastActivity && (now - session.lastActivity) > 30 * 60 * 1000) {
      if (session.deepgram) {
        session.deepgram.disconnect()
      }
      activeSessions.delete(socketId)
      cleanedCount++
    }
  })

  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} stale sessions`)
  }
}, 60 * 1000) // Run every minute instead of every 5 minutes

// Start server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📡 WebSocket server ready`)
  console.log(`🤖 LLM Provider: ${process.env.LLM_PROVIDER || 'openai'}`)
  console.log(`🌐 CORS enabled for: https://voicecallai.netlify.app, https://voiceagent-backend-production-b679.up.railway.app, http://localhost:5173, http://localhost:3000`)
  console.log(`✅ Server ready to accept connections`)
})
