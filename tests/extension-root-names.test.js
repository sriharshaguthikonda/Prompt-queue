// Chromium refuses to load an unpacked extension whose root has a file or folder
// starting with "_" (reserved; only _locales and _metadata are allowed). This catches
// a stray __pycache__ from the Python tests before an extension reload fails on it.
const fs = require('fs');
const path = require('path');

test('extension root has no reserved "_" names', () => {
  const root = path.join(__dirname, '..');
  const reserved = fs.readdirSync(root)
    .filter((name) => name.startsWith('_') && !['_locales', '_metadata'].includes(name));
  expect(reserved).toEqual([]);
});
