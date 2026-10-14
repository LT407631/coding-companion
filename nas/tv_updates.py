"""Private TV release feed; authentication is enforced by the site middleware."""
import hashlib
import json
import re
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, JSONResponse

PACKAGE = 'net.codingcompanion.tv'
MAX_BYTES = 128 * 1024 * 1024


class TvReleases:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()

    def latest(self):
        manifest = self.directory / 'latest.json'
        if not manifest.exists():
            return {'available': False}
        try:
            if manifest.is_symlink() or manifest.stat().st_size > 16384:
                raise ValueError()
            data = json.loads(manifest.read_text())
            digest = data['sha256']
            if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
                raise ValueError()
            for key in ('version_code', 'size', 'min_sdk'):
                if type(data[key]) is not int or data[key] <= 0:
                    raise ValueError()
            if data['package'] != PACKAGE or data['size'] > MAX_BYTES:
                raise ValueError()
            if not isinstance(data['version_name'], str) or len(data['version_name']) > 64:
                raise ValueError()
            if not isinstance(data.get('notes', ''), str) or len(data.get('notes', '')) > 2000:
                raise ValueError()
            apk = self.directory / (digest + '.apk')
            if apk.is_symlink() or not apk.is_file() or apk.stat().st_size != data['size']:
                raise ValueError()
            calculated = hashlib.sha256()
            with apk.open('rb') as stream:
                for chunk in iter(lambda: stream.read(65536), b''):
                    calculated.update(chunk)
            if calculated.hexdigest() != digest:
                raise ValueError()
            return {key: data[key] for key in ('package', 'version_code', 'version_name', 'size', 'min_sdk', 'sha256')} | {
                'available': True, 'notes': data.get('notes', ''),
                'url': '/updates/android-tv/' + digest + '.apk',
            }
        except (OSError, ValueError, TypeError, KeyError):
            raise HTTPException(503, '电视更新文件不完整，请管理员重新发布')


def install_tv_updates(app, directory):
    releases = TvReleases(directory)

    @app.get('/updates/android-tv/latest', include_in_schema=False)
    def latest():
        return JSONResponse(releases.latest(), headers={'Cache-Control': 'private, no-store'})

    @app.get('/updates/android-tv/{filename}', include_in_schema=False)
    def download(filename: str):
        if not re.fullmatch(r'[0-9a-f]{64}\.apk', filename):
            raise HTTPException(404)
        release = releases.latest()
        if not release['available'] or filename != release['sha256'] + '.apk':
            raise HTTPException(404)
        return FileResponse(releases.directory / filename, media_type='application/vnd.android.package-archive',
                            filename='coding-companion-tv-' + release['version_name'] + '.apk',
                            headers={'Cache-Control': 'private, no-store'})

    return releases
