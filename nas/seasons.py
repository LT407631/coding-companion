"""Find seasons by platform album ID, keeping different adaptations separate."""
import re
import json
import os
from pathlib import Path
import tempfile
import threading
import time


SCAN_VERSION = 5
MAX_CANDIDATES = 120


class _Lookup:
    def __init__(self):
        self.done = threading.Event()
        self.result = None
        self.error = None


class SeasonCache:
    """Persist album lists; serve stale data while a single worker refreshes it."""
    def __init__(self, path, ttl=86400, fallback=None, website_only=False):
        self.path, self.ttl = Path(path), ttl
        self.fallback = fallback
        self.website_only = website_only
        self._lock = threading.RLock()
        self._miss_jobs = {}
        self._jobs, self._retry_after = {}, {}
        self._generation = 0
        try:
            stored = json.loads(self.path.read_text())
            self._groups, self._series = stored["groups"], stored["series"]
            if not isinstance(self._groups, dict) or not isinstance(self._series, dict):
                raise ValueError("Invalid season cache")
        except (OSError, ValueError, KeyError, TypeError):
            self._groups, self._series = {}, {}

    def put(self, sid, data, generation=None, search_hint=""):
        with self._lock:
            if generation is not None and generation != self._generation:
                return
            key = "album:" + str(data["album_id"]) if data.get("album_id") else "series:" + sid
            groups, series = dict(self._groups), dict(self._series)
            previous = (groups.get(key) or {}).get("data") or {}
            members = {str(item["series_id"]): item for item in previous.get("items", [])}
            incoming = {str(item["series_id"]): item for item in data["items"]}
            # Search is not an authoritative deletion list. Keep validated album members
            # when the platform temporarily returns fewer seasons.
            if members.keys() - incoming.keys():
                members.update(incoming)
                data = {**data, "partial": True, "items": sorted(members.values(), key=_sort_key)}
            groups[key] = {"updated_at": time.time(), "data": data, "scan_version": SCAN_VERSION, "search_hint": search_hint or data.get("lookup_query", "")}
            for item in data["items"]:
                series[str(item["series_id"])] = key
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                                 prefix="season-cache-", suffix=".tmp", delete=False) as handle:
                    temp_path = handle.name
                    json.dump({"version": 1, "groups": groups, "series": series},
                              handle, ensure_ascii=False)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, self.path)
                self._groups, self._series = groups, series
                return data
            finally:
                if temp_path and os.path.exists(temp_path):
                    os.unlink(temp_path)

    def _cached(self, h, sid, refresh, search_hint=""):
        with self._lock:
            key = self._series.get(sid)
            record = self._groups.get(key)
            if not record or not any(str(item["series_id"]) == sid for item in record["data"]["items"]):
                return None
            ttl = min(self.ttl, 600) if record["data"].get("partial") else self.ttl
            stale = (bool(search_hint) and (record["data"].get("partial") or len(record["data"]["items"]) <= 1) and record.get("search_hint") != search_hint) or record.get("scan_version") != SCAN_VERSION or time.time() - record["updated_at"] >= ttl
            if (refresh or stale) and key not in self._jobs:
                if refresh or time.time() >= self._retry_after.get(key, 0):
                    self._jobs[key] = self._generation
                    threading.Thread(target=self._refresh, args=(h, sid, key, self._generation, search_hint or record.get("search_hint", "")), daemon=True).start()
            return {**record["data"], "cached": True, "updated_at": record["updated_at"],
                    "refreshing": key in self._jobs, "refresh_error": key in self._retry_after}

    def _refresh(self, h, sid, key, generation, search_hint=""):
        try:
            self.put(sid, self._lookup(h, sid, True, search_hint), generation, search_hint)
            with self._lock:
                if generation == self._generation:
                    self._retry_after.pop(key, None)
        except Exception:
            with self._lock:
                if generation == self._generation:
                    self._retry_after[key] = time.time() + 60
        finally:
            with self._lock:
                if self._jobs.get(key) == generation:
                    self._jobs.pop(key, None)

    def _lookup(self, h, sid, refresh, search_hint):
        options = {"refresh": refresh, "search_hint": search_hint}
        if self.fallback is not None:
            options["fallback"] = self.fallback
        if self.website_only:
            options['website_only'] = True
        return get_seasons(h, sid, **options)

    def get(self, h, sid, refresh=False, search_hint=""):
        result = self._cached(h, sid, refresh, search_hint)
        if result is not None:
            return result
        # Deduplicate only the same series. A slow abandoned detail must not
        # serialize every subsequent, unrelated cold lookup behind it.
        with self._lock:
            generation = self._generation
            key = (generation, sid)
            flight = self._miss_jobs.get(key)
            owner = flight is None
            if owner:
                flight = self._miss_jobs[key] = _Lookup()
        if not owner:
            if not flight.done.wait(55):
                raise TimeoutError("等待季列表超时，请稍后重试")
            if flight.error is not None:
                raise flight.error
            return {**flight.result, "cached": True}
        try:
            result = self._cached(h, sid, refresh, search_hint)
            if result is not None:
                flight.result = result
                return result
            data = self._lookup(h, sid, refresh, search_hint)
            data = self.put(sid, data, generation, search_hint) or data
            flight.result = {**data, "cached": False, "refreshing": False, "refresh_error": False}
            return flight.result
        except Exception as exc:
            flight.error = exc
            raise
        finally:
            with self._lock:
                self._miss_jobs.pop(key, None)
                flight.done.set()

    def clear(self):
        with self._lock:
            self._generation += 1
            self._groups.clear()
            self._series.clear()
            self._jobs.clear()
            self._retry_after.clear()
            self._miss_jobs.clear()
            self.path.unlink(missing_ok=True)


def _detail(h, ids):
    response = h.api("POST", "/novel/player/multi_video_detail/v1/",
                     body=h._episodes_body(",".join(ids)))
    fields = ("series_title", "season_index", "related_album_id", "episode_cnt")
    return {str(sid): {**{name: row["video_data"].get(name) for name in fields},
                      "_related_book_title": ((row.get("video_relate_book") or {}).get("book_info") or {}).get("book_name") or ""}
            for sid, row in (response.get("data") or {}).items() if row.get("video_data")}


def _root(title, season=0):
    title = re.split(r"[:：]", title, maxsplit=1)[0].strip()
    number = r"[0-9一二三四五六七八九十百零〇两]+"
    root = re.sub(r"[\s·:：-]*第\s*" + number + r"\s*[季部](?:\s*续集\s*" + number + r")?\s*$", "", title)
    if root == title and season > 0:
        # Bare numbers are season suffixes only when they match platform metadata.
        # The digit boundary preserves years such as 2021 and longer numeric names.
        root = re.sub(r"(?<!\d)" + str(season) + r"$", "", root)
    return root.strip()


def _sort_key(item):
    return (item.get("season", 0), item.get("title", ""), item["series_id"])


def _item(sid, video):
    return {"series_id": sid, "title": video.get("series_title") or "",
            "season": int(video.get("season_index") or 0),
            "episode_cnt": video.get("episode_cnt") or 0}


def _website_ids(fallback, query):
    return {str(row['series_id']) for row in fallback.search(query)[:MAX_CANDIDATES]
            if isinstance(row, dict) and re.fullmatch(r'\d{1,24}', str(row.get('series_id') or ''))}


def get_seasons(h, sid, refresh=False, search_hint="", fallback=None, website_only=False):
    current = _detail(h, [sid]).get(sid)
    if not current:
        raise ValueError("剧集不存在")
    album = str(current.get("related_album_id") or "")
    if not album:
        return {"items": [_item(sid, current)], "partial": False, "album_id": ""}
    key = h.SG.cache_key("nas-seasons-v5", album)
    cached = h.SG.cache_get(key)
    if not refresh and cached is not None and (not search_hint or cached.get("lookup_query") == search_hint) and any(str(item["series_id"]) == sid for item in cached["items"]):
        return cached
    root = _root(current.get("series_title") or "", int(current.get("season_index") or 0))
    query_title = search_hint.strip()[:100] or str(current.get("_related_book_title") or "").strip()[:100] or root
    if not query_title:
        return {"items": [_item(sid, current)], "partial": True, "album_id": album}
    ids = {sid}
    offset, passback, search_id = 0, "", ""
    visited = set()
    partial = False
    if website_only:
        ids.update(_website_ids(fallback, query_title))
        partial = True
    for _ in range(0 if website_only else 12):
        token = (str(offset), passback)
        if token in visited:
            partial = True
            break
        visited.add(token)
        query = {"query": query_title, "tab_name": "feed", "search_source": "1",
                 "offset": str(offset), "count": "0", "use_correct": "true"}
        if passback:
            query["passback"] = passback
        if search_id:
            query["search_id"] = search_id
        try:
            response = h.api("GET", "/reading/bookapi/search/tab/v", extra_query=query)
            if not isinstance(response, dict) or response.get("code", 0) not in (0, '0'):
                raise ValueError("Invalid seasonal search response")
            tabs = response.get("search_tabs")
            if tabs == [] and fallback is None:
                break
            if not isinstance(tabs, list) or not tabs:
                raise ValueError("Missing seasonal search tabs")
            tab = tabs[0]
            if not isinstance(tab, dict) or not isinstance(tab.get("data"), list):
                raise ValueError("Invalid seasonal search page")
            cells = tab['data']
            if not cells and fallback is not None:
                raise ValueError("Empty seasonal search page")
        except Exception:
            if fallback is None:
                raise
            # Suggestions are discovery candidates, never authoritative album
            # membership. All IDs are still checked against platform metadata.
            ids.update(_website_ids(fallback, query_title))
            partial = True
            break
        for cell in cells:
            row = h._parse_search_cell(cell)
            if row and row.get("series_id"):
                ids.add(str(row["series_id"]))
                if len(ids) >= MAX_CANDIDATES:
                    partial = True
                    break
        if len(ids) >= MAX_CANDIDATES:
            break
        if not tab.get("has_more") or not cells:
            break
        offset = tab.get("next_offset", offset)
        passback = tab.get("passback") or passback
        search_id = tab.get("search_id") or search_id
    else:
        partial = True
    videos = {sid: current}
    others = sorted(ids - {sid})
    for start in range(0, len(others), 20):
        batch = others[start:start + 20]
        rows = _detail(h, batch)
        partial = partial or len(rows) < len(batch)
        videos.update(rows)
    items = [_item(item_sid, video) for item_sid, video in videos.items()
             if str(video.get("related_album_id") or "") == album]
    items.sort(key=_sort_key)
    partial = partial or (len(items) <= 1 and int(current.get("season_index") or 0) > 1)
    result = {"items": items, "partial": partial, "album_id": album, "lookup_query": query_title}
    h.SG.cache_set(key, result, ttl=600 if not partial else 60)
    return result
