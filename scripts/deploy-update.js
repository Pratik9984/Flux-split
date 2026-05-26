// scripts/deploy-update.js
// Usage: node scripts/deploy-update.js <version>
// Env:   ADMIN_TOKEN  — your backend JWT (from /auth/login)
//        HF_TOKEN     — (optional) HuggingFace write token to set secrets automatically

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://pratik0165-pulsebackend.hf.space";
const version = process.argv[2];
const adminToken = process.env.ADMIN_TOKEN ? process.env.ADMIN_TOKEN.trim() : undefined;
const hfToken = process.env.HF_TOKEN ? process.env.HF_TOKEN.trim() : undefined;
const hfRepo = process.env.HF_REPO ? process.env.HF_REPO.trim() : "";

if (!version) {
  console.error("Usage: node scripts/deploy-update.js 1.2.3");
  process.exit(1);
}
if (!adminToken) {
  console.error("Error: set ADMIN_TOKEN to a valid backend JWT before running.");
  process.exit(1);
}

async function run() {
  // 1. Build
  console.log("▶  Building Next.js...");
  execSync("npm run build", { stdio: "inherit" });

  // 2. Zip (delegate to zip.js — it already skips .map and .DS_Store)
  console.log("▶  Zipping...");
  execSync("node scripts/zip.js", { stdio: "inherit" });

  const zipPath = path.join(__dirname, "..", "app-bundle.zip");
  if (!fs.existsSync(zipPath)) throw new Error("zip.js did not produce app-bundle.zip");

  // 3. Checksum
  const buf = fs.readFileSync(zipPath);
  const checksum = crypto.createHash("sha256").update(buf).digest("hex");
  console.log("▶  SHA-256:", checksum);

  // 4. Exchange Supabase token → backend JWT if needed
  let token = adminToken;
  try {
    const authRes = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: adminToken }),
    });
    if (authRes.ok) {
      const { access_token } = await authRes.json();
      if (access_token) { token = access_token; console.log("▶  Exchanged Supabase → backend JWT"); }
    }
  } catch { /* already have a backend JWT */ }

  // 5. Upload — send as application/zip (backend accepts it + magic-byte check agrees)
  console.log(`▶  Uploading to ${API_URL}/upload ...`);
  const FormData = (await import("node:buffer")).Blob ? globalThis.FormData : undefined;

  // Node 18+: use native fetch + FormData; Node 16: fall back to form-data package
  let bundleUrl;
  const { FormData: NativeForm } = await import("formdata-node").catch(() => ({ FormData: undefined }));
  const FD = NativeForm || globalThis.FormData;
  if (!FD) throw new Error("No FormData available — run with Node 18+ or install formdata-node");

  const form = new FD();
  const blob = new Blob([buf], { type: "application/zip" });
  form.append("file", blob, "app-bundle.zip");

  const upRes = await fetch(`${API_URL}/upload`, {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${token}`,
      "X-App-Version": version,
      "X-App-Checksum": checksum
    },
    body: form,
  });
  if (!upRes.ok) {
    const txt = await upRes.text();
    throw new Error(`Upload failed ${upRes.status}: ${txt}`);
  }
  const { url } = await upRes.json();
  bundleUrl = url;

  // Cleanup zip
  fs.unlinkSync(zipPath);

  console.log("\n✅  Bundle uploaded!");
  console.log("   URL:      ", bundleUrl);
  console.log("   Checksum: ", checksum);
  console.log("   Version:  ", version);

  // 6. Optionally push secrets to HuggingFace Space automatically
  if (hfToken && hfRepo) {
    console.log("\n▶  Updating HuggingFace Space secrets...");
    const secrets = {
      APP_VERSION: version,
      BUNDLE_URL: bundleUrl,
      BUNDLE_CHECKSUM: checksum,
    };
    for (const [name, value] of Object.entries(secrets)) {
      try {
        const payload = JSON.stringify({ key: name, value }).replace(/"/g, '\\"');
        const cmd = `curl.exe -s -X POST -H "Authorization: Bearer ${hfToken}" -H "Content-Type: application/json" -d "${payload}" "https://huggingface.co/api/spaces/${hfRepo}/secrets"`;
        execSync(cmd);
        console.log(`   ${name}: ✓`);
        // Sleep 3 seconds to prevent concurrent secret update errors
        execSync("tar -version 2>nul || ping 127.0.0.1 -n 4 >nul"); // Cross-platform shell sleep for ~3s in cmd.exe
      } catch (e) {
        console.log(`   ${name}: FAILED (${e.message})`);
      }
    }
    console.log("\n▶  Restarting space...");
    try {
      execSync(`curl.exe -s -X POST -H "Authorization: Bearer ${hfToken}" "https://huggingface.co/api/spaces/${hfRepo}/restart"`);
      console.log("   Space restart triggered. Users get the update automatically.");
    } catch (e) {
      console.log(`   Space restart FAILED (${e.message})`);
    }
  } else {
    console.log("\nPaste these into HuggingFace Space → Settings → Secrets, then restart:");
    console.log(`   APP_VERSION      = ${version}`);
    console.log(`   BUNDLE_URL       = ${bundleUrl}`);
    console.log(`   BUNDLE_CHECKSUM  = ${checksum}`);
  }
}

run().catch(err => { console.error("\n❌", err.message); process.exit(1); });