// Bundle the dockable-demo renderer React app into a single browser IIFE.
// React + react-dom + the consumed dist (layout / dock-react / client) are all
// inlined so index.html can load one <script src="./app.bundle.js">.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

await build({
	entryPoints: [join(HERE, 'app.src.jsx')],
	outfile: join(HERE, 'app.bundle.js'),
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'chrome120',
	jsx: 'automatic',
	loader: { '.js': 'jsx' },
	define: { 'process.env.NODE_ENV': '"production"' },
	logLevel: 'info',
	// External source map (app.bundle.js.map): lets CPU-profile analysis resolve
	// a single-file IIFE's callFrames back to their original module (dist/*,
	// react-dom, react-resizable-panels, app.src.jsx) — the bundle itself has no
	// per-module boundaries once inlined, so url-substring matching alone can't
	// tell them apart. No runtime effect: the app doesn't load the map itself.
	sourcemap: true,
})

console.log('[bundle] wrote app.bundle.js')
