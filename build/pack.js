/**
 * Pack script
 * Package build output into .zip component package
 */

import AdmZip from 'adm-zip';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * Check if test environment
 */
const isTest = process.env.NODE_ENV === 'development';

/**
 * Recursively copy directory
 */
function addDirectoryToZip(zip, dirPath, zipPath, excludedFiles = []) {
  const items = readdirSync(dirPath);

  items.forEach((item) => {
    const itemPath = join(dirPath, item);
    const itemZipPath = join(zipPath, item);
    const stat = statSync(itemPath);

    if (stat.isDirectory()) {
      addDirectoryToZip(zip, itemPath, itemZipPath, excludedFiles);
    } else {
      // Exclude .map files
      if (item.endsWith('.map')) {
        excludedFiles.push(itemZipPath.replace(/\\/g, '/'));
        return;
      }
      const content = readFileSync(itemPath);
      zip.addFile(itemZipPath.replace(/\\/g, '/'), content);
    }
  });
}

/**
 * Pack function
 */
function pack() {
  console.log('\n📦 Packing...\n');

  const { microAppId, version } = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf-8'));
  const zipFileName = `${microAppId}-${version}.zip`;
  const zipPath = join(projectRoot, 'packages', zipFileName);

  const zip = new AdmZip();
  const excludedFiles = [];

  // Add app.json
  const appJsonContent = readFileSync(join(projectRoot, 'app.json'));
  zip.addFile('app.json', appJsonContent);

  // Add all files from dist directory (including main.js and assets)
  const distDir = join(projectRoot, 'dist');
  if (existsSync(distDir)) {
    addDirectoryToZip(zip, distDir, '', excludedFiles);
  }

  // Add all files from public directory to root
  const publicDir = join(projectRoot, 'public');
  if (existsSync(publicDir)) {
    const publicItems = readdirSync(publicDir);
    publicItems.forEach((item) => {
      const itemPath = join(publicDir, item);
      const stat = statSync(itemPath);

      if (stat.isFile()) {
        // Exclude .map files
        if (item.endsWith('.map')) {
          excludedFiles.push(item);
          return;
        }
        const content = readFileSync(itemPath);
        zip.addFile(item, content);
      } else if (stat.isDirectory()) {
        addDirectoryToZip(zip, itemPath, item, excludedFiles);
      }
    });
  }

  // Write zip file
  zip.writeZip(zipPath);

  console.log(`✅ Package created: ${zipPath}`);
  console.log(`📦 Package: ${zipFileName}`);
  console.log(`🔧 Environment: ${isTest ? 'test' : 'production'}`);

  // Show excluded files
  if (excludedFiles.length > 0) {
    console.log(`\n🗑️  Excluded ${excludedFiles.length} .map files:`);
    excludedFiles.forEach((file) => console.log(`   - ${file}`));
  }
  console.log();
}

// Execute pack
pack();
