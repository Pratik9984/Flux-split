// scripts/resize-icon.js
// Resize the new icon.png to all Android mipmap density folders
// Uses canvas-based resize with Node.js built-in or sharp if available

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SRC = path.join(__dirname, "..", "public", "icon.png");
const RES = path.join(__dirname, "..", "android", "app", "src", "main", "res");

// Android mipmap sizes: ic_launcher = 48dp * density
// ldpi=36, mdpi=48, hdpi=72, xhdpi=96, xxhdpi=144, xxxhdpi=192
// ic_launcher_foreground = 108dp * density (adaptive icon foreground)
// ldpi=54, mdpi=72, hdpi=108, xhdpi=144, xxhdpi=216, xxxhdpi=288

const DENSITIES = [
  { name: "ldpi",    launcher: 36,  foreground: 54  },
  { name: "mdpi",    launcher: 48,  foreground: 72  },
  { name: "hdpi",    launcher: 72,  foreground: 108 },
  { name: "xhdpi",   launcher: 96,  foreground: 144 },
  { name: "xxhdpi",  launcher: 144, foreground: 216 },
  { name: "xxxhdpi", launcher: 192, foreground: 288 },
];

// Use PowerShell System.Drawing to resize (available on Windows without extra deps)
function resizeWithPowerShell(src, dst, width, height) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.DrawImage($img, 0, 0, ${width}, ${height})
$bmp.Save('${dst.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$img.Dispose()
`.trim().replace(/\n/g, "; ");
  
  execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe" });
}

console.log("▶  Resizing icon for Android mipmap densities...\n");

for (const d of DENSITIES) {
  const mipmapDir = path.join(RES, `mipmap-${d.name}`);
  if (!fs.existsSync(mipmapDir)) {
    console.log(`   Skipping mipmap-${d.name} (directory not found)`);
    continue;
  }

  // ic_launcher.png
  const launcherDst = path.join(mipmapDir, "ic_launcher.png");
  resizeWithPowerShell(SRC, launcherDst, d.launcher, d.launcher);
  console.log(`   mipmap-${d.name}/ic_launcher.png (${d.launcher}x${d.launcher}) ✓`);

  // ic_launcher_round.png (same image, just used for round mask on some launchers)
  const roundDst = path.join(mipmapDir, "ic_launcher_round.png");
  resizeWithPowerShell(SRC, roundDst, d.launcher, d.launcher);
  console.log(`   mipmap-${d.name}/ic_launcher_round.png (${d.launcher}x${d.launcher}) ✓`);

  // ic_launcher_foreground.png (larger for adaptive icon system)
  const fgDst = path.join(mipmapDir, "ic_launcher_foreground.png");
  resizeWithPowerShell(SRC, fgDst, d.foreground, d.foreground);
  console.log(`   mipmap-${d.name}/ic_launcher_foreground.png (${d.foreground}x${d.foreground}) ✓`);
}

console.log("\n✅  All Android icons updated!");
