import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  content: string
  className?: string
}

/**
 * 共享 Markdown 渲染。
 * - 只渲染 Markdown 文本，不启用 raw HTML，默认转义
 * - 链接统一新窗口打开，避免把应用页面顶掉
 * - 对话用 markdown-chat，报告用 markdown-report 控制排版密度
 */
export function Markdown({ content, className = '' }: Props) {
  return (
    <div className={`markdown ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, title, children }) {
            return (
              <a href={href} title={title} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
