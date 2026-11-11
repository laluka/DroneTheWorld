// Copies Cesium's static runtime (workers, assets, widgets) into public/ so Vite serves them.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/cesium/Build/Cesium';
const dst = 'public/cesium';
if (!existsSync(src)) { console.error('cesium not installed'); process.exit(1); }
mkdirSync(dst, { recursive: true });
for (const d of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) cpSync(`${src}/${d}`, `${dst}/${d}`, { recursive: true });
console.log('cesium assets copied to', dst);
