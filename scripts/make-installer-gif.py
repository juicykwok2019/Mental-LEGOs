"""一次性资产生成器：安装器进度窗口的图（assets/installer-loading.gif）。

不是 `npm run make` 的一环，构建只读已生成的 gif。需要改图时手动跑：

    python scripts/make-installer-gif.py

Squirrel 的安装窗口没有文字区域，这张图就是它唯一的画面——所以安装位置
只能写进图里。配色取自 src/renderer/styles.css，让安装器和应用是一副长相。
"""

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 480, 300
PAPER = "#f4f0e7"      # :root background
INK = "#22251f"        # :root color
GREEN = "#57814e"      # 主色
DEEP = "#2f5034"
MUTED = "#596654"
FAINT = "#8b9186"

YAHEI = "C:/Windows/Fonts/msyh.ttc"
YAHEI_BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size, index=0)
    except OSError:
        return ImageFont.truetype("C:/Windows/Fonts/simhei.ttf", size)


def main() -> None:
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(image)

    # 左侧一道竖色带，呼应应用里的积木隐喻：三块，颜色由深到浅。
    for top, height, color in (
        (52, 58, DEEP), (118, 58, GREEN), (184, 58, "#9ab48f"),
    ):
        # PIL 7 没有 rounded_rectangle，直角块在这个尺寸下也足够干净。
        draw.rectangle((44, top, 44 + 18, top + height), fill=color)

    left = 88
    draw.text((left, 56), "Mental LEGOs", font=font(YAHEI_BOLD, 34), fill=INK)
    draw.text((left, 100), "心智乐高", font=font(YAHEI, 20), fill=MUTED)
    draw.line((left, 140, WIDTH - 44, 140), fill="#ddd8cb", width=1)

    draw.text((left, 158), "正在安装…", font=font(YAHEI, 17), fill=DEEP)
    draw.text((left, 190), "安装位置", font=font(YAHEI, 13), fill=FAINT)
    draw.text((left, 208), "%LOCALAPPDATA%\\mental_legos",
              font=font("C:/Windows/Fonts/consola.ttf", 14), fill=MUTED)
    draw.text((left, 232), "按用户安装，不需要管理员权限",
              font=font(YAHEI, 12), fill=FAINT)

    image.save("assets/installer-loading.gif", format="GIF")
    print(f"wrote assets/installer-loading.gif  {WIDTH}x{HEIGHT}")


if __name__ == "__main__":
    main()
