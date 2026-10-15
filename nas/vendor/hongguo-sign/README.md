# Hongguo request signer

This independent CLI is licensed GPL-3.0-only. Its license applies to this directory; keep COPYING and these notices when distributing it.

Origin: jackotom/hongguo-drama, commit 84b6e88e65374942c123a53c7d6ad9e78bcd101b, src/native/app-source.js (https://github.com/jackotom/hongguo-drama/blob/84b6e88e65374942c123a53c7d6ad9e78bcd101b/src/native/app-source.js). Upstream attributes the signing algorithms to woshishiq1/drpys and N3urda/hongguoTV.

2026-10-15 adaptation: retain only the local signing functions, use Node's SM3 instead of a separate module, and add a bounded stdin/stdout command interface. It generates synthetic per-request identities, makes no network requests and accepts no account credentials. The NAS invokes it as a separate executable, without importing its implementation.

Run: Node 24 with sign.cjs; stdin is JSON with one numeric video_id. Stdout contains the signed request URL, headers and body. Treat stdout as transient playback data and do not log it. Runtime limits and timeouts are enforced by the caller.
