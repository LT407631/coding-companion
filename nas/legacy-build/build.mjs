import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const nas = resolve(here, '..');
const repo = resolve(nas, '..');
const web = join(nas, 'web');
const out = join(web, 'assets');
const check = process.argv.includes('--check');
const modules = resolve(process.env.LEGACY_NODE_MODULES || join(here, 'node_modules'));
const requireFromModules = createRequire(pathToFileURL(join(modules, 'resolver.cjs')));
const babel = requireFromModules('@babel/core');
const presetEnv = requireFromModules.resolve('@babel/preset-env');
const esbuild = requireFromModules('esbuild');

const jsNames = [
  'profiles.js', 'watch-state.js', 'watch-ui.js', 'library-store.js',
  'library-scroll.js', 'library-grid.js', 'library.js', 'device-media.js',
  'seasons.js', 'settings.js', 'page-requests.js', 'search.js',
  'playback-status.js',
];
const cssNames = ['library.css', 'watch-ui.css'];
const sources = new Map();
function source(path) {
  const data = readFileSync(path, 'utf8');
  sources.set(relative(repo, path), createHash('sha256').update(data).digest('hex'));
  return data;
}
function transpile(code, filename) {
  return babel.transformSync(code, {
    filename,
    sourceType: 'script',
    comments: false,
    compact: false,
    presets: [[presetEnv, {targets: {chrome: '37'}, modules: false, bugfixes: true}]],
  }).code;
}
function darkCss(text) {
  const dark = {
    '--bg':'#111318', '--control':'#272b35', '--intro':'#bdc5d4', '--line':'#323744',
    '--mobile-nav':'62px', '--muted':'#a4aec0', '--nav-txt':'#b3bccd', '--pink':'#ff527b',
    '--pink-border':'#773248', '--pink-soft':'#39202b', '--scroll':'#4e5668',
    '--search-bg':'#272b35', '--seen':'#97a2b7', '--separator':'#566075',
    '--skeleton-end':'#242a36', '--skeleton-start':'#303644', '--surface':'#1b1e26',
    '--track':'#323744', '--txt':'#edf0f5', '--txt-control':'#e1e6ef', '--txt2':'#afb7c8',
  };
  return text.replace(/var\((--[\w-]+)(?:\s*,[^)]*)?\)/g, (_, name) => dark[name] || 'initial');
}
async function minifyEs5(code) {
  return (await esbuild.transform(code, {target: 'es5', minify: true, legalComments: 'none'})).code;
}
function write(path, data) {
  if (check) {
    if (readFileSync(path, 'utf8') !== data) throw new Error('Legacy UI is stale: ' + relative(repo, path));
  } else writeFileSync(path, data);
}

let html = source(join(web, 'app.html'));
const parts = [];
html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs, inline) => {
  const match = attrs.match(/\bsrc=["']([^"']+)["']/i);
  if (match) {
    const name = match[1].split('/').pop().split('?')[0];
    let code = source(join(out, name));
    if (name === 'device-media.js') code = code.replace('/ui/assets/device-worker.js?v=direct-1', '/ui/assets/legacy-worker.js?v=1');
    if (name === 'library-grid.js') code = code.replace(
      "var style = getComputedStyle(grid), next = style.gridTemplateColumns.split(' ').length;\n      columns = Math.max(1, next); gap = parseFloat(style.rowGap) || 0;",
      "var style = getComputedStyle(grid), template = style.gridTemplateColumns || '', next = template ? template.split(' ').length : (window.innerWidth <= 1600 ? 6 : 8);\n      columns = Math.max(1, next); gap = parseFloat(style.rowGap) || (template ? 0 : 26);"
    );
    parts.push(transpile(code, name));
  } else if (inline.trim()) parts.push(transpile(inline, 'app-inline.js'));
  return whole;
});

const legacyApp = await minifyEs5(parts.join('\n;\n'));
let worker = source(join(out, 'device-crypto.js')) + '\n' + source(join(out, 'device-worker.js')).replace(/^['"]use strict['"];?\s*/,'').replace(/importScripts\([^;]+;\s*/, '');
worker = await minifyEs5(transpile(worker, 'legacy-worker.js'));

const polyfillEntry = `
import 'core-js/stable';
import 'whatwg-fetch';
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch';
(function(){
  var ElementProto=window.Element&&Element.prototype;
  if(ElementProto&&!ElementProto.matches)ElementProto.matches=ElementProto.msMatchesSelector||ElementProto.webkitMatchesSelector;
  if(ElementProto&&!ElementProto.closest)ElementProto.closest=function(selector){var node=this;while(node&&node.nodeType===1){if(node.matches(selector))return node;node=node.parentElement;}return null;};
  if(ElementProto&&!ElementProto.remove)ElementProto.remove=function(){if(this.parentNode)this.parentNode.removeChild(this);};
  if(window.Node&&!('isConnected' in Node.prototype))Object.defineProperty(Node.prototype,'isConnected',{get:function(){return document.documentElement.contains(this);}});
  var nativeScrollTo=window.scrollTo;window.scrollTo=function(x,y){if(x&&typeof x==='object')return nativeScrollTo.call(window,Number(x.left)||0,Number(x.top)||0);return nativeScrollTo.call(window,x,y);};
})();`;
const polyfills = (await esbuild.build({
  stdin: {contents: polyfillEntry, resolveDir: dirname(modules), sourcefile: 'legacy-polyfills-entry.js'},
  bundle: true, minify: true, target: ['chrome37'], format: 'iife', write: false,
})).outputFiles[0].text;

const fallbackCss = `
.legacy-webview .theme-buttons{display:none!important}
.legacy-webview .logo,.legacy-webview .playov,.legacy-webview .ep{display:flex;align-items:center;justify-content:center}
.legacy-webview .grid{display:flex;flex-wrap:wrap;margin-left:-9px;margin-right:-9px}
.legacy-webview .grid>.card{width:12.5%;padding-left:9px;padding-right:9px;margin-bottom:26px}
.legacy-webview .eps{display:flex;flex-wrap:wrap;margin-left:-5px;margin-right:-5px}
.legacy-webview .eps>.ep{width:calc(12.5% - 10px);margin:5px;box-sizing:border-box}
.legacy-webview .watch-resumes{display:flex;flex-wrap:wrap}
.legacy-webview .watch-resumes>.watch-resume{width:calc(16.666667% - 12px);margin:6px}
@media(max-width:1600px){.legacy-webview .grid>.card{width:16.666667%}.legacy-webview .eps>.ep{width:calc(16.666667% - 10px)}}
`;
const legacyCss = darkCss(cssNames.map(name => source(join(out, name))).join('\n') + fallbackCss);

html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
html = html.replace(/<link rel="stylesheet" href="\/ui\/assets\/library\.css[^"]*">/i, '<link rel="stylesheet" href="/ui/assets/legacy.css?v=1">');
html = html.replace(/<link rel="stylesheet" href="\/ui\/assets\/watch-ui\.css[^"]*">/i, '');
html = html.replace('<html lang="zh">', '<html lang="zh" class="legacy-webview" data-theme="dark">');
html = darkCss(html).replace('</body>', '<script src="/ui/assets/legacy-polyfills.js?v=1"></script><script src="/ui/assets/legacy-app.js?v=1"></script>\n</body>');

const sourceDigest = createHash('sha256');
for (const [name, digest] of [...sources].sort()) sourceDigest.update(name + '\0' + digest + '\n');
html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<meta name="legacy-source-sha256" content="' + sourceDigest.digest('hex') + '">');
write(join(web, 'app-legacy.html'), html);
write(join(out, 'legacy-polyfills.js'), polyfills);
write(join(out, 'legacy-app.js'), legacyApp);
write(join(out, 'legacy-worker.js'), worker);
write(join(out, 'legacy.css'), legacyCss);
console.log(check ? 'Legacy UI is current.' : 'Legacy UI generated for Chrome/WebView 37.');
