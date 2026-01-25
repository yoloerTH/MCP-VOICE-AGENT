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
    const { sessionId, result, status, summary } = req.body

    console.log('📥 Received n8n response for session:', sessionId)
    console.log('📊 Status:', status)
    console.log('📝 Summary:', summary)

    // Find the session
    const session = activeSessions.get(sessionId)

    if (!session) {
      console.warn('⚠️ Session not found:', sessionId)
      return res.status(404).json({ error: 'Session not found' })
    }

    // Send acknowledgment to n8n immediately
    res.status(200).json({ success: true, message: 'Response received' })

    // Get socket for this session
    const socket = io.sockets.sockets.get(sessionId)

    if (!socket) {
      console.warn('⚠️ Socket not found for session:', sessionId)
      return
    }

    // Generate natural language response from n8n results
    let responseText = ''

    if (status === 'success') {
      responseText = summary || 'All done! I completed that task for you.'
    } else {
      responseText = 'I ran into an issue completing that task. Could you try again?'
    }

    // Add to conversation history
    session.conversationHistory.push({
      role: 'user',
      content: '[System: Task completed]'
    })

    session.conversationHistory.push({
      role: 'assistant',
      content: responseText
    })

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

    // Clear pending action
    if (session.pendingWorkspaceAction) {
      session.pendingWorkspaceAction = null
    }

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

    try {
      // Initialize Deepgram
      session.deepgram = new DeepgramService()

      // Aggressive transcript triggering (VAPI-style) with barge-in support
      let transcriptBuffer = ''
      let isProcessing = false  // Master lock to prevent concurrent pipelines
      let aiSpeaking = false
      let currentPipeline = null
      let lastProcessedText = ''  // Track what we've already processed

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
          return  // Exit early, let next transcript trigger
        }

        // Only update buffer if not currently processing
        if (!isProcessing) {
          transcriptBuffer = text
        }

        // Skip if already processing or text already processed
        if (isProcessing || text === lastProcessedText) {
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

              // Only clear lastProcessedText if not aborted (barge-in)
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
      // Check if Deepgram WebSocket is actually open (state 1 = OPEN)
      const connectionState = session.deepgram.getReadyState()

      if (connectionState === 1) {
        // Deepgram is open - flush any buffered audio first
        if (audioBuffer.length > 0 && !deepgramReady) {
          console.log(`📦 Deepgram ready! Flushing ${audioBuffer.length} buffered audio chunks`)
          deepgramReady = true

          for (const bufferedAudio of audioBuffer) {
            try {
              session.deepgram.send(bufferedAudio)
            } catch (error) {
              console.error(`Error sending buffered audio:`, error)
            }
          }
          audioBuffer = []
        }

        // Send current audio chunk
        try {
          session.deepgram.send(audioData)
        } catch (error) {
          console.error(`Error processing audio [${socket.id}]:`, error)
        }
      } else {
        // Deepgram still connecting (state 0) - buffer the audio
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

    activeSessions.delete(socket.id)
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
          if (!session.pendingWorkspaceAction) {
            session.pendingWorkspaceAction = {
              toolCallId: toolCallDetected.id,
              args: args
            }
          }

          // Send webhook to n8n (async - don't wait for result)
          session.webhook.sendGoogleWorkspaceAction(args, socket.id)
            .then(() => console.log('✅ Google Workspace action sent to n8n'))
            .catch(err => console.error('❌ Failed to send to n8n:', err))

          // Add tool call to conversation history
          session.conversationHistory.push({
            role: 'assistant',
            content: fullResponse
          })

          // Immediately continue conversation - don't wait for n8n
          // (n8n will send results via webhook later)
          socket.emit('status', 'Processing your request...')

        } catch (error) {
          console.error('❌ Google Workspace action failed:', error)
          const errorMsg = "Sorry, I couldn't process that request. Please try again."
          socket.emit('ai-response', { text: errorMsg, partial: true })
          const errorAudio = await session.cartesia.textToSpeech(errorMsg)
          socket.emit('audio-response', errorAudio)
        }
      } else if (toolCallDetected.name === 'book_appointment') {
        try {
          const args = JSON.parse(toolCallDetected.arguments)
          console.log('📅 Booking appointment:', args)

          // Send webhook to n8n
          const result = await session.webhook.sendBooking(args)

          // Add tool result to conversation history
          session.conversationHistory.push({
            role: 'assistant',
            content: fullResponse,
            tool_calls: [{
              id: toolCallDetected.id,
              type: 'function',
              function: {
                name: toolCallDetected.name,
                arguments: toolCallDetected.arguments
              }
            }]
          })

          session.conversationHistory.push({
            role: 'tool',
            tool_call_id: toolCallDetected.id,
            content: JSON.stringify({ success: true, message: 'Booking registered successfully' })
          })

          console.log('✅ Booking sent to n8n successfully')

          // Generate confirmation response
          const confirmationResponse = `All set! I've registered your appointment for ${args.datetime}.`

          // Send confirmation to user
          socket.emit('ai-response', { text: confirmationResponse, partial: true })

          // Generate confirmation audio
          const confirmAudio = await session.cartesia.textToSpeech(confirmationResponse)
          socket.emit('audio-response', confirmAudio)

          // Add confirmation to history
          session.conversationHistory.push({
            role: 'assistant',
            content: confirmationResponse
          })

        } catch (error) {
          console.error('❌ Booking failed:', error)
          const errorMsg = "Sorry, I couldn't complete the booking. Please try again."
          socket.emit('ai-response', { text: errorMsg, partial: true })
          const errorAudio = await session.cartesia.textToSpeech(errorMsg)
          socket.emit('audio-response', errorAudio)
        }
      }

      socket.emit('status', 'Listening...')
      return  // Exit early since we handled everything
    }

    // Only add to history if not aborted and no tool call
    if (!pipeline || !pipeline.isAborted()) {
      // Add full response to conversation history
      session.conversationHistory.push({
        role: 'assistant',
        content: fullResponse
      })

      // Send complete marker
      socket.emit('ai-response', { text: fullResponse, complete: true })
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

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now()
  let cleanedCount = 0

  activeSessions.forEach((session, socketId) => {
    // If session is inactive for more than 30 minutes, clean it up
    if (!session.isCallActive && session.lastActivity && (now - session.lastActivity) > 30 * 60 * 1000) {
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
}, 5 * 60 * 1000)

// Start server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📡 WebSocket server ready`)
  console.log(`🤖 LLM Provider: ${process.env.LLM_PROVIDER || 'openai'}`)
  console.log(`🌐 CORS enabled for: https://voicecallai.netlify.app, https://voiceagent-backend-production-b679.up.railway.app, http://localhost:5173, http://localhost:3000`)
  console.log(`✅ Server ready to accept connections`)
})
