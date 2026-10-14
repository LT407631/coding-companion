"""Bounded fallback search using Hongguo's public suggestion endpoint."""
import re

import requests


SUGGEST_URL = "https://hongguoduanju.com/incent_resource/suggestion"
MAX_BODY = 256 * 1024


class HongguoWebSearch:
    def __init__(self, session=None):
        self.session = session or requests.Session()

    def search(self, query, count=50):
        response = self.session.get(
            SUGGEST_URL,
            params={"app_id": "8662", "query": query, "count": str(min(max(count, 1), 50))},
            headers={
                "Accept": "application/json",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Referer": "https://hongguoduanju.com/",
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
            },
            timeout=(3, 8),
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
        return results

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
        categories = video.get("category_list")
        category = " · ".join(str(value.get("name")).strip() for value in categories
                              if isinstance(value, dict) and value.get("name")) if isinstance(categories, list) else ""
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
