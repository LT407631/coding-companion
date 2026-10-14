"""Small, authenticated playback descriptors. Never fetch video bytes here."""
from urllib.parse import urlparse
import re


def descriptors(provider, series_id, ep, count=4, force=False):
    _, episodes = provider.get_episodes(series_id)
    selected = [e for e in episodes if ep <= int(e["index"]) < ep + count]
    if not selected or int(selected[0]["index"]) != ep:
        raise ValueError("集数不存在")
    tracks = provider.get_video_tracks([str(e["vid"]) for e in selected], force=force)
    results = []
    for episode in selected:
        options = tracks.get(str(episode["vid"]), [])
        # AVC works on more browsers; prefer it when available. HEVC is retained
        # for sources which only supply HEVC and devices which already play it.
        def codec(t):
            return str((t.get("video_meta") or {}).get("codec_type") or t.get("codec_type") or "").lower()
        avc = [t for t in options if codec(t) in {"h264", "avc", "avc1", "264"}]
        hevc = [t for t in options if codec(t) in {"bytevc1", "h265", "hevc", "hvc1", "hev1"}]
        # ByteVC2 (bvc2) needs a proprietary decoder; never choose it for a
        # native browser even if its resolution matches the requested quality.
        pool = avc or hevc
        def height(t):
            m = t.get("video_meta") or {}
            return int(re.sub(r"\D", "", str(m.get("definition", ""))) or m.get("vheight") or 0)
        below = [t for t in pool if height(t) <= 720]
        if not pool:
            continue
        track = max(below, key=height) if below else min(pool, key=height)
        raw = track.get("main_url", "")
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not (host == "qznovelvod.com" or host.endswith(".qznovelvod.com")):
            continue
        encrypt = track.get("encrypt_info") or {}
        meta = track.get("video_meta") or {}
        results.append({"ep": int(episode["index"]), "vid": str(episode["vid"]),
                        "url": raw, "encrypted": bool(encrypt.get("encrypt")),
                        "spade": encrypt.get("spade_a") if encrypt.get("encrypt") else None,
                        "bytes": int(meta.get("size") or 0), "codec": codec(track),
                        "quality": str(meta.get("definition") or "")})
    if not any(item["ep"] == ep for item in results):
        raise ValueError("暂时没有可直连的 HTTPS 视频源")
    return {"series_id": series_id, "episodes": results}
