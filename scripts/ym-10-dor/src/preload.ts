import { contextBridge, ipcRenderer } from 'electron'
import type { KeywordPlan, ProbeMetrics } from './contracts'

interface ProbeApi {
  plan(input: string): Promise<KeywordPlan>
  run(request: {
    corpusId: string
    confirmedKeywords: string[]
    session: 'cold' | 'warm'
    transport: 'fixture' | 'openverse'
  }): Promise<ProbeMetrics>
}

const api: ProbeApi = {
  plan: (input) => ipcRenderer.invoke('ym10-probe:plan', { input }),
  run: (request) => ipcRenderer.invoke('ym10-probe:run', request)
}

contextBridge.exposeInMainWorld('ym10Probe', api)
