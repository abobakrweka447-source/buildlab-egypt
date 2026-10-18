from __future__ import annotations

import asyncio
import hmac
import ipaddress
import os
import re
import shutil
import socket
import time
import uuid
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

import httpx
import redis
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from rq import Queue
from rq.job import Job

from app.jobs import ALL_EXTENSIONS, IMAGE_EXTENSIONS, MEDIA_ROOT, r2_enabled, r2_presigned_url

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = APP_ROOT / "static"
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
MAX_UPLOAD_MB = max(10, int(os.getenv("MAX_UPLOAD_MB", "500")))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
RETENTION_SECONDS = max(3600, int(os.getenv("RETENTION_HOURS", "24")) * 3600)
API_ACCESS_TOKEN = os.getenv("API_ACCESS_TOKEN", "").strip()
REQUIRE_API_KEY = os.getenv("REQUIRE_API_KEY", "true").strip().lower() not in {"0", "false", "no", "off"}
ALLOWED_DIRECT_HOSTS = {x.strip().lower() for x in os.getenv("ALLOWED_DIRECT_HOSTS", "").split(",") if x.strip()}
ALLOWED_URL_EXTENSIONS = ALL_EXTENSIONS
redis_conn = redis.from_url(REDIS_URL, socket_connect_timeout=2, socket_timeout=2)
queue = Queue("media-jobs", connection=redis_conn, default_timeout=int(os.getenv("JOB_TIMEOUT", "7200")))

app = FastAPI(title="LumaGlass Studio by EVEL", version="0.2.1")
app.mount("/static", StaticFiles(directory=str(STATIC_ROOT)), name="static")


def _require_api_key(supplied: str | None) -> None:
    """Fail closed in production if a token is required but not configured."""
    if not API_ACCESS_TOKEN:
        if REQUIRE_API_KEY:
            raise HTTPException(status_code=503, detail="الخادم لم يضبط مفتاح الوصول بعد. عيّن API_ACCESS_TOKEN في إعدادات الاستضافة.")
        return
    if not supplied or not hmac.compare_digest(supplied, API_ACCESS_TOKEN):
        raise HTTPException(status_code=401, detail="مفتاح الوصول غير موجود أو غير صحيح. افتح إعدادات الموقع وأدخل مفتاح السيرفر.")


def _queue_ready() -> bool:
    try:
        redis_conn.ping()
        return True
    except Exception:
        return False


def _enqueue(input_path: Path, job_id: str, original_name: str, options: dict) -> dict:
    options["original_name"] = original_name
    queue.enqueue(
        "app.jobs.process_media_job",
        job_id,
        str(input_path.resolve()),
        options,
        job_id=job_id,
        result_ttl=RETENTION_SECONDS,
        failure_ttl=RETENTION_SECONDS,
        description=f"{options.get('operation', 'media')}:{job_id}",
    )
    return {"job_id": job_id, "status": "queued", "message": "تمت إضافة المهمة إلى طابور المعالجة."}


def _validate_options(operation: str, output_format: str, quality: int, resolution: str,
                      timestamp: float, trim_start: float, trim_duration: float,
                      scale: float, max_width: int) -> dict:
    if operation not in {"compress", "convert", "audio", "frame", "trim", "image", "enhance"}:
        raise HTTPException(status_code=400, detail="نوع العملية غير مدعوم.")
    if output_format not in {"mp4", "webm", "mkv", "mov", "mp3", "wav", "m4a", "ogg", "flac", "jpg", "jpeg", "png", "webp"}:
        raise HTTPException(status_code=400, detail="صيغة الإخراج غير مدعومة.")
    if quality not in {19, 23, 26, 30, 34}:
        raise HTTPException(status_code=400, detail="إعداد الجودة غير صالح.")
    if resolution not in {"original", "2160", "1440", "1080", "720", "480"}:
        raise HTTPException(status_code=400, detail="الدقة المختارة غير مدعومة.")
    if not (0 <= timestamp <= 86400 and 0 <= trim_start <= 86400 and 0 < trim_duration <= 3600 and scale in {1.5, 2.0} and max_width in {0, 800, 1280, 1920, 2560}):
        raise HTTPException(status_code=400, detail="إعدادات العملية خارج النطاق المسموح.")
    return {
        "operation": operation, "output_format": output_format,
        "quality": quality, "resolution": resolution,
        "timestamp": timestamp, "trim_start": trim_start,
        "trim_duration": trim_duration, "scale": scale,
        "max_width": max_width,
    }


def _clean_name(filename: str | None) -> str:
    name = (filename or "media").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^\w.()\- ء-ي]+", "_", name, flags=re.UNICODE).strip(" ._")
    return (name or "media")[:120]


async def _save_upload(file: UploadFile, destination: Path) -> int:
    suffix = Path(_clean_name(file.filename)).suffix.lower()
    if suffix not in ALL_EXTENSIONS:
        raise HTTPException(status_code=415, detail="امتداد الملف غير مدعوم.")
    total = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    output.close()
                    destination.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail=f"الحد الأقصى لحجم الملف هو {MAX_UPLOAD_MB} ميجابايت.")
                output.write(chunk)
    finally:
        await file.close()
    if total == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="الملف فارغ.")
    return total


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((STATIC_ROOT / "index.html").read_text(encoding="utf-8"))


@app.get("/api/health")
async def health():
    q_ok = _queue_ready()
    ffmpeg = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
    return {
        "ok": bool(q_ok and ffmpeg and (not REQUIRE_API_KEY or API_ACCESS_TOKEN)),
        "service": "LumaGlass Studio by EVEL",
        "queue": q_ok,
        "ffmpeg": ffmpeg,
        "max_upload_mb": MAX_UPLOAD_MB,
        "retention_hours": int(RETENTION_SECONDS / 3600),
        "direct_url_import": bool(ALLOWED_DIRECT_HOSTS),
        "direct_url_hosts_count": len(ALLOWED_DIRECT_HOSTS),
        "access_key_required": REQUIRE_API_KEY,
        "access_key_configured": bool(API_ACCESS_TOKEN),
        "r2_enabled": r2_enabled(),
    }


@app.post("/api/jobs")
async def create_job(
    file: Annotated[UploadFile, File(...)],
    operation: Annotated[str, Form()] = "compress",
    output_format: Annotated[str, Form()] = "mp4",
    quality: Annotated[int, Form()] = 26,
    resolution: Annotated[str, Form()] = "original",
    timestamp: Annotated[float, Form()] = 1,
    trim_start: Annotated[float, Form()] = 0,
    trim_duration: Annotated[float, Form()] = 10,
    scale: Annotated[float, Form()] = 2,
    max_width: Annotated[int, Form()] = 0,
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
):
    _require_api_key(x_api_key)
    if not _queue_ready():
        raise HTTPException(status_code=503, detail="طابور المعالجة غير متاح حاليًا. راجع اتصال Redis.")
    options = _validate_options(operation, output_format, quality, resolution, timestamp, trim_start, trim_duration, scale, max_width)
    original_name = _clean_name(file.filename)
    if operation in {"image"} and Path(original_name).suffix.lower() not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=415, detail="هذه العملية تتطلب صورة.")
    job_id = uuid.uuid4().hex
    job_dir = MEDIA_ROOT / job_id
    input_path = job_dir / f"source{Path(original_name).suffix.lower()}"
    try:
        await _save_upload(file, input_path)
        return _enqueue(input_path, job_id, original_name, options)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=503, detail="تعذّر إنشاء المهمة. تأكد من جاهزية طابور المعالجة.") from exc


def _host_is_allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    return host in ALLOWED_DIRECT_HOSTS


def _validate_public_target(url: str) -> tuple[str, str]:
    parsed = urlparse(url.strip())
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise HTTPException(status_code=400, detail="استخدم رابط HTTPS مباشرًا لملف وسائط عام، من دون بيانات دخول أو منفذ مخصص.")
    host = parsed.hostname.lower().rstrip(".")
    if not _host_is_allowed(host):
        raise HTTPException(status_code=403, detail="هذا النطاق غير مفعّل لاستيراد الروابط. تُقبل فقط النطاقات التي يضيفها مدير الخدمة إلى القائمة المسموحة.")
    suffix = Path(parsed.path).suffix.lower()
    if suffix not in ALLOWED_URL_EXTENSIONS:
        raise HTTPException(status_code=415, detail="الرابط لا يبدو رابط ملف وسائط مباشرًا بصيغة مدعومة؛ صفحات المنصات غير مدعومة هنا.")
    # Also reject a hostname that resolves to a private or special-use address.
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise HTTPException(status_code=403, detail="رفض الرابط لأن عنوانه لا يُعد عنوانًا عامًا آمنًا.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="تعذّر التحقق من نطاق الرابط.") from exc
    return host, suffix


@app.post("/api/url-jobs")
async def create_url_job(
    url: Annotated[str, Form()],
    operation: Annotated[str, Form()] = "compress",
    output_format: Annotated[str, Form()] = "mp4",
    quality: Annotated[int, Form()] = 26,
    resolution: Annotated[str, Form()] = "original",
    timestamp: Annotated[float, Form()] = 1,
    trim_start: Annotated[float, Form()] = 0,
    trim_duration: Annotated[float, Form()] = 10,
    scale: Annotated[float, Form()] = 2,
    max_width: Annotated[int, Form()] = 0,
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
):
    _require_api_key(x_api_key)
    if not ALLOWED_DIRECT_HOSTS:
        raise HTTPException(status_code=503, detail="استيراد الروابط المباشرة غير مفعّل بعد. يمكن استخدام رفع الملفات الآن، ويجب أن يضبط مدير السيرفر قائمة النطاقات المسموحة أولًا.")
    if not _queue_ready():
        raise HTTPException(status_code=503, detail="طابور المعالجة غير متاح حاليًا.")
    options = _validate_options(operation, output_format, quality, resolution, timestamp, trim_start, trim_duration, scale, max_width)
    host, suffix = _validate_public_target(url)
    job_id = uuid.uuid4().hex
    job_dir = MEDIA_ROOT / job_id
    input_path = job_dir / f"source{suffix}"
    job_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    headers = {"User-Agent": "LumaMediaStudio/1.0", "Accept": "video/*,audio/*,image/*,application/octet-stream;q=0.8"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45, read=90), follow_redirects=False, headers=headers, trust_env=False) as client:
            async with client.stream("GET", url) as response:
                if response.is_redirect:
                    raise HTTPException(status_code=400, detail="الرابط يحوّل إلى عنوان آخر؛ الروابط المحوّلة غير مدعومة لأسباب أمنية.")
                if response.status_code != 200:
                    raise HTTPException(status_code=400, detail=f"تعذّر تنزيل الملف من المصدر (HTTP {response.status_code}).")
                content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if not (content_type.startswith(("video/", "audio/", "image/")) or content_type == "application/octet-stream"):
                    raise HTTPException(status_code=415, detail="المصدر لا يقدّم ملف وسائط مباشرًا.")
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"الحد الأقصى لحجم الملف هو {MAX_UPLOAD_MB} ميجابايت.")
                with input_path.open("wb") as output:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_UPLOAD_BYTES:
                            raise HTTPException(status_code=413, detail=f"الحد الأقصى لحجم الملف هو {MAX_UPLOAD_MB} ميجابايت.")
                        output.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="المصدر أعاد ملفًا فارغًا.")
        name = Path(urlparse(url).path).name or f"media{suffix}"
        return _enqueue(input_path, job_id, _clean_name(name), options)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=502, detail="فشل جلب الملف من المصدر المسموح به.") from exc


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(status_code=400, detail="معرّف المهمة غير صالح.")
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        status_value = job.get_status(refresh=True)
        status = status_value.value if hasattr(status_value, "value") else str(status_value)
        result = job.result if status == "finished" and isinstance(job.result, dict) else None
        meta = job.meta or {}
        error = None
        if status == "failed":
            error = "فشلت المعالجة. جرّب ملفًا آخر أو إعدادات مختلفة."
            if job.exc_info:
                lines = job.exc_info.strip().splitlines()
                last_line = lines[-1] if lines else ""
                if last_line and len(last_line) < 500:
                    error = last_line
        return {
            "job_id": job_id,
            "status": status,
            "progress": int(meta.get("progress", 0 if status == "queued" else (100 if status == "finished" else 5))),
            "message": meta.get("message", "في انتظار بدء المعالجة" if status == "queued" else "جارٍ معالجة الملف"),
            "result": ({"output_name": result.get("output_name"), "output_size": result.get("output_size"), "input_size": result.get("input_size"), "enhancement_mode": result.get("enhancement_mode"), "download_url": f"/api/jobs/{job_id}/download"} if result else None),
            "error": error,
        }
    except Exception as exc:
        raise HTTPException(status_code=404, detail="المهمة غير موجودة أو انتهت مدة الاحتفاظ بها.") from exc


@app.get("/api/jobs/{job_id}/download")
async def download_result(job_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(status_code=400, detail="معرّف المهمة غير صالح.")
    try:
        job = Job.fetch(job_id, connection=redis_conn)
        status_value = job.get_status(refresh=True)
        status = status_value.value if hasattr(status_value, "value") else str(status_value)
        if status != "finished" or not isinstance(job.result, dict):
            raise HTTPException(status_code=409, detail="النتيجة لم تكتمل بعد.")
        r2_key = job.result.get("r2_key")
        if r2_key:
            return RedirectResponse(url=r2_presigned_url(r2_key), status_code=302)
        path = Path(job.result.get("output_path", "")).resolve()
        if MEDIA_ROOT not in path.parents or not path.is_file() or path.parent != (MEDIA_ROOT / job_id).resolve():
            raise HTTPException(status_code=404, detail="ملف النتيجة غير متاح.")
        return FileResponse(path, filename=job.result.get("output_name", path.name), media_type="application/octet-stream")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=404, detail="لم يتم العثور على نتيجة المعالجة.") from exc


async def _cleanup_loop() -> None:
    """Periodically remove expired local job folders, including abandoned uploads."""
    while True:
        cutoff = time.time() - RETENTION_SECONDS
        try:
            MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
            for folder in MEDIA_ROOT.iterdir():
                if not folder.is_dir():
                    continue
                try:
                    newest = max([folder.stat().st_mtime] + [p.stat().st_mtime for p in folder.rglob("*") if p.is_file()])
                    if newest < cutoff:
                        shutil.rmtree(folder, ignore_errors=True)
                except (FileNotFoundError, PermissionError):
                    continue
        except OSError:
            pass
        await asyncio.sleep(3600)


_cleanup_task: asyncio.Task | None = None


async def _start_cleanup() -> None:
    global _cleanup_task
    if _cleanup_task is None or _cleanup_task.done():
        _cleanup_task = asyncio.create_task(_cleanup_loop(), name="evel-media-cleanup")


async def _stop_cleanup() -> None:
    global _cleanup_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
        finally:
            _cleanup_task = None


app.add_event_handler("startup", _start_cleanup)
app.add_event_handler("shutdown", _stop_cleanup)


