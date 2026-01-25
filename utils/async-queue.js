/**
 * AsyncQueue - Non-blocking queue for pipeline processing
 * Allows producer (LLM) to continue without waiting for consumer (TTS)
 */

export class AsyncQueue {
  constructor() {
    this.queue = []
    this.waiting = []
    this.closed = false
  }

  /**
   * Push item to queue (non-blocking, fire-and-forget)
   * @param {*} item - Item to add to queue
   */
  push(item) {
    if (this.closed) {
      console.warn('AsyncQueue: Attempted to push to closed queue')
      return
    }

    if (this.waiting.length > 0) {
      // Someone is waiting, resolve immediately
      const resolve = this.waiting.shift()
      resolve({ value: item, done: false })
    } else {
      // No one waiting, add to queue
      this.queue.push(item)
    }
  }

  /**
   * Get next item from queue (async, waits if empty)
   * @returns {Promise<any>} Next item
   */
  async next() {
    if (this.queue.length > 0) {
      return { value: this.queue.shift(), done: false }
    }

    if (this.closed) {
      return { done: true }
    }

    // Wait for next item
    return new Promise(resolve => {
      this.waiting.push(resolve)
    })
  }

  /**
   * Close queue (no more items can be added)
   */
  close() {
    this.closed = true
    // Resolve all waiting promises
    while (this.waiting.length > 0) {
      const resolve = this.waiting.shift()
      resolve({ done: true })
    }
  }

  /**
   * Clear all items from queue
   */
  clear() {
    this.queue = []
    // Notify waiting consumers
    while (this.waiting.length > 0) {
      const resolve = this.waiting.shift()
      resolve({ done: true })
    }
  }

  /**
   * Get current queue size
   * @returns {number} Number of items in queue
   */
  size() {
    return this.queue.length
  }

  /**
   * Check if queue is empty
   * @returns {boolean} True if empty
   */
  isEmpty() {
    return this.queue.length === 0 && this.waiting.length === 0
  }

  /**
   * Make queue async iterable
   */
  async *[Symbol.asyncIterator]() {
    while (true) {
      const result = await this.next()
      if (result.done) break
      yield result.value
    }
  }
}
