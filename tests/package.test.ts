import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("package declares the keepgoing Pi distribution identity and the approved MIT license", () => {
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.name, "pi-keepgoing");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author, "Julian Bruno");
  assert.equal(manifest.repository.url, "git+https://github.com/julianbruno/keepgoing.git");
  assert.equal(manifest.homepage, "https://github.com/julianbruno/keepgoing#readme");
  assert.equal(manifest.bugs.url, "https://github.com/julianbruno/keepgoing/issues");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.ok(manifest.keywords.includes("keepgoing"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.deepEqual(manifest.pi.extensions, ["./extensions/keepgoing.ts"]);
  assert.ok(manifest.files.includes("extensions/keepgoing.ts"));
  assert.ok(manifest.files.includes("WHY-KEEPGOING.md"));
  assert.match(readFileSync(join(root, "LICENSE"), "utf8"), /MIT License\n\nCopyright \(c\) 2026 Julian Bruno/);
});

test("manifest and checkout installers target the same keepgoing extension", () => {
  const entry = "extensions/keepgoing.ts";
  assert.deepEqual(manifest.files.filter((path: string) => path.startsWith("extensions/")), [entry]);
  for (const path of ["install.sh", "install.ps1"]) {
    const installer = readFileSync(join(root, path), "utf8").replaceAll("\\", "/");
    assert.deepEqual(new Set(installer.match(/extensions\/[\w.-]+\.ts/g)), new Set([entry]), path);
    assert.deepEqual(new Set(installer.match(/\/[\w-]+:[\w-]+/g)), new Set(["/jb:keepgoing"]), path);
  }
});

// No PowerShell runner here, so pin the Windows installer's user-facing text statically.
test("PowerShell installer names keepgoing and the single /jb:keepgoing command", () => {
  const ps = readFileSync(join(root, "install.ps1"), "utf8");
  assert.match(ps, /^# Install or remove keepgoing as a personal Pi package \(Windows\)\.$/m);
  assert.ok(ps.includes('Info "keepgoing $PackageVersion"'));
  assert.ok(ps.includes("Join-Path $Root 'extensions\\keepgoing.ts'"));
  assert.ok(ps.includes("throw 'run this script from inside the keepgoing checkout'"));
  assert.ok(ps.includes("Info 'done. Restart Pi (or run /reload) and check /jb:keepgoing and /jb:keepgoing inhibit.'"));
  for (const line of ['Info "keepgoing is installed from $Root"', 'Info "keepgoing is not installed from $Root"', 'Info "keepgoing already installed from $Root"',
    'Info "installing keepgoing $PackageVersion from $Root"', 'Info "removing keepgoing $PackageVersion ($Root)"', 'Info "keepgoing is not installed from $Root; nothing to do"']) {
    assert.ok(ps.includes(line), `missing: ${line}`);
  }
});

test("npm dry-run includes runtime import closure and linked docs, but excludes development history", t => {
  const cache = mkdtempSync(join(tmpdir(), "keepgoing-pack-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], {
    cwd: root, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const [pack] = JSON.parse(result.stdout);
  const paths = new Set<string>(pack.files.map((file: { path: string }) => file.path));
  for (const path of ["LICENSE", "README.md", "WHY-KEEPGOING.md", "CHANGELOG.md", "package.json", "install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1", "extensions/keepgoing.ts", "src/inhibitor.ts", "src/recovery.ts",
    "docs/commands.md", "docs/install.md", "docs/architecture.md", "docs/implementation.md", "docs/manual-test-todo.md"]) {
    assert.ok(paths.has(path), `missing packaged file: ${path}`);
  }
  // Launch drafts are announcement copy for maintainers, not package documentation.
  assert.ok(!paths.has("docs/discord-launch-es.md"), "launch draft packaged: docs/discord-launch-es.md");
  for (const path of paths) {
    assert.ok(!/^(tests|odd|\.atl|\.codegraph|node_modules)\//.test(path), `development artifact packaged: ${path}`);
    if (!path.endsWith(".md") && !path.endsWith(".ts")) continue;
    const content = readFileSync(join(root, path), "utf8");
    const references = path.endsWith(".ts") ? [...content.matchAll(/from\s+["'](\.[^"']+)["']/g)]
      : [...content.matchAll(/\]\(([^)]+)\)/g)];
    for (const [, reference] of references) {
      if (/^(https?:|#)/.test(reference)) continue;
      const target = fileURLToPath(new URL(reference.split("#")[0], new URL(path, `file://${root}`))).slice(root.length);
      assert.ok(paths.has(target), `${path} references unpackaged ${target}`);
    }
  }
  assert.equal(existsSync(join(root, pack.filename)), false, "dry-run must not create an archive");
});
