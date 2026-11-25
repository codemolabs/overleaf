#!/usr/bin/env python3
"""
Adaptive media compressor for Overleaf Cloud ZIP exports (< 30 MB).
Shrinks oversized diagrams/images to print-sharp bounds while preserving
filenames, extensions, and readable text, stepping down further only when
needed to stay under the target byte budget.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

from PIL import Image, ImageOps

MEDIA_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.pdf'}

TIERS = [
    {'max_dim': 2200, 'jpeg_quality': 88, 'quantize_colors': None},
    {'max_dim': 1600, 'jpeg_quality': 80, 'quantize_colors': None},
    {'max_dim': 1250, 'jpeg_quality': 72, 'quantize_colors': 256},
    {'max_dim': 950, 'jpeg_quality': 62, 'quantize_colors': 128},
    {'max_dim': 760, 'jpeg_quality': 52, 'quantize_colors': 64},
]


def safe_file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def estimate_compressed_non_media_bytes(work_dir: Path) -> int:
    """Estimate actual deflate-compressed size of source/non-media files."""
    total = 0
    for root, _, files in os.walk(work_dir):
        for name in files:
            p = Path(root) / name
            if p.suffix.lower() in MEDIA_EXTS:
                continue
            try:
                data = p.read_bytes()
                total += len(zlib.compress(data, level=9)) + 64
            except OSError:
                continue
    return total


def current_media_bytes(media_paths: list[Path]) -> int:
    return sum(safe_file_size(p) for p in media_paths)


def run_optipng(target: Path) -> None:
    optipng = shutil.which('optipng')
    if not optipng:
        return
    try:
        subprocess.run(
            [optipng, '-o2', '-strip', 'all', '-quiet', str(target)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except Exception:
        pass


def compress_pdf_lossless(pdf_path: Path) -> tuple[bool, str | None]:
    qpdf = shutil.which('qpdf')
    if not qpdf:
        return False, None
    orig_size = safe_file_size(pdf_path)
    with tempfile.NamedTemporaryFile(
        dir=pdf_path.parent, suffix='.tmp.pdf', delete=False
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        proc = subprocess.run(
            [
                qpdf,
                '--object-streams=generate',
                '--compress-streams=y',
                '--recompress-flate',
                str(pdf_path),
                str(tmp_path),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        if proc.returncode in (0, 3) and tmp_path.exists():
            new_size = safe_file_size(tmp_path)
            if 0 < new_size < orig_size:
                os.replace(tmp_path, pdf_path)
                return True, 'qpdf_recompress'
    except Exception:
        pass
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    return False, None


def optimize_raster_image(
    img_path: Path,
    max_dim: int,
    jpeg_quality: int,
    quantize_colors: int | None,
    run_optipng_flag: bool = False,
) -> tuple[bool, str | None]:
    ext = img_path.suffix.lower()
    orig_size = safe_file_size(img_path)
    if orig_size < 12 * 1024:
        return False, None

    try:
        with Image.open(img_path) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode == 'RGBA':
                alpha = im.getchannel('A')
                if alpha.getextrema() == (255, 255):
                    im = im.convert('RGB')
            width, height = im.size
            if width <= 0 or height <= 0:
                return False, None

            resized = False
            if max(width, height) > max_dim:
                scale = max_dim / float(max(width, height))
                new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
                im = im.resize(new_size, Image.Resampling.LANCZOS)
                resized = True

            with tempfile.NamedTemporaryFile(
                dir=img_path.parent, suffix=f'.tmp{ext}', delete=False
            ) as tmp:
                tmp_path = Path(tmp.name)

            try:
                method_parts = []
                if resized:
                    method_parts.append(f'resize_{max_dim}')

                if ext in ('.jpg', '.jpeg'):
                    if im.mode in ('RGBA', 'LA', 'PA'):
                        bg = Image.new('RGB', im.size, (255, 255, 255))
                        alpha = im.split()[-1]
                        bg.paste(im.convert('RGB'), mask=alpha)
                        im_save = bg
                    elif im.mode != 'RGB':
                        im_save = im.convert('RGB')
                    else:
                        im_save = im
                    im_save.save(
                        tmp_path,
                        format='JPEG',
                        quality=jpeg_quality,
                        optimize=True,
                        progressive=True,
                    )
                    method_parts.append(f'jpeg_q{jpeg_quality}')

                elif ext == '.webp':
                    im_save = im if im.mode in ('RGB', 'RGBA') else im.convert('RGBA')
                    im_save.save(
                        tmp_path,
                        format='WEBP',
                        quality=jpeg_quality,
                        method=4,
                    )
                    method_parts.append(f'webp_q{jpeg_quality}')

                elif ext in ('.png', '.bmp', '.tif', '.tiff'):
                    fmt = {
                        '.png': 'PNG',
                        '.bmp': 'BMP',
                        '.tif': 'TIFF',
                        '.tiff': 'TIFF',
                    }[ext]
                    if fmt == 'PNG' and quantize_colors is not None:
                        if im.mode in ('RGBA', 'LA', 'P'):
                            rgba = im.convert('RGBA')
                            im_q = rgba.quantize(
                                colors=quantize_colors,
                                method=Image.Quantize.FASTOCTREE,
                            )
                        else:
                            rgb = im.convert('RGB')
                            im_q = rgb.quantize(
                                colors=quantize_colors,
                                method=Image.Quantize.FASTOCTREE,
                            )
                        im_q.save(tmp_path, format='PNG', optimize=True, compress_level=9)
                        method_parts.append(f'png_q{quantize_colors}')
                    elif fmt == 'PNG':
                        im.save(tmp_path, format='PNG', optimize=True, compress_level=9)
                        if run_optipng_flag:
                            run_optipng(tmp_path)
                        method_parts.append('png_opt')
                    else:
                        im.save(tmp_path, format=fmt)
                        method_parts.append('reencode')

                new_size_bytes = safe_file_size(tmp_path)
                if 0 < new_size_bytes < orig_size:
                    os.replace(tmp_path, img_path)
                    return True, '+'.join(method_parts)
                return False, None
            finally:
                if tmp_path.exists():
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass
    except Exception:
        return False, None


def optimize_directory(work_dir: Path, target_bytes: int, compress_images: bool = True) -> dict:
    media_paths: list[Path] = []
    original_media_sizes: dict[str, int] = {}
    for root, _, files in os.walk(work_dir):
        for name in sorted(files):
            p = Path(root) / name
            if p.suffix.lower() in MEDIA_EXTS:
                rel = p.relative_to(work_dir).as_posix()
                media_paths.append(p)
                original_media_sizes[rel] = safe_file_size(p)

    non_media_est = estimate_compressed_non_media_bytes(work_dir)
    media_total = current_media_bytes(media_paths)
    zip_est = non_media_est + media_total
    methods_used: dict[str, str] = {}

    if compress_images and media_paths:
        # Always apply gentle Tier 0 if total > 4 MB or any image exceeds 2200px / 500 KB,
        # then escalate only if zip estimate still exceeds target_bytes.
        for tier_idx, tier in enumerate(TIERS):
            if tier_idx > 0 and zip_est <= target_bytes:
                break
            candidates = sorted(
                media_paths, key=lambda p: safe_file_size(p), reverse=True
            )
            for p in candidates:
                if tier_idx > 0 and zip_est <= target_bytes:
                    break
                ext = p.suffix.lower()
                rel = p.relative_to(work_dir).as_posix()
                before = safe_file_size(p)
                changed = False
                method = None
                if ext == '.pdf':
                    changed, method = compress_pdf_lossless(p)
                else:
                    changed, method = optimize_raster_image(
                        p,
                        max_dim=tier['max_dim'],
                        jpeg_quality=tier['jpeg_quality'],
                        quantize_colors=tier['quantize_colors'],
                        run_optipng_flag=(tier_idx >= 1),
                    )
                if changed:
                    after = safe_file_size(p)
                    media_total -= before - after
                    zip_est = non_media_est + media_total
                    if method:
                        methods_used[rel] = method

    optimized_files = []
    for p in media_paths:
        rel = p.relative_to(work_dir).as_posix()
        orig_b = original_media_sizes.get(rel, 0)
        new_b = safe_file_size(p)
        if new_b < orig_b:
            optimized_files.append(
                {
                    'relPath': rel,
                    'originalBytes': orig_b,
                    'newBytes': new_b,
                    'savedBytes': orig_b - new_b,
                    'method': methods_used.get(rel, 'optimized'),
                }
            )

    optimized_files.sort(key=lambda item: item['savedBytes'], reverse=True)
    raw_total = sum(
        safe_file_size(Path(root) / name)
        for root, _, files in os.walk(work_dir)
        for name in files
    )

    warning = None
    if zip_est > target_bytes:
        warning = (
            f'Estimated archive size ({zip_est / (1024 * 1024):.1f} MB) still exceeds '
            f'target ({target_bytes / (1024 * 1024):.1f} MB). Some media assets cannot be '
            'reduced further without dropping clarity.'
        )

    return {
        'ok': True,
        'estimatedZipBytes': zip_est,
        'finalRawBytes': raw_total,
        'optimizedFiles': optimized_files,
        'warning': warning,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Optimize Cloud ZIP media assets')
    parser.add_argument('--dir', required=True, help='Working directory with staged files')
    parser.add_argument('--target-bytes', type=int, required=True, help='Target archive size in bytes')
    parser.add_argument(
        '--compress-images',
        choices=['true', 'false'],
        default='true',
        help='Whether to compress images/diagrams',
    )
    args = parser.parse_args()

    work_dir = Path(args.dir).resolve()
    if not work_dir.is_dir():
        print(json.dumps({'ok': False, 'error': f'Not a directory: {work_dir}'}))
        return 1

    result = optimize_directory(
        work_dir=work_dir,
        target_bytes=max(1024 * 1024, args.target_bytes),
        compress_images=args.compress_images == 'true',
    )
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
