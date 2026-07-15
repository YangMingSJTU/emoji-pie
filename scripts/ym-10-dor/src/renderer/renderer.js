/* global document, window, HTMLButtonElement, HTMLElement */
const form = document.querySelector('#probe-form')
const runButton = document.querySelector('#run')
const result = document.querySelector('#result')

form?.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!(runButton instanceof HTMLButtonElement) || !(result instanceof HTMLElement)) return
  runButton.disabled = true
  result.textContent = '运行中…'
  try {
    const metrics = await window.ym10Probe.run({
      corpusId: document.querySelector('#corpus-id')?.value ?? '',
      input: document.querySelector('#input')?.value ?? '',
      transport: document.querySelector('#transport')?.value ?? 'fixture',
      session: document.querySelector('#session')?.value ?? 'cold'
    })
    result.textContent = JSON.stringify(metrics, null, 2)
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'probe_failed'
  } finally {
    runButton.disabled = false
  }
})
