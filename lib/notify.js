// macOS notifications. Uses terminal-notifier when installed (the banner then
// opens the dashboard on click); otherwise falls back to AppleScript.
import { execFile, execFileSync } from 'node:child_process';

let notifierPath;
function terminalNotifier() {
  if (notifierPath !== undefined) return notifierPath;
  try {
    notifierPath = execFileSync('/usr/bin/which', ['terminal-notifier'], { encoding: 'utf8' }).trim() || null;
  } catch {
    notifierPath = null;
  }
  return notifierPath;
}

const asAppleScriptString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function notify({ title, subtitle = '', message, url }) {
  if (process.platform !== 'darwin') {
    console.log(`[reminder] ${title}: ${message}`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const tn = terminalNotifier();
    const done = (err) => {
      if (err) console.error('[reminder] notification failed:', err.message);
      resolve(!err);
    };
    if (tn) {
      const args = ['-title', title, '-message', message, '-sound', 'Glass', '-group', 'givemebucks'];
      if (subtitle) args.push('-subtitle', subtitle);
      if (url) args.push('-open', url);
      execFile(tn, args, done);
    } else {
      const script = `display notification ${asAppleScriptString(message)} with title ${asAppleScriptString(title)}` +
        (subtitle ? ` subtitle ${asAppleScriptString(subtitle)}` : '') + ' sound name "Glass"';
      execFile('/usr/bin/osascript', ['-e', script], done);
    }
  });
}
