// Loads shared/portaldot.mjs as a real ESM module from CommonJS scripts.
// Uses pathToFileURL so paths with spaces or special characters (this
// repository lives in "portal house hack") decode correctly.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSharedMapping(root) {
  return import(pathToFileURL(path.join(root, 'shared', 'portaldot.mjs')).href);
}

module.exports = { loadSharedMapping };
