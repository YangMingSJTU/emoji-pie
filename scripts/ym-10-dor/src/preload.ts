import { contextBridge, ipcRenderer } from 'electron'
import type { ProbeMetrics } from './contracts'

interface ProbeApi {
  run(request: {
    corpusId: string
    input: string
    session: 'cold' | 'warm'
    transport: 'fixture' | 'openverse'
  }): Promise<ProbeMetrics>
}

const api: ProbeApi = {
  run: (request) => ipcRenderer.invoke('ym10-probe:run', request)
}

contextBridge.exposeInMainWorld('ym10Probe', api)
