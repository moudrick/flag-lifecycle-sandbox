import fs from 'node:fs';
let s = fs.readFileSync('lib.mjs', 'utf8');
const a = "      `  image: clean-room-demo/${anchor}:local`,";
const b = "      // A pinned release names its own image tag, so a cluster's running image states its release.\n      `  image: clean-room-demo/${tree.service}:${tree.release || 'local'}`,";
if (!s.includes(a)) throw new Error('anchor missing');
fs.writeFileSync('lib.mjs', s.replace(a, b));
console.log('patched');
