/**
 * Sentence Boundary Detection Utility with Failsafes
 * Detects complete sentences in streaming text for real-time TTS generation
 *
 * Three failsafe mechanisms:
 * 1. Punctuation detection (primary)
 * 2. Length-based flush (if buffer > 100 chars)
 * 3. Time-based flush (if > 2 seconds since last flush)
 */

export class SentenceDetector {
  constructor() {
    this.buffer = ''
    this.completeSentences = []
    // Sentence ending punctuation
    this.sentenceEnders = /[.!?]+/
    // Minimum characters for a valid sentence
    this.minSentenceLength = 10
    // Failsafe limits
    this.maxBufferLength = 100  // chars
    this.maxWaitTime = 2000     // ms
    this.lastFlush = Date.now()
  }

  /**
   * Add streaming text chunk and detect complete sentences
   * @param {string} chunk - New text chunk from LLM stream
   * @returns {string[]} Array of complete sentences detected
   */
  addChunk(chunk) {
    this.buffer += chunk
    const sentences = this.extractSentences()
    return sentences
  }

  /**
   * Extract complete sentences from buffer with failsafes
   * @returns {string[]} Complete sentences
   */
  extractSentences() {
    const sentences = []

    // Failsafe 1: Punctuation detection (primary method)
    let match
    const regex = new RegExp(this.sentenceEnders, 'g')
    let lastIndex = 0

    while ((match = regex.exec(this.buffer)) !== null) {
      const endIndex = match.index + match[0].length
      const sentence = this.buffer.substring(lastIndex, endIndex).trim()

      // Only accept sentences longer than minimum length
      if (sentence.length >= this.minSentenceLength) {
        sentences.push(sentence)
        lastIndex = endIndex
        this.lastFlush = Date.now()
      }
    }

    // Remove extracted sentences from buffer
    if (lastIndex > 0) {
      this.buffer = this.buffer.substring(lastIndex).trim()
    }

    // Failsafe 2: Length-based flush (buffer too long)
    if (this.buffer.length > this.maxBufferLength) {
      if (this.buffer.trim().length >= this.minSentenceLength) {
        console.log(`⚠️ Sentence detector: Length failsafe triggered (${this.buffer.length} chars)`)
        sentences.push(this.buffer.trim())
        this.buffer = ''
        this.lastFlush = Date.now()
      }
    }

    // Failsafe 3: Time-based flush (waiting too long)
    const timeSinceLastFlush = Date.now() - this.lastFlush
    if (timeSinceLastFlush > this.maxWaitTime && this.buffer.length >= this.minSentenceLength) {
      console.log(`⚠️ Sentence detector: Time failsafe triggered (${timeSinceLastFlush}ms)`)
      sentences.push(this.buffer.trim())
      this.buffer = ''
      this.lastFlush = Date.now()
    }

    return sentences
  }

  /**
   * Get any remaining text in buffer (for final flush)
   * @returns {string} Remaining text
   */
  getRemainder() {
    const remainder = this.buffer.trim()
    this.buffer = ''
    return remainder
  }

  /**
   * Reset the detector for a new response
   */
  reset() {
    this.buffer = ''
    this.completeSentences = []
  }

  /**
   * Check if buffer has potential incomplete sentence
   * @returns {boolean}
   */
  hasIncomplete() {
    return this.buffer.trim().length > 0
  }
}
