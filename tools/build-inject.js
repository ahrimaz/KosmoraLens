// Builds a single injectable test bundle (hook + CSS + content/pulsar/cardpage) for
// testing Lens in a logged-in tab without installing the extension.
// Usage (from the repo root): node tools/build-inject.js <outDir>
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const out = path.resolve(process.argv[2] || '.');
const tmp = path.join(out, 'b');
execSync(`npx --yes esbuild src/content.js src/pulsar.js src/cardpage.js src/fusionpage.js --minify --outdir="${tmp}" --log-level=warning`, { stdio: 'inherit' });
const css = fs.readFileSync('src/lens.css', 'utf8');
const style = `;(()=>{const st=document.createElement("style");st.textContent=${JSON.stringify(css)};document.head.appendChild(st)})();`;
const bundle = [fs.readFileSync('src/hook.js', 'utf8'), style, ...['content', 'pulsar', 'cardpage', 'fusionpage'].map((f) => fs.readFileSync(path.join(tmp, `${f}.js`), 'utf8'))].join('\n');
fs.writeFileSync(path.join(out, 'inject.js'), bundle);
console.log(`${path.join(out, 'inject.js')} (${bundle.length} bytes)`);
