"""Give a Linux tar.gz built on Windows the file permissions Linux needs.

    python scripts/fix-linux-tar.py release/linux

Windows has no executable bit, so electron-builder's tar.gz from Windows marks every file 644 and
`./maris` would not start. This rewrites each *.tar.gz in the folder: folders and programs 755
(maris, chrome-sandbox, chrome_crashpad_handler, shared libraries, shell scripts), everything else 644. Builds
made on Linux already have the right permissions and are left as they are.

Antivirus programs sometimes stop electron-builder's compressor (7za) halfway, which leaves a
damaged archive without an error. Then the archive is built again here from the unpacked app
electron-builder left next to it (linux-unpacked, or linux-arm64-unpacked for ARM).
"""
import re
import sys
import tarfile
import zlib
from pathlib import Path

EXECUTABLE = re.compile(r'(^|/)(maris|chrome-sandbox|chrome_crashpad_handler)$|\.so(\.\d+)*$|\.sh$')


def mode_for(name: str, is_dir: bool) -> int:
    return 0o755 if is_dir or EXECUTABLE.search(name) else 0o644


def fix(path: Path) -> None:
    tmp = path.with_suffix('.tmp')
    changed = 0
    try:
        with tarfile.open(path, 'r:gz') as src, tarfile.open(tmp, 'w:gz', compresslevel=9) as out:
            for m in src.getmembers():
                want = m.mode if m.issym() or m.islnk() else mode_for(m.name, m.isdir())
                if m.mode != want:
                    changed += 1
                m.mode = want
                m.uid = m.gid = 0
                m.uname = m.gname = ''
                out.addfile(m, src.extractfile(m) if m.isfile() else None)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if changed:
        tmp.replace(path)
        print(f'{path}: fixed permissions on {changed} entries')
    else:
        tmp.unlink()
        print(f'{path}: permissions already right')


def from_unpacked(path: Path, unpacked: Path) -> None:
    """Build the archive the way electron-builder lays it out: one folder named like the file."""
    prefix = path.name[: -len('.tar.gz')]
    tmp = path.with_suffix('.tmp')
    count = 0
    try:
        with tarfile.open(tmp, 'w:gz', compresslevel=9) as out:
            for p in [unpacked, *sorted(unpacked.rglob('*'))]:
                rel = p.relative_to(unpacked).as_posix()
                arc = prefix if rel == '.' else f'{prefix}/{rel}'
                info = out.gettarinfo(str(p), arcname=arc)
                info.mode = mode_for(arc, p.is_dir())
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                if p.is_file():
                    with open(p, 'rb') as f:
                        out.addfile(info, f)
                else:
                    out.addfile(info)
                count += 1
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(path)
    print(f'{path}: built from {unpacked} ({count} entries, {path.stat().st_size / 2**20:.1f} MB)')


if __name__ == '__main__':
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else 'release/linux')
    archives = sorted(folder.glob('*.tar.gz'))
    if not archives:
        sys.exit(f'No .tar.gz in {folder}')
    for a in archives:
        try:
            fix(a)
        except (EOFError, tarfile.ReadError, zlib.error) as e:
            unpacked = folder / ('linux-arm64-unpacked' if 'arm64' in a.name else 'linux-unpacked')
            if not (unpacked / 'resources' / 'app.asar').is_file():
                sys.exit(f'{a} is damaged ({e}) and there is no unpacked app in {unpacked} to build it from')
            print(f'{a} is damaged ({e}); building it again from {unpacked}')
            from_unpacked(a, unpacked)
