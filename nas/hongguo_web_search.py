"""Bounded fallback search using Hongguo's public suggestion endpoint."""
from concurrent.futures import ThreadPoolExecutor, wait
import json
import re
import time

import requests


SUGGEST_URL = "https://hongguoduanju.com/incent_resource/suggestion"
MAX_BODY = 256 * 1024
MAX_DETAIL_BODY = 512 * 1024
MAX_RESULTS = 20
DETAIL_WORKERS = 6
SOURCE_WORKERS = 2
MAX_SOURCE_DETAILS = 8
TOTAL_BUDGET = 22
DETAIL_BUDGET = 6


class HongguoWebSearch:
    def __init__(self, session=None, resolve=None, total_budget=TOTAL_BUDGET,
                 detail_budget=DETAIL_BUDGET):
        self.session = session or requests.Session()
        self.resolve = resolve
        self.total_budget = max(.01, min(float(total_budget), 25))
        self.detail_budget = max(.01, min(float(detail_budget), self.total_budget))
        # Long-lived bounded pools cap work across simultaneous search requests.
        # Timed-out queued futures are cancelled; running HTTP calls retain their
        # own short timeout and can never create an unbounded thread backlog.
        self.detail_pool = ThreadPoolExecutor(max_workers=DETAIL_WORKERS,
                                              thread_name_prefix="search-detail")
        self.source_pool = ThreadPoolExecutor(max_workers=SOURCE_WORKERS,
                                              thread_name_prefix="search-source")

    def search(self, query, count=MAX_RESULTS):
        deadline = time.monotonic() + self.total_budget
        response = self.session.get(
            SUGGEST_URL,
            params={"app_id": "8662", "query": query, "count": str(min(max(count, 1), MAX_RESULTS))},
            headers={
                "Accept": "application/json",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": "https://hongguoduanju.com/",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
            },
            timeout=(3, min(8, self.total_budget)),
        )
        response.raise_for_status()
        if len(response.content) > MAX_BODY:
            raise ValueError("Oversized fallback search response")
        payload = response.json()
        items = payload.get("suggest_list") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise ValueError("Invalid fallback search response")
        results, positions = [], {}
        for item in items:
            row = self._row(item)
            if not row:
                continue
            position = positions.get(row["series_id"])
            if position is None:
                positions[row["series_id"]] = len(results)
                results.append(row)
            elif row["cover"] and not results[position]["cover"]:
                results[position] = row
        return self._enrich(results, deadline)

    def _enrich(self, results, deadline):
        missing = [(index, row) for index, row in enumerate(results) if not row["cover"]]
        if not missing:
            return results
        detail_deadline = min(deadline, time.monotonic() + self.detail_budget)
        self._run_stage(self.detail_pool, missing, self._detail,
                        results, detail_deadline)
        if self.resolve:
            missing = [(index, row) for index, row in enumerate(results)
                       if not row["cover"]][:MAX_SOURCE_DETAILS]
            self._run_stage(self.source_pool, missing, self._source_detail,
                            results, deadline)
        # Suggestion data also contains category/album tokens whose numeric
        # keyword looks like a series id. If neither detail source can resolve
        # a real cover, the token is not a usable series card and must not leak
        # into search results as a blank, unplayable poster.
        return [row for row in results if row["cover"]]

    @staticmethod
    def _run_stage(pool, missing, loader, results, deadline):
        if not missing or deadline <= time.monotonic():
            return
        pending = {pool.submit(loader, row["series_id"]): index
                   for index, row in missing}
        completed, unfinished = wait(pending, timeout=max(0, deadline - time.monotonic()))
        for future in unfinished:
            future.cancel()
        for future in completed:
            try:
                detail = future.result()
            except Exception:
                continue
            index = pending[future]
            if detail and detail["series_id"] == results[index]["series_id"]:
                results[index] = {**results[index], **{
                    key: value for key, value in detail.items() if value}}

    def _source_detail(self, series_id):
        meta = self.resolve(series_id)
        if not isinstance(meta, dict) or str(meta.get("series_id") or series_id) != series_id:
            raise ValueError("Mismatched source detail data")
        category = meta.get("category")
        if isinstance(category, list):
            category = " · ".join(str(value).strip() for value in category if str(value).strip())
        return {"series_id": series_id, "title": str(meta.get("title") or ""),
                "cover": str(meta.get("cover") or ""), "category": str(category or ""),
                "play_cnt": meta.get("play_cnt") or "", "score": str(meta.get("score") or ""),
                "episode_cnt": meta.get("episode_cnt") or 0}

    def _detail(self, series_id):
        response = self.session.get(
            "https://hongguoduanju.com/detail",
            params={"series_id": series_id},
            headers={"Accept": "text/html", "Referer": "https://hongguoduanju.com/",
                     "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"},
            timeout=(2, 4),
        )
        response.raise_for_status()
        if len(response.content) > MAX_DETAIL_BODY:
            raise ValueError("Oversized fallback detail response")
        text = response.content.decode("utf-8", "replace")
        match = re.search(r"(?:window\.)?_ROUTER_DATA\s*=\s*", text)
        if not match:
            raise ValueError("Missing fallback detail data")
        data, _ = json.JSONDecoder().raw_decode(text[match.end():])
        loaders = data.get("loaderData") if isinstance(data, dict) else None
        page = loaders.get("detail_page") if isinstance(loaders, dict) else None
        video = page.get("seriesDetail") if isinstance(page, dict) else None
        row = self._row({"keyword": series_id, "video_data": video})
        if not row or row["series_id"] != series_id:
            raise ValueError("Mismatched fallback detail data")
        return row

    @staticmethod
    def _row(item):
        if not isinstance(item, dict):
            return None
        video = item.get("video_data")
        video = video if isinstance(video, dict) else {}
        series_id = str(video.get("series_id") or video.get("series_id_str") or item.get("keyword") or "")
        if not re.fullmatch(r"\d{1,24}", series_id):
            return None
        title = str(video.get("series_title") or video.get("series_name") or item.get("name") or "").strip()
        if not title:
            return None
        categories = video.get("category_list") or video.get("tags")
        category = " · ".join(str(value.get("name") if isinstance(value, dict) else value).strip()
                              for value in categories
                              if (isinstance(value, dict) and value.get("name")) or isinstance(value, str)) if isinstance(categories, list) else ""
        heat = video.get("hot_score_data")
        heat = heat if isinstance(heat, dict) else {}
        return {
            "series_id": series_id,
            "title": title,
            "cover": str(video.get("series_cover") or ""),
            "category": category,
            "hot": str(heat.get("text") or ""),
            "play_cnt": heat.get("score") or "",
            "score": str(video.get("score") or ""),
            "episode_cnt": video.get("episode_cnt") or 0,
        }
