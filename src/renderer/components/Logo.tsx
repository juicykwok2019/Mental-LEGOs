// 品牌标志：M 拆成四块——两根竖笔各自上下分段、两条斜笔，各用一档绿。
// 坐标与 scripts/make-logo.py 里的一致（256 见方），改一处记得改另一处。
// 用内联 SVG 而不是图片文件：任何缩放都清晰，也不经过打包器的资源处理。

const UP = '#a9c39d';
const LOW = '#57814e';
const DIAG_L = '#7ba36d';
const DIAG_R = '#3d603c';

function Pieces() {
  return (
    <>
      {/* 左竖笔：上下两段 */}
      <path d="M46 62h34v68H46z" fill={UP} />
      <path d="M46 130h34v68H46z" fill={LOW} />
      {/* 右竖笔：上下两段，深浅与左边相反 */}
      <path d="M176 62h34v68h-34z" fill={LOW} />
      <path d="M176 130h34v68h-34z" fill={UP} />
      {/* 两条斜笔，收在同一段平底上 */}
      <path d="M80 62h34l31 90h-34z" fill={DIAG_L} />
      <path d="M142 62h34l-31 90h-34z" fill={DIAG_R} />
    </>
  );
}

// 标志本身就是一个 M，所以标题里那个 M 直接由它来当。viewBox 裁到字形外框
// （46,62 起，164×136），底边正是 M 的基线——行内摆放时与文字基线自然对齐。
// 高度按标题的大写字高走，替换后 M 还是原来那么大，不放大也不缩小。
// aria-label 给 "M"，读屏读出来仍然是 "Mental LEGOs"。
export function LogoGlyph() {
  return (
    <svg className="logo-glyph" viewBox="46 62 164 136" role="img" aria-label="M" focusable="false">
      <Pieces />
    </svg>
  );
}

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role="img"
      aria-label="Mental LEGOs"
      focusable="false"
    >
      <Pieces />
    </svg>
  );
}
