from __future__ import annotations

import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.jobs import MEDIA_ROOT, process_media_job


def test_serves_evel_branded_website() -> None:
    with TestClient(main.app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert "LUMAGLASS" in response.text
    assert "EVEL" in response.text
    assert "apiAccessKey" in response.text


def test_health_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "_queue_ready", lambda: False)
    with TestClient(main.app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    for key in ("service", "queue", "ffmpeg", "max_upload_mb", "access_key_required", "r2_enabled"):
        assert key in data
    assert data["service"] == "LumaGlass Studio by EVEL"
    assert data["ok"] is False  # queue is intentionally unavailable in this test


def test_job_creation_requires_the_configured_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "API_ACCESS_TOKEN", "test-token-for-ci")
    monkeypatch.setattr(main, "REQUIRE_API_KEY", True)
    monkeypatch.setattr(main, "_queue_ready", lambda: False)
    data = {"operation": "image", "output_format": "webp"}
    files = {"file": ("image.png", b"not-used-before-auth", "image/png")}
    with TestClient(main.app) as client:
        missing = client.post("/api/jobs", data=data, files=files)
        invalid = client.post("/api/jobs", headers={"X-API-Key": "wrong"}, data=data, files=files)
        valid = client.post("/api/jobs", headers={"X-API-Key": "test-token-for-ci"}, data=data, files=files)
    assert missing.status_code == 401
    assert invalid.status_code == 401
    # A correct key passes the authorization gate; the intentionally disabled queue returns 503.
    assert valid.status_code == 503
    assert "Redis" in valid.text or "طابور" in valid.text


def _make_job_input(original: Path, source_name: str) -> tuple[str, Path]:
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex
    job_dir = MEDIA_ROOT / job_id
    job_dir.mkdir(parents=True)
    source = job_dir / source_name
    shutil.copy2(original, source)
    return job_id, source


def _run_job(original: Path, source_name: str, output_name: str, operation: str, **overrides):
    job_id, source = _make_job_input(original, source_name)
    settings = {
        "operation": operation,
        "output_format": "mp4",
        "quality": 26,
        "resolution": "original",
        "timestamp": 0.5,
        "trim_start": 0.1,
        "trim_duration": 0.6,
        "scale": 1.5,
        "max_width": 800,
        "original_name": output_name,
    }
    settings.update(overrides)
    result = process_media_job(job_id, str(source), settings)
    output = Path(result["output_path"])
    assert output.is_file()
    assert result["output_size"] > 0
    return result


@pytest.fixture(scope="module")
def sample_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("FFmpeg isn't installed in this test environment")
    path = tmp_path_factory.mktemp("lumaglass-video") / "sample.mp4"
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=12",
        "-f", "lavfi", "-i", "sine=frequency=800:duration=1",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path),
    ]
    subprocess.run(command, check=True, timeout=30)
    return path


def test_ffmpeg_media_operations(sample_video: Path) -> None:
    cases = [
        ("compress", "sample.mp4", {"resolution": "720"}),
        ("convert", "sample.mp4", {"output_format": "webm"}),
        ("audio", "sample.mp4", {"output_format": "mp3"}),
        ("frame", "sample.mp4", {"timestamp": 0.5}),
        ("trim", "sample.mp4", {"trim_start": 0.1, "trim_duration": 0.6}),
        ("enhance", "sample.mp4", {"scale": 1.5}),
    ]
    for operation, original_name, options in cases:
        result = _run_job(sample_video, "source.mp4", original_name, operation, **options)
        assert result["operation"] == operation


def test_image_conversion_and_traditional_upscale(tmp_path: Path) -> None:
    image = tmp_path / "sample.png"
    Image.new("RGBA", (64, 48), (40, 150, 210, 180)).save(image)
    converted = _run_job(image, "source.png", "picture.png", "image", output_format="webp", max_width=800)
    assert converted["output_name"].endswith(".webp")
    enhanced = _run_job(image, "source.png", "picture.png", "enhance", scale=1.5)
    assert enhanced["output_name"].endswith(".png")
    assert enhanced["enhancement_mode"] == "traditional-lanczos-unsharp"


def test_cleanup_task_starts_and_stops_with_application() -> None:
    with TestClient(main.app):
        assert main._cleanup_task is not None
        assert not main._cleanup_task.done()
    assert main._cleanup_task is None


def test_direct_url_import_fails_closed_without_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "API_ACCESS_TOKEN", "test-token-for-ci")
    monkeypatch.setattr(main, "REQUIRE_API_KEY", True)
    monkeypatch.setattr(main, "ALLOWED_DIRECT_HOSTS", set())
    with TestClient(main.app) as client:
        response = client.post(
            "/api/url-jobs",
            headers={"X-API-Key": "test-token-for-ci"},
            data={"url": "https://media.example/video.mp4"},
        )
    assert response.status_code == 503
    assert "غير مفعّل" in response.text


def test_direct_url_validation_requires_https_and_allowlisted_host(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    monkeypatch.setattr(main, "ALLOWED_DIRECT_HOSTS", {"media.example"})
    with pytest.raises(HTTPException) as insecure:
        main._validate_public_target("http://media.example/video.mp4")
    assert insecure.value.status_code == 400

    monkeypatch.setattr(main, "ALLOWED_DIRECT_HOSTS", set())
    with pytest.raises(HTTPException) as unlisted:
        main._validate_public_target("https://media.example/video.mp4")
    assert unlisted.value.status_code == 403


def test_direct_url_validation_rejects_private_ip_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    monkeypatch.setattr(main, "ALLOWED_DIRECT_HOSTS", {"media.example"})
    monkeypatch.setattr(main.socket, "getaddrinfo", lambda *args, **kwargs: [(None, None, None, None, ("127.0.0.1", 443))])
    with pytest.raises(HTTPException) as rejected:
        main._validate_public_target("https://media.example/video.mp4")
    assert rejected.value.status_code == 403
