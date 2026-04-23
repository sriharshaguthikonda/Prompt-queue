from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


def draw_background(size: int) -> Image.Image:
    gradient = Image.linear_gradient("L").resize((size, size))
    bg = ImageOps.colorize(gradient, black="#0E2A49", white="#1E7AD7").convert("RGBA")

    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(gloss)
    gdraw.ellipse(
        (
            int(size * -0.10),
            int(size * -0.55),
            int(size * 1.10),
            int(size * 0.58),
        ),
        fill=(255, 255, 255, 48),
    )
    bg = Image.alpha_composite(bg, gloss)

    border = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(border)
    radius = max(3, int(size * 0.24))
    bdraw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        outline=(7, 24, 43, 140),
        width=max(1, int(size * 0.05)),
    )
    bg = Image.alpha_composite(bg, border)

    rounded_mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(rounded_mask)
    mdraw.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    bg.putalpha(rounded_mask)
    return bg


def draw_symbol(size: int) -> Image.Image:
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(icon)

    if size <= 24:
        bubble = (
            int(size * 0.20),
            int(size * 0.24),
            int(size * 0.80),
            int(size * 0.71),
        )
        radius = max(2, int(size * 0.14))
        draw.rounded_rectangle(bubble, radius=radius, fill=(255, 255, 255, 255))
        draw.polygon(
            [
                (int(size * 0.31), int(size * 0.71)),
                (int(size * 0.44), int(size * 0.71)),
                (int(size * 0.33), int(size * 0.86)),
            ],
            fill=(255, 255, 255, 255),
        )

        line_color = (22, 92, 166, 255)
        line_h = max(1, int(size * 0.08))
        pad_x = int(size * 0.10)
        draw.rounded_rectangle(
            (
                bubble[0] + pad_x,
                int(size * 0.37),
                bubble[2] - pad_x,
                int(size * 0.37) + line_h,
            ),
            radius=line_h,
            fill=line_color,
        )
        draw.rounded_rectangle(
            (
                bubble[0] + pad_x,
                int(size * 0.50),
                bubble[2] - int(size * 0.22),
                int(size * 0.50) + line_h,
            ),
            radius=line_h,
            fill=line_color,
        )
        return icon

    back = (
        int(size * 0.17),
        int(size * 0.18),
        int(size * 0.72),
        int(size * 0.58),
    )
    back_radius = int(size * 0.12)
    draw.rounded_rectangle(back, radius=back_radius, fill=(59, 197, 255, 235))
    draw.polygon(
        [
            (int(size * 0.27), int(size * 0.58)),
            (int(size * 0.38), int(size * 0.58)),
            (int(size * 0.30), int(size * 0.71)),
        ],
        fill=(59, 197, 255, 235),
    )

    front = (
        int(size * 0.26),
        int(size * 0.27),
        int(size * 0.83),
        int(size * 0.72),
    )
    front_radius = int(size * 0.13)
    draw.rounded_rectangle(front, radius=front_radius, fill=(255, 255, 255, 255))
    draw.polygon(
        [
            (int(size * 0.37), int(size * 0.72)),
            (int(size * 0.49), int(size * 0.72)),
            (int(size * 0.40), int(size * 0.85)),
        ],
        fill=(255, 255, 255, 255),
    )

    line_color = (28, 102, 184, 255)
    line_height = max(2, int(size * 0.055))
    line_left = int(size * 0.34)
    line_right = int(size * 0.68)
    start_y = int(size * 0.39)
    spacing = int(size * 0.12)
    for idx in range(3):
        y = start_y + idx * spacing
        draw.rounded_rectangle(
            (line_left, y, line_right, y + line_height),
            radius=line_height,
            fill=line_color,
        )

    queue_left = int(size * 0.72)
    queue_right = int(size * 0.78)
    queue_height = int(size * 0.07)
    queue_gap = int(size * 0.10)
    queue_top = int(size * 0.40)
    queue_colors = [(41, 175, 255, 255), (20, 149, 246, 255), (12, 122, 224, 255)]
    for idx, color in enumerate(queue_colors):
        y = queue_top + idx * queue_gap
        draw.rounded_rectangle(
            (queue_left, y, queue_right, y + queue_height),
            radius=max(1, int(queue_height / 2)),
            fill=color,
        )

    return icon


def compose_icon(size: int) -> Image.Image:
    bg = draw_background(size)
    symbol = draw_symbol(size)
    return Image.alpha_composite(bg, symbol)


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    images_dir = repo_root / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    extension_sizes = [16, 24, 32, 48, 128]
    for size in extension_sizes:
        icon = compose_icon(size)
        icon.save(images_dir / f"icon-{size}.png", format="PNG", optimize=True)

    # Notification icon source.
    compose_icon(512).save(images_dir / "icon.png", format="PNG", optimize=True)

    print("Generated:", ", ".join([f"icon-{s}.png" for s in extension_sizes] + ["icon.png"]))


if __name__ == "__main__":
    main()
