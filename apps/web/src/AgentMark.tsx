/**
 * Agent 入口图标:圆角方框头部 + 两条竖线眼睛(刻意不带天线,避免通用
 * bot 图标的观感)。独立成文件便于后续按需调整图形。
 *
 * 头部保持正方形(16×16,居中),保证在各种容器里不因拉伸失真;眼睛
 * 左右对称。线性描边画法,`stroke="currentColor"` 跟随所在容器文字色
 * —— 与全应用的 lucide 图标语言一致,深浅主题天然自适应,无需图片
 * 资源与滤镜。
 */
export function AgentMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <line x1="9.25" y1="9" x2="9.25" y2="13" />
      <line x1="14.75" y1="9" x2="14.75" y2="13" />
    </svg>
  );
}