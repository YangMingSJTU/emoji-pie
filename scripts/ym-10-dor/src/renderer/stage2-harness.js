/* global document, performance, setInterval, structuredClone */
(() => {
  'use strict'
  let state = { input: '', settings: {}, previousBatch: [] }
  let heartbeatCount = 0
  let maximumHeartbeatGapMs = 0
  let lastHeartbeatAt = performance.now()

  setInterval(() => {
    const now = performance.now()
    maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, now - lastHeartbeatAt)
    lastHeartbeatAt = now
    heartbeatCount += 1
  }, 50)

  globalThis.stage2Harness = Object.freeze({
    setState(nextState) {
      state = structuredClone(nextState)
      document.querySelector('#state').textContent =
        `input=${state.input}; outputs=${state.previousBatch.length}`
    },
    showWorkerError(code, killedPid) {
      document.querySelector('#error').textContent =
        `Utility worker ${killedPid} exited (${code}). The batch is preserved and can be retried.`
    },
    snapshot() {
      return {
        state: structuredClone(state),
        heartbeatCount,
        maximumHeartbeatGapMs,
        errorText: document.querySelector('#error').textContent
      }
    }
  })
})()
