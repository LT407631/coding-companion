"""Small, persistent cover variants; never upscale the source image."""
import io
from PIL import Image, ImageOps


def encode_cover(data, width=0):
    with Image.open(io.BytesIO(data)) as source:
        # JPEG draft decoding avoids expanding the full original where supported.
        if width:
            source.draft('RGB', (width, width * 2))
        image = ImageOps.exif_transpose(source)
        if width:
            image.thumbnail((width, width * 2), Image.Resampling.LANCZOS)
        image = image.convert('RGB')
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=82 if width else 88, optimize=True)
        return output.getvalue()
