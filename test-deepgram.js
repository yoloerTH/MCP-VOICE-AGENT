import { createClient } from '@deepgram/sdk'

const apiKey = '6b85276eddfbf78392e2368751679f88cef700a3'

async function testDeepgram() {
  try {
    console.log('Testing Deepgram API key...')

    const client = createClient(apiKey)

    // Test by getting project info
    const result = await client.manage.getProjects()

    console.log('✅ Deepgram API key is valid!')
    console.log('Projects:', result)

  } catch (error) {
    console.error('❌ Deepgram API key test failed!')
    console.error('Error:', error.message)
    console.error('\nPossible issues:')
    console.error('1. API key is invalid or expired')
    console.error('2. No credits remaining')
    console.error('3. API key needs activation')
    console.error('\nPlease check: https://console.deepgram.com')
  }
}

testDeepgram()
