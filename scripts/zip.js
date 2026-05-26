const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const webDir = path.join(__dirname, '../out');
const zipPath = path.join(__dirname, '../app-bundle.zip');

if (!fs.existsSync(webDir)) {
  console.error(`Error: ${webDir} directory does not exist.`);
  process.exit(1);
}

console.log(`Zipping ${webDir} into ${zipPath}...`);
const zip = new AdmZip();

function addLocalFolder(localPath, zipPathPrefix = "") {
  const items = fs.readdirSync(localPath);
  for (const item of items) {
    const fullPath = path.join(localPath, item);
    const stat = fs.statSync(fullPath);
    if (item.endsWith('.map') || item === '.DS_Store') {
      continue;
    }
    const zipEntryPath = zipPathPrefix ? `${zipPathPrefix}/${item}` : item;
    if (stat.isDirectory()) {
      addLocalFolder(fullPath, zipEntryPath);
    } else {
      zip.addLocalFile(fullPath, zipPathPrefix);
    }
  }
}

addLocalFolder(webDir);
zip.writeZip(zipPath);
console.log('Zipping completed successfully!');
