import { api } from './api'

/** 当前环境能否订阅 Web Push */
export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isIOS() {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** 是否以「添加到主屏幕」的独立窗口方式打开 */
export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function permissionState(): NotificationPermission | 'unsupported' {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function registerServiceWorker() {
  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  return registration
}

export async function getSubscription() {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration()
  return registration ? registration.pushManager.getSubscription() : null
}

/**
 * 确保这台设备已订阅并同步到服务器。
 * 已有订阅不会重复申请，权限已授权时不会再弹窗。
 */
export async function ensureSubscribed() {
  const registration = await registerServiceWorker()
  let subscription = await registration.pushManager.getSubscription()

  if (!subscription) {
    const { publicKey } = await api.pushKey()
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    })
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  await api.pushSubscribe(subscription.toJSON(), timezone)
  return subscription
}

export async function removeSubscription() {
  const subscription = await getSubscription()
  if (!subscription) return
  await api.pushUnsubscribe(subscription.endpoint).catch(() => undefined)
  await subscription.unsubscribe().catch(() => undefined)
}

/** 登录后静默续订：权限已授权且以主屏幕方式打开时，用户无需任何操作 */
export function syncInBackground() {
  if (!pushSupported() || !isStandalone() || Notification.permission !== 'granted') return
  ensureSubscribed().catch(() => undefined)
}
