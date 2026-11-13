import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import { attachUser } from './auth.js'
import authRoutes from './routes/auth.js'
import recordRoutes from './routes/records.js'
import accessRoutes from './routes/access.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '0.0.0.0'

app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())
app.use(attachUser)

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  next()
})

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api/auth', authRoutes)
app.use('/api/records', recordRoutes)
app.use('/api/access', accessRoutes)

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }))

const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '7d' }))
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
} else {
  app.get('*', (_req, res) => {
    res.status(503).send('前端尚未构建。开发环境请运行 npm run dev，生产环境请先 npm run build。')
  })
}

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: '服务器出了点问题，稍后再试' })
})

app.listen(port, host, () => {
  console.log(`emotion-calendar server listening on http://${host}:${port}`)
})
