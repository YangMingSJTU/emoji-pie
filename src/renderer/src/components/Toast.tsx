import { CheckCircle2, CircleAlert, Info } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastState {
  id: number
  message: string
  kind: ToastKind
}

interface ToastProps {
  toast: ToastState | null
}

export function Toast({ toast }: ToastProps): React.JSX.Element | null {
  if (!toast) return null
  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? CircleAlert : Info
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={18} />
      <span>{toast.message}</span>
    </div>
  )
}
