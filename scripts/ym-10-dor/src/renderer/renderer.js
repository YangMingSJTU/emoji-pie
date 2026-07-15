/* global document, window, HTMLButtonElement, HTMLElement, HTMLTextAreaElement */
const form = document.querySelector('#probe-form')
const input = document.querySelector('#input')
const planButton = document.querySelector('#plan')
const confirmButton = document.querySelector('#confirm')
const cancelButton = document.querySelector('#cancel')
const panel = document.querySelector('#keyword-panel')
const keywords = document.querySelector('#keywords')
const planStatus = document.querySelector('#plan-status')
const result = document.querySelector('#result')
let plannedInput = ''

function resetConfirmation(message = '') {
  plannedInput = ''
  if (panel instanceof HTMLElement) panel.hidden = true
  if (keywords instanceof HTMLTextAreaElement) keywords.value = ''
  if (planStatus instanceof HTMLElement) planStatus.textContent = message
}

input?.addEventListener('input', () => resetConfirmation('输入已改变，请重新本地规划。'))
cancelButton?.addEventListener('click', () => resetConfirmation('已取消；未发送请求，也未消耗配额。'))

form?.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!(input instanceof HTMLTextAreaElement) || !(planButton instanceof HTMLButtonElement) ||
    !(panel instanceof HTMLElement) || !(keywords instanceof HTMLTextAreaElement) ||
    !(planStatus instanceof HTMLElement)) return
  planButton.disabled = true
  planStatus.textContent = '仅在本地规划中…'
  try {
    const plan = await window.ym10Probe.plan(input.value)
    plannedInput = input.value
    keywords.value = plan.keywords.join('\n')
    panel.hidden = false
    planStatus.textContent = plan.status === 'ready'
      ? '请编辑、确认或取消以下 1–3 个关键词；确认前不会联网。'
      : '无法安全生成关键词。请手动填写 1–3 个关键词后确认，或取消。'
  } catch (error) {
    resetConfirmation(error instanceof Error ? error.message : 'keyword_plan_failed')
  } finally {
    planButton.disabled = false
  }
})

confirmButton?.addEventListener('click', async () => {
  if (!(input instanceof HTMLTextAreaElement) || !(confirmButton instanceof HTMLButtonElement) ||
    !(result instanceof HTMLElement) || !(keywords instanceof HTMLTextAreaElement)) return
  if (!plannedInput || input.value !== plannedInput) {
    resetConfirmation('输入已改变，请重新本地规划。')
    return
  }
  const confirmedKeywords = keywords.value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
  confirmButton.disabled = true
  result.textContent = '已确认关键词，运行中…'
  try {
    const metrics = await window.ym10Probe.run({
      corpusId: document.querySelector('#corpus-id')?.value ?? '',
      confirmedKeywords,
      transport: document.querySelector('#transport')?.value ?? 'fixture',
      session: document.querySelector('#session')?.value ?? 'cold'
    })
    result.textContent = JSON.stringify(metrics, null, 2)
    resetConfirmation('本批次已完成；再次运行需重新规划并确认。')
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'probe_failed'
  } finally {
    confirmButton.disabled = false
  }
})
