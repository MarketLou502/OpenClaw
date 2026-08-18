#!/usr/bin/env python3
"""Given a TikTok URL, fetch what it takes to summarize it and print one JSON
object to stdout.

For a normal video post: downloads audio (yt-dlp) and transcribes it against
the local whisper-mlx Wyoming server (127.0.0.1:10300).

For a photo/slideshow post (a `/photo/` URL — an image carousel with no video
stream, which yt-dlp cannot touch at all): falls back automatically to a
headless-browser fetch (Playwright + Chromium) that loads the real page,
pulls the caption out of `og:description`, saves the unique carousel images
to disk, and — if the post has a background-audio track — downloads and
transcribes that too. This fallback is automatic; callers don't need to
know in advance which kind of post a URL is.

Must be run with the whisper-mlx venv's interpreter (it's the only place the
`wyoming` and `playwright` packages are installed on this machine):

    /Users/aaronmacmini/.openclaw/services/whisper-mlx/venv/bin/python3 \\
        tiktok_transcribe.py "<tiktok-url>"

Output (stdout, one JSON object):
    Video post:
      {"post_type": "video", "url", "title", "uploader", "caption",
       "duration_seconds", "transcript"}
    Photo post:
      {"post_type": "photo", "url", "title", "uploader", "caption",
       "image_paths": [...], "transcript": "" or spoken audio if present}
    or {"error": "..."} on failure (also sets a non-zero exit code).
"""
import asyncio
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(
    0,
    "/Users/aaronmacmini/.openclaw/services/whisper-mlx/venv/lib/python3.9/site-packages",
)
from wyoming.asr import Transcribe, Transcript  # noqa: E402
from wyoming.audio import AudioChunk, AudioStart, AudioStop  # noqa: E402
from wyoming.client import AsyncTcpClient  # noqa: E402

WHISPER_HOST = "127.0.0.1"
WHISPER_PORT = 10300
MAX_DURATION_SECONDS = 600  # TikToks are short; refuse anything past 10 min
# Fixed, overwritten-in-place location so photo downloads don't accumulate
# forever in this workspace-scoped-only agent's filesystem.
PHOTO_DIR = Path("/Users/aaronmacmini/.openclaw/workspace-research/tmp/latest-photo-post")


def fail(message: str) -> None:
    print(json.dumps({"error": message}))
    sys.exit(1)


class PhotoPost(Exception):
    pass


def download_video(url: str, workdir: Path) -> dict:
    audio_template = str(workdir / "audio.%(ext)s")
    proc = subprocess.run(
        [
            "yt-dlp",
            "--impersonate",
            "chrome",
            # yt-dlp's auto-picked "best" format for TikTok sometimes lands on
            # an audio-stripped CDN mirror (observed directly: same video,
            # deterministic per format id) while the "download" format (its
            # watermarked default) reliably has audio. Prefer it, but keep
            # bestaudio/best as fallback for videos without a "download" id.
            "-f",
            "download/bestaudio/best",
            "-x",
            "--audio-format",
            "wav",
            "--print-json",
            "-o",
            audio_template,
            url,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        if "Unsupported URL" in stderr:
            raise PhotoPost()
        fail(f"yt-dlp failed: {stderr[-500:]}")

    # --print-json prints the info dict as the last line of stdout.
    info_line = proc.stdout.strip().splitlines()[-1]
    info = json.loads(info_line)

    duration = info.get("duration") or 0
    if duration > MAX_DURATION_SECONDS:
        fail(f"video is {duration}s, longer than the {MAX_DURATION_SECONDS}s cap")

    wav_files = list(workdir.glob("audio.*"))
    if not wav_files:
        fail("yt-dlp reported success but no audio file was produced")

    return {"info": info, "wav_path": wav_files[0]}


def fetch_photo_post(url: str, workdir: Path) -> dict:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        page = ctx.new_page()
        try:
            page.goto(url, timeout=30000, wait_until="networkidle")
        except Exception as e:
            browser.close()
            fail(f"headless browser fetch failed: {e}")
        page.wait_for_timeout(2000)

        title = page.title() or ""
        caption = page.get_attribute('meta[property="og:description"]', "content") or ""
        uploader = ""
        m = re.search(r"tiktok\.com/@([\w.]+)/photo/", page.url)
        if m:
            uploader = m.group(1)

        img_urls = page.eval_on_selector_all("img", "els => els.map(e => e.src)")
        seen, unique_imgs = set(), []
        for u in img_urls:
            if "photomode-image" not in u:
                continue
            key_match = re.search(r"/([a-f0-9]{20,})~", u)
            key = key_match.group(1) if key_match else u
            if key not in seen:
                seen.add(key)
                unique_imgs.append(u)

        if not unique_imgs:
            browser.close()
            fail("page loaded but no carousel images were found — TikTok may have served a bot-detection page instead of the real post")

        audio_srcs = ctx.pages[0].eval_on_selector_all(
            "audio, video", "els => els.map(e => e.src || e.currentSrc).filter(Boolean)"
        )

        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        for old in PHOTO_DIR.glob("*"):
            old.unlink()

        image_paths = []
        for i, img_url in enumerate(unique_imgs):
            resp = ctx.request.get(img_url)
            dest = PHOTO_DIR / f"image_{i+1}.jpg"
            dest.write_bytes(resp.body())
            image_paths.append(str(dest))

        audio_wav_path = None
        if audio_srcs:
            resp = ctx.request.get(audio_srcs[0])
            raw_path = workdir / "photo_audio_raw"
            raw_path.write_bytes(resp.body())
            wav_path = workdir / "photo_audio.wav"
            conv = subprocess.run(
                ["ffmpeg", "-y", "-i", str(raw_path), str(wav_path)],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if conv.returncode == 0 and wav_path.exists():
                audio_wav_path = wav_path

        browser.close()

        return {
            "resolved_url": page.url,
            "title": title,
            "uploader": uploader,
            "caption": caption,
            "image_paths": image_paths,
            "audio_wav_path": audio_wav_path,
        }


async def transcribe(wav_path: Path) -> str:
    import wave

    with wave.open(str(wav_path), "rb") as wav_file:
        rate = wav_file.getframerate()
        width = wav_file.getsampwidth()
        channels = wav_file.getnchannels()
        audio_bytes = wav_file.readframes(wav_file.getnframes())

    async with AsyncTcpClient(WHISPER_HOST, WHISPER_PORT) as client:
        await client.write_event(Transcribe(language="en").event())
        await client.write_event(
            AudioStart(rate=rate, width=width, channels=channels).event()
        )

        chunk_size = 4096
        for i in range(0, len(audio_bytes), chunk_size):
            chunk = audio_bytes[i : i + chunk_size]
            await client.write_event(
                AudioChunk(rate=rate, width=width, channels=channels, audio=chunk).event()
            )

        await client.write_event(AudioStop().event())

        while True:
            event = await client.read_event()
            if event is None:
                return ""
            if Transcript.is_type(event.type):
                return Transcript.from_event(event).text


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: tiktok_transcribe.py <tiktok-url>")

    url = sys.argv[1]
    if shutil.which("yt-dlp") is None:
        fail("yt-dlp is not installed (expected on PATH via Homebrew)")

    workdir = Path(tempfile.mkdtemp(prefix="tiktok-transcribe-"))
    try:
        try:
            downloaded = download_video(url, workdir)
        except PhotoPost:
            photo = fetch_photo_post(url, workdir)
            transcript = ""
            if photo["audio_wav_path"]:
                transcript = asyncio.run(transcribe(photo["audio_wav_path"]))
            print(
                json.dumps(
                    {
                        "post_type": "photo",
                        "url": photo["resolved_url"],
                        "title": photo["title"],
                        "uploader": photo["uploader"],
                        "caption": photo["caption"],
                        "image_paths": photo["image_paths"],
                        "transcript": transcript,
                    }
                )
            )
            return

        info = downloaded["info"]
        transcript = asyncio.run(transcribe(downloaded["wav_path"]))

        print(
            json.dumps(
                {
                    "post_type": "video",
                    "url": info.get("webpage_url", url),
                    "title": info.get("title", ""),
                    "uploader": info.get("uploader", ""),
                    "caption": info.get("description", ""),
                    "duration_seconds": info.get("duration"),
                    "transcript": transcript,
                }
            )
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
