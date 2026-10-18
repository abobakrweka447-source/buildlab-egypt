from __future__ import annotations

import json
import mimetypes
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageOps
from rq import get_current_job

MEDIA_ROOT = Path(os.getenv("MEDIA_ROOT", "/data/jobs")).resolve()
R2_ENDPOINT_URL = os.getenv("R2_ENDPOINT_URL", "").strip()
R2_BUCKET = os.getenv("R2_BUCKET", "").strip()
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "").strip()
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "").strip()
R2_REGION = os.getenv("R2_REGION", "auto").strip() or "auto"
R2_PRESIGN_SECONDS = min(max(int(os.getenv("R2_PRESIGN_SECONDS", "900")), 60), 86400)


def r2_enabled() -> bool:
    return all((R2_ENDPOINT_URL, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY))


def _r2_client():
    if not r2_enabled():
        raise RuntimeError("R2 storage is not fully configured.")
    import boto3
    return boto3.client(
        "s3", endpoint_url=R2_ENDPOINT_URL, region_name=R2_REGION,
        aws_access_key_id=R2_ACCESS_KEY_ID, aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    )


def _upload_result_to_r2(path: Path, job_id: str, output_name: str) -> str:
    client = _r2_client()
    key = f"results/{job_id}/{Path(output_name).name}"
    guessed, _ = mimetypes.guess_type(output_name)
    extra = {"ContentDisposition": f'attachment; filename="{Path(output_name).name}"'}
    if guessed:
        extra["ContentType"] = guessed
    client.upload_file(str(path), R2_BUCKET, key, ExtraArgs=extra)
    return key


def r2_presigned_url(key: str) -> str:
    if not r2_enabled() or not key.startswith("results/") or ".." in Path(key).parts:
        raise RuntimeError("Invalid R2 result key or storage is not configured.")
    return _r2_client().generate_presigned_url(
        "get_object", Params={"Bucket": R2_BUCKET, "Key": key}, ExpiresIn=R2_PRESIGN_SECONDS,
    )
MAX_PROCESS_SECONDS = int(os.getenv("MAX_PROCESS_SECONDS", "7200"))

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpeg", ".mpg"}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".opus"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
ALL_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS | IMAGE_EXTENSIONS


def _progress(value: int, message: str) -> None:
    job = get_current_job()
    if job is not None:
        job.meta["progress"] = max(0, min(100, int(value)))
        job.meta["message"] = message
        job.save_meta()


def _run(command: list[str]) -> None:
    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=MAX_PROCESS_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "FFmpeg failed").strip()
        # Avoid exposing full server paths or huge command output to the client.
        detail = detail[-1600:]
        raise RuntimeError(f"تعذّرت معالجة الملف. تفاصيل المحرك: {detail}")


def _probe(input_path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(input_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("الملف غير صالح أو أن صيغته غير مدعومة.")
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("تعذّر قراءة معلومات الملف.") from exc
    if not data.get("streams"):
        raise RuntimeError("لم يتم العثور على مسار صوت أو فيديو داخل الملف.")
    return data


def _first_stream(probe: dict[str, Any], kind: str) -> bool:
    return any(stream.get("codec_type") == kind for stream in probe.get("streams", []))


def _ffmpeg_scale(max_dimension: int) -> str:
    # Preserve orientation/aspect ratio and keep dimensions encoder-friendly.
    return (
        f"scale='if(gte(iw,ih),min(iw,{max_dimension}),-2)':"
        f"'if(gte(iw,ih),-2,min(ih,{max_dimension}))':force_divisible_by=2"
    )


def process_media_job(job_id: str, input_path_str: str, settings: dict[str, Any]) -> dict[str, Any]:
    """RQ worker entry point. Returns a small JSON-serializable result."""
    input_path = Path(input_path_str).resolve()
    job_dir = input_path.parent.resolve()
    if not input_path.exists() or MEDIA_ROOT not in input_path.parents:
        raise RuntimeError("ملف المهمة غير موجود أو مساره غير مسموح.")
    if job_dir != MEDIA_ROOT / job_id:
        raise RuntimeError("مسار المهمة غير مطابق لمعرّفها.")
    op = str(settings.get("operation", "compress"))
    if op not in {"compress", "convert", "audio", "frame", "trim", "image", "enhance"}:
        raise RuntimeError("نوع العملية غير مدعوم.")

    ext = input_path.suffix.lower()
    if ext not in ALL_EXTENSIONS:
        raise RuntimeError("صيغة الملف غير مدعومة.")

    _progress(8, "فحص الملف")
    probe: dict[str, Any] = {}
    is_image = ext in IMAGE_EXTENSIONS
    if op in {"image", "enhance"} and is_image:
        pass
    else:
        probe = _probe(input_path)

    video_present = _first_stream(probe, "video") if probe else False
    audio_present = _first_stream(probe, "audio") if probe else False
    base_name = str(settings.get("original_name", "media"))
    safe_stem = Path(base_name).stem[:60] or "media"
    result: dict[str, Any] = {"enhancement_mode": None}

    _progress(18, "تجهيز إعدادات المعالجة")

    if op == "image" or (op == "enhance" and is_image):
        if not is_image:
            raise RuntimeError("اختر صورة لعملية تحويل الصور أو تحسينها.")
        output_format = str(settings.get("output_format", "webp")).lower()
        if op == "enhance":
            output_format = "png" if ext in {".png", ".bmp", ".tif", ".tiff"} else "webp"
        if output_format not in {"jpg", "jpeg", "png", "webp"}:
            raise RuntimeError("صيغة الصورة المطلوبة غير مدعومة.")
        output_path = job_dir / f"{safe_stem}_luma.{('jpg' if output_format == 'jpeg' else output_format)}"
        with Image.open(input_path) as original:
            image = ImageOps.exif_transpose(original)
            if image.width * image.height > 100_000_000:
                raise RuntimeError("أبعاد الصورة أكبر من الحد المسموح به.")
            if op == "image":
                max_width = int(settings.get("max_width", 0) or 0)
                if max_width not in {0, 800, 1280, 1920, 2560}:
                    raise RuntimeError("عرض الصورة المطلوب غير مدعوم.")
                if max_width and image.width > max_width:
                    new_height = max(1, round(image.height * max_width / image.width))
                    image = image.resize((max_width, new_height), Image.Resampling.LANCZOS)
            else:
                factor = float(settings.get("scale", 2))
                if factor not in {1.5, 2.0}:
                    raise RuntimeError("معامل التكبير غير مدعوم.")
                out_size = (round(image.width * factor), round(image.height * factor))
                if out_size[0] * out_size[1] > 100_000_000:
                    raise RuntimeError("الصورة بعد التكبير ستتجاوز الحد الآمن للأبعاد.")
                image = image.resize(out_size, Image.Resampling.LANCZOS)
                image = image.filter(ImageFilter.UnsharpMask(radius=1.5, percent=125, threshold=3))
                result["enhancement_mode"] = "traditional-lanczos-unsharp"
            if output_format in {"jpg", "jpeg"}:
                if image.mode not in {"RGB", "L"}:
                    background = Image.new("RGB", image.size, "white")
                    if "A" in image.getbands():
                        background.paste(image, mask=image.getchannel("A"))
                    else:
                        background.paste(image.convert("RGB"))
                    image = background
                image.save(output_path, format="JPEG", quality=91, optimize=True)
            elif output_format == "webp":
                if image.mode == "P":
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                image.save(output_path, format="WEBP", quality=88, method=5)
            else:
                image.save(output_path, format="PNG", optimize=True)

    elif op == "compress":
        if not video_present:
            raise RuntimeError("ضغط الفيديو يحتاج ملف فيديو. اختر استخراج الصوت أو تحويل الصور للأنواع الأخرى.")
        quality = int(settings.get("quality", 26))
        if quality not in {19, 23, 26, 30, 34}:
            raise RuntimeError("إعداد الجودة غير صالح.")
        resolution = str(settings.get("resolution", "original"))
        if resolution not in {"original", "2160", "1440", "1080", "720", "480"}:
            raise RuntimeError("الدقة المختارة غير مدعومة.")
        output_path = job_dir / f"{safe_stem}_compressed.mp4"
        command = ["ffmpeg", "-nostdin", "-y", "-i", str(input_path), "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(quality), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"]
        if resolution != "original":
            command += ["-vf", _ffmpeg_scale(int(resolution))]
        command += ["-movflags", "+faststart", str(output_path)]
        _progress(35, "ضغط الفيديو وإعادة ترميزه")
        _run(command)

    elif op == "convert":
        output_format = str(settings.get("output_format", "mp4")).lower()
        if output_format not in {"mp4", "webm", "mkv", "mov", "mp3", "wav", "m4a", "ogg", "flac"}:
            raise RuntimeError("صيغة الإخراج غير مدعومة.")
        output_path = job_dir / f"{safe_stem}_converted.{output_format}"
        if output_format in {"mp3", "wav", "m4a", "ogg", "flac"}:
            if not audio_present:
                raise RuntimeError("الملف لا يحتوي على مسار صوت.")
            command = ["ffmpeg", "-nostdin", "-y", "-i", str(input_path), "-vn", "-map", "0:a:0"]
            if output_format == "mp3": command += ["-c:a", "libmp3lame", "-q:a", "2"]
            elif output_format == "wav": command += ["-c:a", "pcm_s16le"]
            elif output_format == "m4a": command += ["-c:a", "aac", "-b:a", "192k"]
            elif output_format == "ogg": command += ["-c:a", "libvorbis", "-q:a", "5"]
            else: command += ["-c:a", "flac"]
        else:
            if not video_present:
                raise RuntimeError("تحويل الفيديو يحتاج ملف فيديو.")
            command = ["ffmpeg", "-nostdin", "-y", "-i", str(input_path), "-map", "0:v:0", "-map", "0:a?"]
            if output_format == "webm": command += ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "6", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-b:a", "128k"]
            else: command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"]
            if output_format in {"mp4", "mov"}: command += ["-movflags", "+faststart"]
        command += [str(output_path)]
        _progress(35, f"تحويل الملف إلى {output_format.upper()}")
        _run(command)

    elif op == "audio":
        if not audio_present:
            raise RuntimeError("الملف لا يحتوي على مسار صوت.")
        output_format = str(settings.get("output_format", "mp3")).lower()
        if output_format not in {"mp3", "wav", "m4a", "ogg", "flac"}:
            raise RuntimeError("صيغة الصوت غير مدعومة.")
        output_path = job_dir / f"{safe_stem}_audio.{output_format}"
        command = ["ffmpeg", "-nostdin", "-y", "-i", str(input_path), "-vn", "-map", "0:a:0"]
        if output_format == "mp3": command += ["-c:a", "libmp3lame", "-q:a", "2"]
        elif output_format == "wav": command += ["-c:a", "pcm_s16le"]
        elif output_format == "m4a": command += ["-c:a", "aac", "-b:a", "192k"]
        elif output_format == "ogg": command += ["-c:a", "libvorbis", "-q:a", "5"]
        else: command += ["-c:a", "flac"]
        command += [str(output_path)]
        _progress(35, "استخراج الصوت")
        _run(command)

    elif op == "frame":
        if not video_present:
            raise RuntimeError("استخراج الإطارات يحتاج ملف فيديو.")
        timestamp = float(settings.get("timestamp", 1))
        if timestamp < 0 or timestamp > 86_400:
            raise RuntimeError("الوقت لازم يكون بين 0 و86400 ثانية.")
        output_path = job_dir / f"{safe_stem}_frame.jpg"
        _progress(35, "استخراج الإطار من الفيديو")
        _run(["ffmpeg", "-nostdin", "-y", "-ss", str(timestamp), "-i", str(input_path), "-frames:v", "1", "-q:v", "2", str(output_path)])

    elif op == "trim":
        if not video_present:
            raise RuntimeError("قص الفيديو يحتاج ملف فيديو.")
        start = float(settings.get("trim_start", 0))
        duration = float(settings.get("trim_duration", 10))
        if start < 0 or duration <= 0 or duration > 3600 or start + duration > 86_400:
            raise RuntimeError("وقت القص أو مدته غير صالحين. الحد الأقصى للمقطع ساعة واحدة.")
        output_path = job_dir / f"{safe_stem}_clip.mp4"
        _progress(35, "قص المقطع وإعادة ترميزه")
        _run(["ffmpeg", "-nostdin", "-y", "-ss", str(start), "-i", str(input_path), "-t", str(duration), "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(output_path)])

    elif op == "enhance":
        if not video_present:
            raise RuntimeError("تحسين الفيديو يحتاج ملف فيديو أو اختر صورة.")
        factor = float(settings.get("scale", 1.5))
        if factor not in {1.5, 2.0}:
            raise RuntimeError("معامل التكبير غير مدعوم.")
        output_path = job_dir / f"{safe_stem}_enhanced.mp4"
        vf = f"scale=trunc(iw*{factor}/2)*2:trunc(ih*{factor}/2)*2:flags=lanczos,unsharp=5:5:0.7:3:3:0.3"
        _progress(35, "تكبير تقليدي وتحسين الحدة (من دون نموذج AI)")
        _run(["ffmpeg", "-nostdin", "-y", "-i", str(input_path), "-map", "0:v:0", "-map", "0:a?", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(output_path)])
        result["enhancement_mode"] = "traditional-lanczos-unsharp"

    else:
        raise RuntimeError("العملية غير مدعومة.")

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("انتهت المعالجة دون إنشاء ملف صالح.")
    _progress(100, "اكتملت المعالجة")
    result.update({
        "output_path": str(output_path.resolve()),
        "output_name": output_path.name,
        "output_size": output_path.stat().st_size,
        "input_size": input_path.stat().st_size,
        "operation": op,
    })
    if r2_enabled():
        # Upload from the server-side worker; never expose R2 credentials to the browser.
        result["r2_key"] = _upload_result_to_r2(output_path, job_id, output_path.name)
        output_path.unlink(missing_ok=True)
        result.pop("output_path", None)
    return result
