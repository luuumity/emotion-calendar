import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * 还原多页应用的滚动语义：
 * 主动进入新页面（PUSH / REPLACE）时回到顶部；
 * 浏览器后退、前进（POP）时交给浏览器恢复原位置。
 */
export function ScrollManager() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()

  useEffect(() => {
    if (navigationType === 'POP') return
    window.scrollTo(0, 0)
  }, [pathname, navigationType])

  return null
}
