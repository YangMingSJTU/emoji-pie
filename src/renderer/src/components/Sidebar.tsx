import { Cpu, Heart, History, Images, ServerCog, Sparkles } from 'lucide-react'

export type PageId = 'create' | 'local-assets' | 'history' | 'favorites' | 'runtime'

interface SidebarProps {
  page: PageId
  historyCount: number
  favoriteCount: number
  version: string
  onNavigate: (page: PageId) => void
}

const NAV_ITEMS = [
  { id: 'create' as const, label: '生成表情', icon: Sparkles },
  { id: 'local-assets' as const, label: '本地素材', icon: Images },
  { id: 'history' as const, label: '最近生成', icon: History },
  { id: 'favorites' as const, label: '我的收藏', icon: Heart },
  { id: 'runtime' as const, label: 'AI 运行时', icon: Cpu }
]

export function Brand(): React.JSX.Element {
  return (
    <div className="brand" aria-label="表情派 EmojiPie">
      <span className="brand-mark" aria-hidden="true">
        <i />
      </span>
      <span className="brand-copy">
        <strong>表情派</strong>
        <small>EMOJI PIE</small>
      </span>
    </div>
  )
}

export function Sidebar({
  page,
  historyCount,
  favoriteCount,
  version,
  onNavigate
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <nav className="sidebar-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const count = item.id === 'history' ? historyCount : item.id === 'favorites' ? favoriteCount : 0
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-button ${page === item.id ? 'is-active' : ''}`}
              onClick={() => onNavigate(item.id)}
              aria-current={page === item.id ? 'page' : undefined}
              title={item.label}
            >
              <Icon size={19} strokeWidth={2} />
              <span>{item.label}</span>
              {count > 0 && <b>{Math.min(count, 99)}</b>}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-status">
        <ServerCog size={17} />
        <div>
          <strong>本机运行时</strong>
          <span>本地模型 / Agent CLI</span>
        </div>
      </div>
      <span className="version-label">v{version}</span>
    </aside>
  )
}
