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
    this.model = process.env.OPENAI_MODEL || 'gpt-5.1-chat-latest'
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
  async *streamResponse(conversationHistory) {
    if (this.provider === 'openai') {
      yield* this.streamOpenAIResponse(conversationHistory)
    } else if (this.provider === 'gemini') {
      // Fallback to non-streaming for Gemini
      const response = await this.generateGeminiResponse(conversationHistory)
      yield response
    }
  }

  async *streamOpenAIResponse(conversationHistory) {
    const systemPrompt = {
      role: 'system',
      content: `You are Tessa, a voice assistant with access to Google Workspace.

Your capabilities:
1. Natural conversation - Answer questions, chat naturally
2. Google Workspace actions - Access Gmail, Calendar, Drive, Docs, Sheets
3. Book appointments and demos

Speaking style:
- Start with a short, complete sentence under 10 words
- Keep sentences brief and natural when spoken aloud
- Be warm, confident, and helpful
- Maximum 3 sentences per response

Google Workspace actions you can perform:
- Gmail: Check emails, search inbox, send emails, read specific messages
- Calendar: Check schedule, list events, create meetings
- Drive: Search files, read documents, create files
- Docs: Read documents, create new documents
- Sheets: Read spreadsheet data, update cells

When user requests Google Workspace actions:
1. Acknowledge their request naturally
2. Use the google_workspace_action tool with their request
3. Say ONLY: "Got it! Give me a second to check that for you."
4. DO NOT output JSON or technical details
5. System will handle the action and tell you the results
6. Once you get results, summarize them naturally in conversation

When user wants to book:
- Collect: name, date/time, what they want
- Once you have everything, say ONLY: "Hold on, let me register that for you"
- Then use the book_appointment tool
- DO NOT output JSON or function names`
    }

    const messages = [systemPrompt, ...conversationHistory]

    // Define available tools
    const tools = [
      {
        type: 'function',
        function: {
          name: 'google_workspace_action',
          description: 'Performs actions on Google Workspace (Gmail, Calendar, Drive, Docs, Sheets). Use this whenever the user asks to check emails, search drive, view calendar, create documents, or any Google Workspace task.',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'The type of action to perform',
                enum: ['gmail', 'calendar', 'drive', 'docs', 'sheets']
              },
              request: {
                type: 'string',
                description: 'The user\'s natural language request (e.g., "check my emails from today", "what\'s on my calendar tomorrow", "find files about project X")'
              }
            },
            required: ['action', 'request']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'book_appointment',
          description: 'Books an appointment or demo for a customer. Use this when the user wants to schedule, book, or register for something.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Customer name. Extract from conversation context or ask if not provided.'
              },
              datetime: {
                type: 'string',
                description: 'The requested date and time in natural language (e.g., "Tomorrow at 3pm", "Next Monday 2pm", "January 15th at 10am")'
              },
              details: {
                type: 'string',
                description: 'What they want to book (e.g., "Product demo", "Consultation", "Sales call")'
              }
            },
            required: ['datetime', 'details']
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
      tool_choice: 'auto'
    })

    let toolCall = null
    let toolCallId = null
    let toolName = null
    let argsBuffer = ''

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      const finishReason = chunk.choices[0]?.finish_reason

      // Handle tool calls
      if (delta?.tool_calls) {
        const tc = delta.tool_calls[0]

        if (tc.id) {
          toolCallId = tc.id
          toolName = tc.function?.name
          console.log('🔧 Tool call starting:', toolName)
        }

        if (tc.function?.arguments) {
          argsBuffer += tc.function.arguments
          console.log('🔧 Tool args chunk:', tc.function.arguments)
        }
      }

      // Handle regular content (only if not a tool call)
      if (delta?.content) {
        yield delta.content
      }

      // Check if we're done and have a tool call
      if (finishReason === 'tool_calls' && toolCallId) {
        console.log('🔧 Tool call complete:', toolName, argsBuffer)
        toolCall = {
          id: toolCallId,
          name: toolName,
          arguments: argsBuffer
        }

        // Yield special marker with tool call info
        yield JSON.stringify({ __tool_call: toolCall })
      } else if (finishReason) {
        console.log('✅ Stream finished with reason:', finishReason)
      }
    }
  }

  async generateOpenAIResponse(conversationHistory, streaming = false) {
    const systemPrompt = {
      role: 'system',
      content: `You are Tessa, a voice assistant for Apex Solutions.

Apex Solutions provides AI automation: workflow tools, analytics, team collaboration, and custom development.

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

    const systemPrompt = `You are Tessa, an AI assistant for Apex Solutions - an AI-powered business automation platform.

Your role:
- Help customers understand our platform features (workflow automation, AI analytics, team collaboration)
- Answer pricing questions (Starter: $29/mo, Pro: $99/mo, Enterprise: custom)
- Qualify leads by understanding their business needs
- Schedule demos with our sales team
- Provide friendly, efficient customer support

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
