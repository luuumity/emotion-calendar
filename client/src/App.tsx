import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { Layout } from './components/Layout'
import { ScrollManager } from './components/ScrollManager'
import { LoginPage } from './pages/LoginPage'
import { MonthPage } from './pages/MonthPage'
import { DayPage } from './pages/DayPage'
import { SettingsPage } from './pages/SettingsPage'
import { InsightsPage } from './pages/InsightsPage'
import { ChatPage } from './pages/ChatPage'

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

  if (loading) return <Splash />
  if (!user) return <LoginPage />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<MonthPage />} />
        <Route path="/day/:date" element={<DayPage />} />
        <Route path="/access" element={<Navigate to="/settings?tab=access" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
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
