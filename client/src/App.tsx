import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { Layout } from './components/Layout'
import { ScrollManager } from './components/ScrollManager'
import { LoginPage } from './pages/LoginPage'
import { MonthPage } from './pages/MonthPage'
import { DayPage } from './pages/DayPage'
import { SettingsPage } from './pages/SettingsPage'
import { InsightsPage } from './pages/InsightsPage'
import { ChatPage } from './pages/ChatPage'
import { UsagePage } from './pages/UsagePage'
import { SharePage } from './pages/SharePage'

function Splash() {
  return (
    <div className="splash">
      <div className="splash-capsule">
        <span />
      </div>
      <p>正在打开情绪日历…</p>
    </div>
  )
}

function Shell() {
  const { user, loading } = useAuth()
  const location = useLocation()

  // 公开分享页与登录态无关，且不套用应用布局。
  // 必须用 Route 承接 /s/:token，SharePage 里的 useParams 才拿得到 token。
  if (location.pathname.startsWith('/s/')) {
    return (
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
        <Route path="*" element={<SharePage />} />
      </Routes>
    )
  }

  if (loading) return <Splash />
  if (!user) return <LoginPage />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<MonthPage />} />
        <Route path="/day/:date" element={<DayPage />} />
        <Route path="/access" element={<Navigate to="/settings?tab=access" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollManager />
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </BrowserRouter>
  )
}
