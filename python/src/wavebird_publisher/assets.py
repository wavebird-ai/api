"""Read the browser host shipped in this exact Python wheel."""

from importlib.resources import files


def browser_module_bytes() -> bytes:
    return files("wavebird_publisher").joinpath("browser.js").read_bytes()
