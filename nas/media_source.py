"""Bounded, memory-only reuse of the existing upstream's best video tracks."""
from collections import OrderedDict
import threading
import time


class PermanentSourceError(RuntimeError):
    """The source cannot be used; repeating the same download cannot repair it."""


class _Flight:
    def __init__(self):
        self.done = threading.Event()
        self.invalidated = False
        self.track = None
        self.error = None
        self.missing_from_batch = False


class MediaSource:
    def __init__(self, provider, call=None, ttl=120, capacity=128):
        self.provider = provider
        self.call = call or (lambda fn: fn())
        self.ttl = ttl
        self.capacity = max(1, int(capacity))
        self.guard = threading.Lock()
        self.cache = OrderedDict()
        self.flights = {}
        self.force = set()
        self.force_uncached = False

    @staticmethod
    def _best(options):
        if not options:
            raise PermanentSourceError("暂时没有可播放的视频轨道")
        by_quality = {}
        for selected in options:
            meta = selected.get("video_meta") or {}
            definition = str(meta.get("definition") or "")
            try:
                quality = int(definition.removesuffix("p"))
            except ValueError:
                continue
            encrypt = selected.get("encrypt_info") or {}
            if not selected.get("main_url") or (encrypt.get("encrypt") and not encrypt.get("spade_a")):
                continue
            urls = list(dict.fromkeys(selected.get("coding_urls") or [selected["main_url"]]))
            candidate = {"url": selected["main_url"], "urls": urls,
                         "encrypt": bool(encrypt.get("encrypt")),
                         "spade_a": encrypt.get("spade_a"), "size": meta.get("size", 0),
                         "definition": definition}
            previous = by_quality.get(quality)
            if previous is None or int(candidate["size"] or 0) > int(previous["size"] or 0):
                by_quality[quality] = candidate
        if not by_quality:
            raise PermanentSourceError("视频轨道缺少可用的下载或解密信息")
        ordered = [by_quality[quality] for quality in sorted(by_quality, reverse=True)]
        return {**ordered[0], "fallbacks": ordered[1:]}

    @staticmethod
    def _limited(track, max_quality):
        if max_quality is None:
            return track
        candidates = [track, *track.get("fallbacks", [])]
        allowed = [candidate for candidate in candidates
                   if int(str(candidate.get("definition", "0p")).removesuffix("p") or 0) <= int(max_quality)]
        if not allowed:
            raise PermanentSourceError(f"没有不高于 {max_quality}p 的可播放视频轨道")
        return {**allowed[0], "fallbacks": [dict(candidate) for candidate in allowed[1:]]}

    def _fresh(self, vid):
        item = self.cache.get(vid)
        if item and item[0] > time.monotonic():
            self.cache.move_to_end(vid)
            return dict(item[1])
        self.cache.pop(vid, None)
        return None

    def invalidate(self, vid):
        vid = str(vid)
        with self.guard:
            self.cache.pop(vid, None)
            if vid in self.flights:
                self.flights[vid].invalidated = True
            self.force.add(vid)
            # Failure markers contain no URL/key, and are bounded too.
            if len(self.force) > self.capacity:
                self.force.clear()
                # Do not forget failed URLs when bounded markers overflow.
                # Subsequent uncached requests conservatively fetch fresh.
                self.force_uncached = True

    def _request(self, vids, force):
        return self.call(lambda: self.provider.get_video_tracks(vids, force=force)) or {}

    def _fetch(self, vids):
        claimed, waiting = {}, {}
        with self.guard:
            for vid in vids:
                if self._fresh(vid) is not None:
                    continue
                if vid in self.flights:
                    waiting[vid] = self.flights[vid]
                else:
                    flight = _Flight()
                    self.flights[vid] = flight
                    claimed[vid] = (flight, self.force_uncached or vid in self.force)
        # Separate forced failures from normal prefetch: only failed IDs bypass
        # the upstream's existing cache, and every request stays <= 5 IDs.
        for forced in (False, True):
            group = [v for v, (_, f) in claimed.items() if f == forced]
            for offset in range(0, len(group), 5):
                batch = group[offset:offset + 5]
                try:
                    tracks = self._request(batch, forced)
                    batch_error = None
                except Exception as exc:
                    tracks, batch_error = {}, exc
                for vid in batch:
                    flight = claimed[vid][0]
                    try:
                        if batch_error:
                            raise batch_error
                        options = tracks.get(vid)
                        if not options and len(batch) > 1:
                            # Resolve a missing member individually only when
                            # playback needs it. Future misses cannot delay the
                            # current episode with extra source requests.
                            flight.missing_from_batch = True
                        else:
                            flight.track = self._best(options)
                    except Exception as exc:
                        flight.error = exc
                    with self.guard:
                        if not flight.invalidated and flight.track is not None:
                            self.cache[vid] = (time.monotonic() + self.ttl, flight.track)
                            self.cache.move_to_end(vid)
                            while len(self.cache) > self.capacity:
                                self.cache.popitem(last=False)
                            self.force.discard(vid)
                        self.flights.pop(vid, None)
                        flight.done.set()
        waiting.update({v: f for v, (f, _) in claimed.items()})
        return waiting

    def track(self, vid, max_quality=None):
        vid = str(vid)
        while True:
            with self.guard:
                cached = self._fresh(vid)
                if cached is not None:
                    return self._limited(cached, max_quality)
            flights = self._fetch([vid])
            flight = flights.get(vid)
            if flight is None:
                continue
            if not flight.done.wait(25):
                raise RuntimeError("等待视频轨道超时，请稍后重试")
            if flight.invalidated:
                continue
            if flight.missing_from_batch:
                continue
            if flight.error:
                raise flight.error
            return self._limited(dict(flight.track), max_quality)

    def prefetch(self, vids):
        # Best effort: current playback falls back to track() independently.
        selected = list(dict.fromkeys(str(v) for v in vids))[:5]
        flights = self._fetch(selected)
        if selected:
            current = flights.get(selected[0])
            if current and current.error:
                raise current.error
