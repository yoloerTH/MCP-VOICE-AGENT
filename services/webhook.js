import axios from 'axios'

export class WebhookService {
  constructor() {
    this.bookingWebhookUrl = process.env.N8N_WEBHOOK_URL
    this.googleWorkspaceWebhookUrl = process.env.N8N_GOOGLE_WORKSPACE_WEBHOOK_URL || 'https://n8nsaved-production.up.railway.app/webhook/voiceaimcp'

    console.log('🔗 Google Workspace Webhook URL:', this.googleWorkspaceWebhookUrl)

    if (this.bookingWebhookUrl) {
      console.log('🔗 Booking Webhook URL:', this.bookingWebhookUrl)
    }
  }

  async sendBooking(bookingData) {
    if (!this.bookingWebhookUrl) {
      throw new Error('Booking webhook URL not configured')
    }

    try {
      console.log('📤 Sending booking to n8n:', bookingData)

      const response = await axios.post(this.bookingWebhookUrl, {
        name: bookingData.name,
        datetime: bookingData.datetime,
        details: bookingData.details,
        timestamp: new Date().toISOString()
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      })

      console.log('✅ Booking sent successfully to n8n')
      return { success: true, data: response.data }

    } catch (error) {
      console.error('❌ Failed to send booking to n8n:', error.message)
      console.error('❌ Webhook URL:', this.bookingWebhookUrl)
      console.error('❌ Status:', error.response?.status)
      console.error('❌ Response:', error.response?.data)
      throw new Error('Failed to register booking')
    }
  }

  async sendGoogleWorkspaceAction(actionData, sessionId) {
    try {
      console.log('📤 Sending Google Workspace action to n8n:', actionData)

      const response = await axios.post(this.googleWorkspaceWebhookUrl, {
        sessionId: sessionId,
        action: actionData.action,
        request: actionData.request,
        timestamp: new Date().toISOString()
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 seconds for Google Workspace tasks
      })

      console.log('✅ Google Workspace action sent to n8n')
      return { success: true, data: response.data }

    } catch (error) {
      console.error('❌ Failed to send Google Workspace action:', error.message)
      console.error('❌ Webhook URL:', this.googleWorkspaceWebhookUrl)
      console.error('❌ Status:', error.response?.status)
      console.error('❌ Response:', error.response?.data)
      throw new Error('Failed to execute Google Workspace action')
    }
  }
}
