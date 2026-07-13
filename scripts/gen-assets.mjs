// Regenerate all background assets:
//   • 50 distinct-colour studio plates  → assets/backgrounds/
//   • 100 procedural scene backdrops     → assets/backgrounds-scenes/
// Run with:  npm run gen:assets
import { ensureBackgrounds } from '../src/images/backgrounds.js';
import { ensureScenes } from '../src/images/scenes.js';

const t0 = Date.now();
console.log('Generating 50 distinct studio plates…');
const bg = await ensureBackgrounds();   // throws if palette isn't distinct enough
console.log(`✓ ${Object.keys(bg).length} plates.`);

console.log('Generating 100 procedural scene backdrops…');
const { total } = await ensureScenes((m) => console.log(m));
console.log(`✓ ${total} scenes → assets/backgrounds-scenes/`);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
