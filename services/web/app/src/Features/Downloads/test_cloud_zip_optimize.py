#!/usr/bin/env python3
"""Unit tests for cloud_zip_optimize.py."""

import random
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from cloud_zip_optimize import optimize_directory


class TestCloudZipOptimize(unittest.TestCase):
    def test_shrinks_oversized_rgba_and_jpeg_without_breaking_small_or_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            figs = work / 'figures'
            figs.mkdir(parents=True, exist_ok=True)

            # 1. Oversized 3600x2400 RGBA textured chart (>400 KB)
            rgba = Image.new('RGBA', (3600, 2400), (255, 255, 255, 255))
            draw = ImageDraw.Draw(rgba)
            rng = random.Random(42)
            # Draw soft gradient band + dense anti-aliased scatter/lines typical of Grad-CAM / training plots
            for x in range(0, 3600, 4):
                shade = int(255 * (x / 3600.0))
                draw.line([(x, 0), (x, 1200)], fill=(shade, 255 - shade, (shade * 3) % 255, 255), width=4)
            for _ in range(3000):
                x0, y0 = rng.randint(0, 3450), rng.randint(0, 2250)
                x1, y1 = x0 + rng.randint(15, 160), y0 + rng.randint(15, 160)
                color = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255), 255)
                draw.line([x0, y0, x1, y1], fill=color, width=3)
            png_path = figs / 'big_chart.png'
            rgba.save(png_path, format='PNG')
            orig_png_size = png_path.stat().st_size
            self.assertGreater(orig_png_size, 300 * 1024)

            # 2. Oversized 3400x2400 JPEG photo
            rgb = Image.new('RGB', (3400, 2400), (240, 245, 250))
            draw_rgb = ImageDraw.Draw(rgb)
            for _ in range(500):
                x0, y0 = rng.randint(0, 3200), rng.randint(0, 2200)
                draw_rgb.ellipse(
                    [x0, y0, x0 + 180, y0 + 180],
                    fill=(rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)),
                )
            jpg_path = figs / 'photo.jpg'
            rgb.save(jpg_path, format='JPEG', quality=98)
            orig_jpg_size = jpg_path.stat().st_size

            # 3. Tiny icon (<12 KB) should remain intact without inflation
            tiny = Image.new('RGB', (32, 32), (10, 20, 30))
            tiny_path = figs / 'tiny.png'
            tiny.save(tiny_path, format='PNG')
            orig_tiny_bytes = tiny_path.read_bytes()

            # 4. Corrupt image file should not crash optimizer
            corrupt_path = figs / 'corrupt.png'
            corrupt_path.write_bytes(b'not-a-valid-png-header' * 700)

            # 5. Tex source untouched
            tex_path = work / 'main.tex'
            tex_text = '\\documentclass{article}\n\\includegraphics{figures/big_chart}\n'
            tex_path.write_text(tex_text, encoding='utf-8')

            res = optimize_directory(work, target_bytes=900 * 1024, compress_images=True)
            self.assertTrue(res['ok'])
            self.assertLess(png_path.stat().st_size, orig_png_size)
            self.assertLess(jpg_path.stat().st_size, orig_jpg_size)
            self.assertEqual(tiny_path.read_bytes(), orig_tiny_bytes)
            self.assertEqual(tex_path.read_text(encoding='utf-8'), tex_text)
            self.assertLessEqual(res['estimatedZipBytes'], 900 * 1024)
            self.assertIsNone(res['warning'])
            with Image.open(png_path) as check_png:
                self.assertLessEqual(max(check_png.size), 2200)


if __name__ == '__main__':
    unittest.main()
