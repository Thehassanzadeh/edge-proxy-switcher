import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Static release checks. Does not substitute for live Edge/proxy testing. */
export function validateRelease(directory) {
  const root = resolve(directory);
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  walk(root);
  const present = new Set(files);
  const reached = new Set();
  function reference(from, target) {
    assert(!/^(?:[a-z]+:|\/\/)/i.test(target), `External dependency: ${target}`);
    const path = target.startsWith('/') ? resolve(root, target.slice(1)) : resolve(root, dirname(from), target);
    const rel = relative(root, path).replaceAll('\\', '/');
    assert(!rel.startsWith('..') && present.has(rel), `Missing/unsafe reference ${from} -> ${target}`);
    visit(rel);
  }
  function visit(file) {
    if (reached.has(file)) return;
    reached.add(file);
    if (!/\.(?:js|html|css)$/.test(file)) return;
    const text = readFileSync(resolve(root, file), 'utf8');
    assert(!/sourceMappingURL|\bdebugger\b|\bTODO\b|@vite\/client|react-refresh/.test(text), `Development code: ${file}`);
    assert(!/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?=[:/"'`\s]|$)/i.test(text), `Development URL: ${file}`);
    assert(!/console\.(?:log|debug|info)\s*\(/.test(text), `Debug logging: ${file}`);
    assert(!/AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `Secret-like literal: ${file}`);
    if (file.endsWith('.js')) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      assert.equal(source.parseDiagnostics.length, 0, `Invalid JavaScript: ${file}`);
      function inspect(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          reference(file, node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node)) {
          assert(!['eval', 'Function'].includes(node.expression.getText(source)), `Dynamic code: ${file}`);
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            assert(ts.isStringLiteralLike(node.arguments[0]), `Non-static import: ${file}`);
            reference(file, node.arguments[0].text);
          }
        }
        if (ts.isNewExpression(node)) assert.notEqual(node.expression.getText(source), 'Function', `Dynamic code: ${file}`);
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    } else if (file.endsWith('.html')) {
      for (const match of text.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi)) reference(file, match[1]);
      for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert(/\bsrc=/.test(match[1]) && !match[2].trim(), `Inline script: ${file}`);
      }
    } else {
      for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
        if (!match[1].startsWith('data:')) reference(file, match[1]);
      }
      assert(!/@import\b/i.test(text), `Unexpected CSS import: ${file}`);
    }
  }
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual([...manifest.permissions].sort(), ['proxy', 'storage', 'webRequest', 'webRequestAuthProvider'].sort());
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert(!manifest.content_scripts && !manifest.externally_connectable && !manifest.update_url);
  assert(!manifest.content_security_policy || !/unsafe-eval|https?:/.test(JSON.stringify(manifest.content_security_policy)));
  const messagesPath = `_locales/${manifest.default_locale}/messages.json`;
  const messages = JSON.parse(readFileSync(resolve(root, messagesPath), 'utf8'));
  const localized = value => value.replace(/__MSG_(.+?)__/g, (_, key) => {
    assert(messages[key]?.message, `Missing localization: ${key}`);
    return messages[key].message;
  });
  const name = localized(manifest.name);
  const description = localized(manifest.description);
  assert(name.length > 0 && name.length <= 75);
  assert(description.length > 0 && description.length <= 132);
  localized(manifest.action.default_title);
  visit('manifest.json'); visit(messagesPath);
  reference('manifest.json', manifest.action.default_popup);
  reference('manifest.json', manifest.options_page);
  reference('manifest.json', manifest.background.service_worker);
  reference('manifest.json', 'welcome.html'); // onInstalled opens this page
  for (const size of [16, 32, 48, 128]) {
    const file = manifest.icons[String(size)];
    assert(file, `Missing ${size}px icon`);
    reference('manifest.json', file);
    const png = readFileSync(resolve(root, file));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  for (const file of files) {
    assert(reached.has(file), `Unreferenced file must not ship: ${file}`);
    assert(!/(?:^|\/)(?:node_modules|src|\.git|tests?|screenshots)(?:\/|$)|\.(?:map|tsx?|md|zip)$/.test(file), `Development artifact: ${file}`);
  }
  console.log(`Release validation passed: ${name} ${manifest.version}, ${files.length} runtime files, ${description.length}-character description.`);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateRelease(process.argv[2] ?? 'dist');
}
