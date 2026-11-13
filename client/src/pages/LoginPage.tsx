import { useState } from 'react'
import type { FormEvent } from 'react'
import { CapsuleMark } from '../components/Layout'
import { errorMessage, useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      if (mode === 'login') await login(username.trim(), password)
      else await register(username.trim(), password, displayName.trim())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-shell">
      <section className="auth-art">
        <div className="auth-brand">
          <CapsuleMark size={40} />
          <span>情绪日历</span>
        </div>

        <div className="auth-copy">
          <h1>
            把每天的感受，
            <br />
            投进扭蛋机。
          </h1>
          <p>诚实地记下每一天的颜色，一起读懂两人的心情。</p>
        </div>

        <div className="auth-machine" aria-hidden="true">
          <div className="auth-machine-glass">
            <span className="mini-ball c1" />
            <span className="mini-ball c2" />
            <span className="mini-ball c3" />
            <span className="mini-ball c4" />
            <span className="mini-ball c5" />
            <span className="mini-ball c6" />
          </div>
          <div className="auth-machine-base">
            <span className="mini-knob" />
          </div>
        </div>

        <ul className="auth-points">
          <li>
            <span className="dot coral" />
            月视图：一眼看到这个月的颜色起伏
          </li>
          <li>
            <span className="dot sage" />
            日视图：拖动色块，撞出一颗扭蛋
          </li>
          <li>
            <span className="dot ink" />
            授权后才互通，理由默认只有自己可见
          </li>
        </ul>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'auth-tab active' : 'auth-tab'}
              onClick={() => {
                setMode('login')
                setError('')
              }}
            >
              登录
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'auth-tab active' : 'auth-tab'}
              onClick={() => {
                setMode('register')
                setError('')
              }}
            >
              注册
            </button>
          </div>

          <form onSubmit={submit} className="auth-form">
            <label>
              <span>用户名</span>
              <input
                value={username}
                autoComplete="username"
                placeholder="字母、数字或下划线"
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>

            {mode === 'register' && (
              <label>
                <span>昵称</span>
                <input
                  value={displayName}
                  maxLength={20}
                  placeholder="对方会看到的名字"
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                />
              </label>
            )}

            <label>
              <span>密码</span>
              <input
                type="password"
                value={password}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="至少 6 位"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            {error && <div className="form-error">{error}</div>}

            <button type="submit" className="primary-btn wide" disabled={submitting}>
              {submitting ? '请稍等…' : mode === 'login' ? '进入情绪日历' : '创建账号'}
            </button>
          </form>

          <p className="auth-foot">
            {mode === 'login' ? '还没有账号？' : '已经有账号了？'}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError('')
              }}
            >
              {mode === 'login' ? '注册一个' : '去登录'}
            </button>
          </p>
        </div>
      </section>
    </div>
  )
}
