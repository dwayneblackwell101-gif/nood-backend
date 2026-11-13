const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = ['routes', 'services', 'utils', 'jobs', 'tests'];
const files = ['server.js'];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}

for (const root of roots) collect(path.join(process.cwd(), root));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
