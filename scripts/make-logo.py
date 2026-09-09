"""一次性资产生成器：品牌标志与应用图标。

不是 `npm run make` 的一环。需要重出时手动跑：

    python scripts/make-logo.py

产出：
  LOGO/mental-legos-logo.png   1024 品牌主图
  assets/icon.ico              应用图标（16/24/32/48/64/128/256）

形：M 拆成四块——两根竖笔各自上下分段、两条斜笔，各用一档绿。
两条斜笔在 V 底交汇，那里不额外压一块色，交界就是它们自己的形状。
配色取自 src/renderer/styles.css。产品界面里的那枚标志是
src/renderer/components/Logo.tsx 里的内联 SVG，和这里同一套坐标。

ico 里的每个尺寸都按该尺寸**重新绘制**再超采样降下来，不是从大图缩——
16px 时竖笔只有两个多像素宽，从 1024 缩下来边会糊。
"""

import struct
from io import BytesIO

from PIL import Image, ImageDraw

# 绿阶：0 最浅 → 5 最深
G = [
    (219, 231, 212, 255), (169, 195, 157, 255), (123, 163, 109, 255),
    (87, 129, 78, 255), (61, 96, 60, 255), (47, 80, 52, 255),
]
PAPER = (244, 240, 231, 255)   # :root background

# 以下坐标都按 256 见方的画布写，渲染时按目标尺寸等比缩放。
LEFT, RIGHT = 46, 210
TOP, BOT = 62, 198
STEM = 34
VY = 152        # V 底
SPLIT = 130     # 竖笔上下分段
CX = (LEFT + RIGHT) / 2
RADIUS = 58     # 圆角方底

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def render(size: int, ss: int = 4, ground=PAPER) -> Image.Image:
    """按目标尺寸原生绘制一遍，再超采样降下来。"""
    w = size * ss
    k = size / 256.0 * ss

    def pts(seq):
        return [(int(round(x * k)), int(round(y * k))) for x, y in seq]

    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if ground:
        r = int(round(RADIUS * k))
        d.rectangle((r, 0, w - r, w), fill=ground)
        d.rectangle((0, r, w, w - r), fill=ground)
        for cx, cy in ((0, 0), (w - 2 * r, 0), (0, w - 2 * r), (w - 2 * r, w - 2 * r)):
            d.ellipse((cx, cy, cx + 2 * r, cy + 2 * r), fill=ground)

    up, low, diag_l, diag_r = G[1], G[3], G[2], G[4]

    # 两根竖笔，各自上下两段——像两块积木摞起来
    d.polygon(pts([(LEFT, TOP), (LEFT + STEM, TOP), (LEFT + STEM, SPLIT), (LEFT, SPLIT)]), fill=up)
    d.polygon(pts([(LEFT, SPLIT), (LEFT + STEM, SPLIT), (LEFT + STEM, BOT), (LEFT, BOT)]), fill=low)
    d.polygon(pts([(RIGHT - STEM, TOP), (RIGHT, TOP), (RIGHT, SPLIT), (RIGHT - STEM, SPLIT)]), fill=low)
    d.polygon(pts([(RIGHT - STEM, SPLIT), (RIGHT, SPLIT), (RIGHT, BOT), (RIGHT - STEM, BOT)]), fill=up)

    # 两条斜笔，收在同一段平底上
    d.polygon(pts([(LEFT + STEM, TOP), (LEFT + STEM * 2, TOP),
                   (CX + STEM / 2, VY), (CX - STEM / 2, VY)]), fill=diag_l)
    d.polygon(pts([(RIGHT - STEM * 2, TOP), (RIGHT - STEM, TOP),
                   (CX + STEM / 2, VY), (CX - STEM / 2, VY)]), fill=diag_r)

    return img.resize((size, size), Image.LANCZOS)


def write_ico(path: str, images) -> None:
    """多图 ICO：每个尺寸一张 PNG，Vista 以后的 Windows 都认。"""
    blobs = []
    for image in images:
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        blobs.append(buffer.getvalue())

    offset = 6 + 16 * len(blobs)
    directory = b""
    for image, blob in zip(images, blobs):
        # 256 在目录项里写作 0
        side = 0 if image.width >= 256 else image.width
        directory += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)

    with open(path, "wb") as handle:
        handle.write(struct.pack("<HHH", 0, 1, len(blobs)))
        handle.write(directory)
        for blob in blobs:
            handle.write(blob)


if __name__ == "__main__":
    render(1024, ss=3).save("LOGO/mental-legos-logo.png")
    print("wrote LOGO/mental-legos-logo.png  1024x1024")

    write_ico("assets/icon.ico", [render(size) for size in ICO_SIZES])
    print("wrote assets/icon.ico  " + "/".join(str(s) for s in ICO_SIZES))
