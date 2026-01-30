import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'

export class LLMService {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'openai'

    if (this.provider === 'openai') {
      this.initOpenAI()
    } else if (this.provider === 'gemini') {
      this.initGemini()
    } else {
      throw new Error(`Unsupported LLM provider: ${this.provider}`)
    }
  }

  initOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set')
    }

    this.client = new OpenAI({ apiKey })
    this.model = process.env.OPENAI_MODEL || 'gpt-4.1-mini'
  }

  initGemini() {
    const apiKey = process.env.GOOGLE_API_KEY
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY is not set')
    }

    this.client = new GoogleGenerativeAI(apiKey)
    this.model = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'
  }

  async generateResponse(conversationHistory, streaming = false) {
    try {
      if (this.provider === 'openai') {
        return await this.generateOpenAIResponse(conversationHistory, streaming)
      } else if (this.provider === 'gemini') {
        return await this.generateGeminiResponse(conversationHistory)
      }
    } catch (error) {
      console.error('LLM error:', error)
      throw error
    }
  }

  // Stream responses for real-time generation
  async *streamResponse(conversationHistory, userContext = null) {
    if (this.provider === 'openai') {
      yield* this.streamOpenAIResponse(conversationHistory, userContext)
    } else if (this.provider === 'gemini') {
      // Fallback to non-streaming for Gemini
      const response = await this.generateGeminiResponse(conversationHistory)
      yield response
    }
  }

  async *streamOpenAIResponse(conversationHistory, userContext = null) {
    // Build user context section if available
    let userContextSection = ''
    if (userContext?.preferred_name || userContext?.communication_style) {
      userContextSection = '\n\nUser Profile:\n'
      if (userContext.preferred_name) {
        userContextSection += `- Call them: ${userContext.preferred_name}\n`
      }
      if (userContext.communication_style) {
        const styleMap = {
          formal: 'professional and structured',
          casual: 'friendly and conversational',
          concise: 'brief and to the point',
          detailed: 'thorough with context'
        }
        userContextSection += `- Speak: ${styleMap[userContext.communication_style] || 'naturally'}\n`
      }
    }

    const systemPrompt = {
      role: 'system',
      content: `You are Naurra, an AI voice assistant with access to Google Workspace.

Your capabilities:
1. Natural conversation - Answer questions, chat naturally
2. Google Workspace actions - Access Gmail, Calendar, Drive, Docs, Sheets via intelligent agent
   - This includes creating calendar events, scheduling meetings, and managing appointments
${userContextSection}
Speaking style:
- Start with a short, complete sentence under 10 words
- Keep sentences brief and natural when spoken aloud
- Be warm, confident, and helpful
- Maximum 3 sentences per response

CRITICAL - Google Workspace Task Handling:

**IMPORTANT: ONE Tool Call Per User Request**
- NEVER make multiple parallel tool calls
- If user asks for multiple tasks (e.g., "create a document and email it to John"),
  combine ALL tasks into ONE clear request message
- The MCP agent is intelligent and can handle multi-step, complex tasks from a single request

**For SIMPLE queries (reading/checking):**
- User asks to check/read/search something → Use tool IMMEDIATELY
- Examples: "What's on my calendar?", "Check my emails", "Find my document"
- Say: "Let me check that for you" → Call tool

**For COMPLEX requests (sending/creating/modifying):**
- User asks to send email, create document, schedule meeting, etc.
- First CONFIRM the request naturally before calling the tool
- Repeat back what you understood in 1 sentence
- Wait for user confirmation ("yes", "correct", "that's right")
- Then call the tool with ALL tasks combined in the request

Examples:

Simple (immediate):
- User: "What's on my calendar tomorrow?"
  → Say: "Let me check that for you"
  → Call tool: "Check user's calendar for tomorrow"

Complex (confirm first):
- User: "Send an email to Thanos saying be there at 5pm"
  → Say: "Just to confirm, you want me to email Thanos and let them know to be there at 5pm, correct?"
  → Wait for "yes"
  → Call tool: "Send email to Thanos with message about being there at 5pm"

- User: "Schedule a meeting with the team next Tuesday"
  → Say: "Got it, you'd like me to schedule a meeting with the team next Tuesday. Should I go ahead?"
  → Wait for confirmation
  → Call tool with action: "calendar", request: "Create calendar event for team meeting next Tuesday"

- User: "Book a dentist appointment tomorrow at 5pm"
  → Say: "Just to confirm, you want me to create a calendar event for a dentist appointment tomorrow at 5pm, correct?"
  → Wait for confirmation
  → Call tool with action: "calendar", request: "Create calendar event for dentist appointment tomorrow at 5pm"

**Multi-step tasks (combine into ONE request):**
- User: "Create a document about project updates and email it to John"
  → Say: "Got it, you want me to create a document about project updates and send it to John via email, correct?"
  → Wait for confirmation
  → Call tool ONCE with action: "gmail", request: "Create a new document about project updates and email it to John"

- User: "Find my presentation and share it with the team"
  → Say: "Just to confirm, find your presentation and share it with the team?"
  → Wait for confirmation
  → Call tool ONCE with action: "drive", request: "Find user's presentation and share it with the team"

After confirmation, say: "On it, give me a moment"

DO NOT ask for technical details like email addresses - the MCP agent handles that.
The MCP agent has full access to Google Workspace and will ask for specifics if needed.
The MCP agent can handle complex, multi-step tasks from a single clear request.`
    }

    const messages = [systemPrompt, ...conversationHistory]

    // Define available tools
    const tools = [
      {
        type: 'function',
        function: {
          name: 'google_workspace_action',
          description: 'Performs actions on Google Workspace (Gmail, Calendar, Drive, Docs, Sheets). Use this for ALL Google Workspace tasks. IMPORTANT: Only call this tool ONCE per user request. If the user asks for multiple tasks (e.g., create doc AND email it), combine them into ONE request - the MCP agent can handle multi-step tasks.',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'The primary type of action to perform (choose the most relevant one if multi-step)',
                enum: ['gmail', 'calendar', 'drive', 'docs', 'sheets']
              },
              request: {
                type: 'string',
                description: 'The user\'s complete natural language request with ALL details and ALL tasks. Examples: "check my emails from today", "create a calendar event tomorrow at 5pm for dentist appointment", "create a new document about project updates and email it to John", "find my presentation and share it with the team"'
              }
            },
            required: ['action', 'request']
          }
        }
      }
    ]

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages,
      max_completion_tokens: 333,
      stream: true,
      tools: tools,
      tool_choice: 'auto',
      parallel_tool_calls: false  // Disable parallel tool calls - we want ONE request with ALL tasks
    })

    // Support multiple parallel tool calls
    const toolCalls = new Map() // Map of index -> { id, name, argsBuffer }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      const finishReason = chunk.choices[0]?.finish_reason

      // Handle tool calls (can be multiple in parallel)
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0

          // Initialize tool call if this is the first chunk for this index
          if (tc.id) {
            toolCalls.set(index, {
              id: tc.id,
              name: tc.function?.name,
              argsBuffer: ''
            })
            console.log(`🔧 Tool call starting (index ${index}):`, tc.function?.name)
          }

          // Append arguments to the appropriate tool call
          if (tc.function?.arguments) {
            const toolCall = toolCalls.get(index)
            if (toolCall) {
              toolCall.argsBuffer += tc.function.arguments
              console.log(`🔧 Tool args chunk (index ${index}):`, tc.function.arguments)
            }
          }
        }
      }

      // Handle regular content (only if not a tool call)
      if (delta?.content) {
        yield delta.content
      }

      // Check if we're done and have tool calls
      if (finishReason === 'tool_calls' && toolCalls.size > 0) {
        const completedToolCalls = Array.from(toolCalls.values()).map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.argsBuffer
        }))

        console.log(`🔧 Tool calls complete (${completedToolCalls.length} total):`,
          completedToolCalls.map(tc => `${tc.name}`).join(', '))

        // Yield all tool calls
        yield JSON.stringify({ __tool_calls: completedToolCalls })
      } else if (finishReason) {
        console.log('✅ Stream finished with reason:', finishReason)
      }
    }
  }

  async generateOpenAIResponse(conversationHistory, streaming = false) {
    const systemPrompt = {
      role: 'system',
      content: `You are Naurra, an AI voice assistant for Naurra.ai.

Naurra.ai provides intelligent workspace automation through voice and chat interfaces, with deep Google Workspace integration for seamless productivity.

Speaking style:
- Start every response with a short, complete sentence under 10 words
- Use simple, clear sentences that flow naturally when spoken aloud
- Keep each sentence brief and end it cleanly
- Speak conversationally like you're talking to a friend
- Be warm, confident, and helpful

Response structure:
- Maximum 3 sentences per response
- First sentence immediately answers or acknowledges
- Follow with 1-2 short supporting sentences if needed
- Pause between thoughts so the user can respond
- Ask clarifying questions when helpful

Your goal is helping customers understand our platform, answering questions, and connecting them with our team for demos.`
    }

    const messages = [systemPrompt, ...conversationHistory]

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: messages,
      max_completion_tokens: 333,
      stream: streaming
    })

    if (streaming) {
      return completion // Return stream object
    }

    return completion.choices[0].message.content
  }

  async generateGeminiResponse(conversationHistory) {
    const model = this.client.getGenerativeModel({ model: this.model })

    const systemPrompt = `You are Naurra, an AI assistant for Naurra.ai - an intelligent workspace automation platform.

Your role:
- Help users manage their Google Workspace through voice and chat commands
- Assist with Gmail, Calendar, Drive, Docs, Sheets, and other Google services
- Execute tasks intelligently and efficiently
- Provide a seamless, conversational experience
- Handle complex multi-step workflows with ease

Voice conversation rules:
- Keep responses under 2-3 sentences (this is voice, not text)
- Sound natural and conversational like a helpful human
- If you don't know something specific, offer to connect them with the team
- Remember customer details mentioned in the conversation
- Be professional but warm and approachable
- Ask clarifying questions when needed`

    // Convert conversation history to Gemini format
    const chat = model.startChat({
      history: conversationHistory.slice(0, -1).map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      })),
      generationConfig: {
        maxOutputTokens: 80,
        temperature: 0.8
      }
    })

    // Get the last user message
    const lastMessage = conversationHistory[conversationHistory.length - 1]
    const prompt = `${systemPrompt}\n\nUser: ${lastMessage.content}`

    const result = await chat.sendMessage(prompt)
    const response = await result.response
    return response.text()
  }
}
