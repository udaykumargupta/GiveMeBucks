// Installs a macOS LaunchAgent so GiveMeBucks (and its reminders) starts at
// login and keeps running in the background. Usage:
//   node scripts/launch-agent.js install | uninstall
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.givemebucks';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try { execFileSync('/bin/launchctl', args, { stdio: 'pipe' }); return true; } catch { return false; }
}

const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(path.join(ROOT, 'local-server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(ROOT, 'data', 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(ROOT, 'data', 'server.log'))}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  launchctl('bootout', `${domain}/${LABEL}`);
  fs.writeFileSync(PLIST, plist);
  if (!launchctl('bootstrap', domain, PLIST)) {
    console.error('launchctl bootstrap failed — try: launchctl bootstrap', domain, PLIST);
    process.exit(1);
  }
  console.log(`Installed. GiveMeBucks now starts at login: http://localhost:${process.env.PORT || 4180}`);
  console.log(`Plist: ${PLIST}`);
} else if (cmd === 'uninstall') {
  launchctl('bootout', `${domain}/${LABEL}`);
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log('Uninstalled. GiveMeBucks no longer starts at login.');
} else {
  console.log('Usage: node scripts/launch-agent.js install | uninstall');
  process.exit(1);
}
