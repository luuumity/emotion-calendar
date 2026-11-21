import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../context/AuthContext'

const TAB_PATHS = ['/', '/insights', '/chat', '/settings'] as const

function tabIndexFor(pathname: string) {
  if (pathname === '/' || pathname.startsWith('/day/')) return 0
  if (pathname.startsWith('/insights')) return 1
  if (pathname.startsWith('/chat')) return 2
  if (pathname.startsWith('/settings') || pathname.startsWith('/access')) return 3
  return -1
}

const SWIPE_IGNORE = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.gacha-stage',
  '.swatch',
  '.chat-sidebar-overlay',
  '.chat-session-list',
  '[data-no-swipe]'
].join(',')

export function CapsuleMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <g transform="rotate(-38 20 20)">
        <rect x="6" y="12" width="28" height="16" rx="8" fill="#ff6b5a" />
        <path d="M20 12h6a8 8 0 0 1 0 16h-6z" fill="#6f9a78" />
        <rect x="6" y="12" width="28" height="16" rx="8" fill="none" stroke="#2f2a25" strokeWidth="2.2" />
        <path d="M20 12v16" stroke="#2f2a25" strokeWidth="2.2" />
        <circle cx="13" cy="17" r="2.2" fill="#fff8f0" opacity="0.8" />
      </g>
    </svg>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [slideDir, setSlideDir] = useState<'from-left' | 'from-right' | null>(null)
  const pendingSwipe = useRef<-1 | 0 | 1>(0)
  const slideTimer = useRef<number | null>(null)

  const hideChatFab =
    location.pathname.startsWith('/chat') ||
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/access')

  // 滑动切换后，等新页面渲染完再播放入场动画
  useLayoutEffect(() => {
    if (!pendingSwipe.current) return
    const dir = pendingSwipe.current
    pendingSwipe.current = 0
    setSlideDir(dir > 0 ? 'from-right' : 'from-left')
    if (slideTimer.current) window.clearTimeout(slideTimer.current)
    slideTimer.current = window.setTimeout(() => {
      setSlideDir(null)
      slideTimer.current = null
    }, 260)
  }, [location.pathname])

  useEffect(() => {
    return () => {
      if (slideTimer.current) window.clearTimeout(slideTimer.current)
    }
  }, [])

  // 左右滑动切换顶部选项卡
  useEffect(() => {
    let startX = 0
    let startY = 0
    let startAt = 0
    let tracking = false

    const shouldIgnore = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el) return true
      if (el.closest(SWIPE_IGNORE)) return true
      let node: HTMLElement | null = el
      while (node) {
        const style = window.getComputedStyle(node)
        if (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          node.scrollWidth > node.clientWidth + 4
        ) {
          return true
        }
        node = node.parentElement
      }
      return false
    }

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || shouldIgnore(event.target)) {
        tracking = false
        return
      }
      startX = event.touches[0].clientX
      startY = event.touches[0].clientY
      startAt = Date.now()
      tracking = true
    }

    const onEnd = (event: TouchEvent) => {
      if (!tracking) return
      tracking = false
      const touch = event.changedTouches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (Date.now() - startAt > 800) return
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return

      const index = tabIndexFor(location.pathname)
      const next = index + (dx < 0 ? 1 : -1)
      if (index < 0 || next < 0 || next >= TAB_PATHS.length) return

      event.preventDefault()
      pendingSwipe.current = dx < 0 ? 1 : -1
      navigate(TAB_PATHS[next])
    }

    const onCancel = () => {
      tracking = false
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: false })
    window.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onCancel)
    }
  }, [location.pathname, navigate])

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="情绪日历首页">
          <CapsuleMark />
          <span className="brand-text">
            情绪日历
            <small>EMOTION CAPSULE</small>
          </span>
        </Link>

        <nav className="main-nav" aria-label="主导航">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            月视图
          </NavLink>
          <NavLink to="/insights" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            AI 分析
          </NavLink>
          <NavLink to="/chat" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            聊一聊
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            设置
          </NavLink>
        </nav>

        <div className="user-area">
          <Link to="/settings" className="avatar avatar-link" title="设置" aria-label="打开设置">
            {user?.displayName.slice(0, 1)}
          </Link>
          <span className="user-name">{user?.displayName}</span>
          <button type="button" className="ghost-btn small" onClick={logout}>
            退出
          </button>
        </div>
      </header>

      <main className={'app-main' + (slideDir ? ` slide-${slideDir}` : '')}>{children}</main>

      <footer className="app-footer">
        <span>每一天的感受，都值得被认真收好。</span>
        <span className="footer-dot">·</span>
        <span>理由默认只有自己可见</span>
      </footer>

      {!hideChatFab && (
        <Link to="/chat" className="chat-fab" aria-label="打开聊一聊" title="打开聊一聊">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 4c-4.4 0-8 3-8 6.7 0 1.9.9 3.6 2.4 4.8L5.3 19l4-1.2c.9.2 1.8.3 2.7.3 4.4 0 8-3 8-6.7S16.4 4 12 4Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          <span className="chat-fab-plus" aria-hidden="true">
            +
          </span>
        </Link>
      )}
    </div>
  )
}
