from pathlib import Path
from hashlib import sha256
from typing import Any, Iterator, Optional
from urllib.parse import urlparse
import json
import zipfile

# Configuration
project_directory = Path(__file__).resolve().parent
repository_url = "https://github.com/liyang-tju/AI-Web-for-Zotero"


def validate_manifest(manifest: dict[str, Any], addon_directory: Path) -> None:
    """Check Zotero-specific requirements before creating an installable XPI."""
    zotero = manifest.get("applications", {}).get("zotero", {})
    # Zotero's ExtensionData.parseManifest requires these even where the generic
    # Gecko manifest schema marks them optional.
    for field in ["id", "update_url", "strict_max_version"]:
        if not isinstance(zotero.get(field), str) or not zotero[field].strip():
            raise ValueError(f"applications.zotero.{field} is required by Zotero")
    update_url = urlparse(zotero["update_url"])
    if update_url.scheme != "https" or not update_url.hostname or update_url.hostname.endswith(".invalid"):
        raise ValueError("update_url must use a valid HTTPS update endpoint")
    for field in ["name", "version", "author"]:
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            raise ValueError(f"manifest.{field} is required")
    for icon in manifest.get("icons", {}).values():
        if not (addon_directory / icon).is_file():
            raise ValueError(f"Missing icon: {icon}")


def addon_files(directory: Path) -> Iterator[Path]:
    """Skip local files and documentation without traversing excluded folders."""
    for path in sorted(directory.iterdir()):
        if path.name == "archive" or path.name.startswith(".") or path.is_symlink():
            continue
        if path.is_dir():
            yield from addon_files(path)
        elif path.is_file() and path.suffix != ".md":
            yield path


def package_addon(addon_directory: Path, package_path: Path, license_path: Optional[Path] = None) -> None:
    """Use stable ZIP metadata so identical sources have identical checksums."""
    sources = [(path.relative_to(addon_directory).as_posix(), path) for path in addon_files(addon_directory)]
    if license_path is not None:
        if not license_path.is_file():
            raise ValueError("The project LICENSE is required for distribution")
        sources.append(("LICENSE", license_path))
    package_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(package_path, "w", zipfile.ZIP_DEFLATED) as package:
        for name, source_path in sorted(sources):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            package.writestr(info, source_path.read_bytes())


def update_manifest(manifest: dict[str, Any], package_path: Path) -> dict[str, Any]:
    """Describe a candidate version, supported Zotero range, and checksum."""
    zotero = manifest["applications"]["zotero"]
    return {"addons": {zotero["id"]: {"updates": [{
        "version": manifest["version"],
        "update_link": f"{repository_url}/releases/download/v{manifest['version']}/{package_path.name}",
        "update_hash": f"sha256:{sha256(package_path.read_bytes()).hexdigest()}",
        "applications": {"zotero": {key: zotero[key] for key in ["strict_min_version", "strict_max_version"] if key in zotero}},
    }]}}}


def main() -> None:
    """Build local release candidates without changing the published feed."""
    addon_directory = project_directory / "addon"
    manifest = json.loads((addon_directory / "manifest.json").read_text())
    validate_manifest(manifest, addon_directory)
    package_path = project_directory / "dist" / f"ai-web-for-zotero-{manifest['version']}.xpi"
    package_addon(addon_directory, package_path, project_directory / "LICENSE")
    (package_path.parent / "updates.json").write_text(json.dumps(update_manifest(manifest, package_path), indent=2) + "\n")
    print(package_path)


if __name__ == "__main__":
    main()
