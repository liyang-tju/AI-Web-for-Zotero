const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'addon/manifest.json'), 'utf8'));

function validate(candidate) {
  const source = `
import json
import sys
from pathlib import Path
import build

def main() -> None:
    try:
        build.validate_manifest(json.load(sys.stdin), Path('addon'))
        print(json.dumps({'valid': True}))
    except ValueError as error:
        print(json.dumps({'valid': False, 'error': str(error)}))

if __name__ == '__main__':
    main()
`;
  return JSON.parse(execFileSync('python3', ['-c', source], { cwd: root, input: JSON.stringify(candidate), encoding: 'utf8' }));
}

test('release manifest meets Zotero-specific installation requirements', () => {
  assert.equal(validate(manifest).valid, true);
  assert.equal(manifest.applications.zotero.id, 'chatgpt-web-sidebar-demo@local');
  assert.equal(manifest.applications.zotero.strict_min_version, '7.0');
  assert.equal(manifest.applications.zotero.strict_max_version, '10.*');
  assert.equal(manifest.applications.zotero.update_url,
    'https://raw.githubusercontent.com/liyang-tju/AI-Web-for-Zotero/main/updates.json');
});

test('build rejects a missing or invalid Zotero update URL', () => {
  const candidate = structuredClone(manifest);
  delete candidate.applications.zotero.update_url;
  const result = validate(candidate);
  assert.equal(result.valid, false);
  assert.match(result.error, /applications\.zotero\.update_url is required by Zotero/);
  candidate.applications.zotero.update_url = 'https://updates.invalid/updates.json';
  assert.equal(validate(candidate).valid, false);
});

test('release packaging is reproducible and update metadata matches the exact artifact', () => {
  const source = `
from pathlib import Path
from tempfile import TemporaryDirectory
from hashlib import sha256
import json
import os
import zipfile
import build

def main() -> None:
    with TemporaryDirectory() as folder:
        directory = Path(folder)
        addon = directory / 'addon'
        addon.mkdir()
        source = addon / 'bootstrap.js'
        source.write_text('function startup() {}')
        (addon / '.DS_Store').write_bytes(b'ignored')
        (addon / 'README.md').write_text('Development documentation')
        (addon / 'local-link.js').symlink_to(source)
        license_path = directory / 'LICENSE'
        license_path.write_text('Test license')
        first = directory / 'ai-web-for-zotero-test.xpi'
        second = directory / 'second.xpi'
        build.package_addon(addon, first, license_path)
        os.utime(source, (1_600_000_000, 1_600_000_000))
        build.package_addon(addon, second, license_path)
        assert first.read_bytes() == second.read_bytes()
        with zipfile.ZipFile(first) as package:
            assert package.namelist() == ['LICENSE', 'bootstrap.js']
            assert package.read('LICENSE') == b'Test license'
        manifest = json.loads(Path('addon/manifest.json').read_text())
        update = build.update_manifest(manifest, first)['addons'][manifest['applications']['zotero']['id']]['updates'][0]
        assert update['update_hash'] == 'sha256:' + sha256(first.read_bytes()).hexdigest()
        assert update['version'] == manifest['version']
        assert update['applications']['zotero']['strict_max_version'] == manifest['applications']['zotero']['strict_max_version']
        assert update['update_link'].endswith('/v' + manifest['version'] + '/' + first.name)

if __name__ == '__main__':
    main()
`;
  execFileSync('python3', ['-c', source], { cwd: root, encoding: 'utf8' });
});

test('candidate builds include the license and never replace the published update feed', () => {
  const source = `
from pathlib import Path
from tempfile import TemporaryDirectory
from hashlib import sha256
import json
import shutil
import zipfile
import build

def main() -> None:
    with TemporaryDirectory() as folder:
        project = Path(folder)
        shutil.copytree('addon', project / 'addon')
        shutil.copy('LICENSE', project / 'LICENSE')
        published = project / 'updates.json'
        published.write_text('existing published version')
        build.project_directory = project
        build.main()
        assert published.read_text() == 'existing published version'
        manifest = json.loads((project / 'addon/manifest.json').read_text())
        package_path = project / 'dist' / f"ai-web-for-zotero-{manifest['version']}.xpi"
        with zipfile.ZipFile(package_path) as package:
            assert package.read('LICENSE') == (project / 'LICENSE').read_bytes()
            assert 'THIRD_PARTY_NOTICES.txt' in package.namelist()
            assert not any(name.endswith('.md') for name in package.namelist())
        candidate = json.loads((project / 'dist/updates.json').read_text())
        update = candidate['addons'][manifest['applications']['zotero']['id']]['updates'][0]
        assert update['version'] == manifest['version']
        assert update['update_hash'] == 'sha256:' + sha256(package_path.read_bytes()).hexdigest()

if __name__ == '__main__':
    main()
`;
  execFileSync('python3', ['-c', source], { cwd: root, encoding: 'utf8' });
});
