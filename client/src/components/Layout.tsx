import { Link, NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../context/AuthContext'

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
          <NavLink to="/access" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            授权管理
          </NavLink>
        </nav>

        <div className="user-area">
          <span className="avatar">{user?.displayName.slice(0, 1)}</span>
          <span className="user-name">{user?.displayName}</span>
          <button type="button" className="ghost-btn small" onClick={logout}>
            退出
          </button>
        </div>
      </header>

      <main className="app-main">{children}</main>

      <footer className="app-footer">
        <span>每一天的感受，都值得被认真收好。</span>
        <span className="footer-dot">·</span>
        <span>理由默认只有自己可见</span>
      </footer>
    </div>
  )
}
