import fs from 'node:fs';
const [mode, log] = process.argv.slice(2);
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(data);
  fs.appendFileSync(log, JSON.stringify({
    payload, cwd:process.cwd(), envProject:process.env.CLAUDE_PROJECT_DIR,
  }) + '\n');
  if (mode === 'deny') {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny', permissionDecisionReason:'policy denied'}}));
  } else if (mode === 'update') {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedInput:{command:'echo safe'}}}));
  } else if (mode === 'context') {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'additional hook context'}}));
  } else if (mode === 'plain') {
    process.stdout.write('context from startup');
  } else if (mode === 'replace') {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedToolOutput:'replaced output', additionalContext:'from after'}}));
  } else if (mode === 'allow') {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{decision:{behavior:'allow'}}}));
  } else if (mode === 'permission-deny') {
    process.stdout.write(JSON.stringify({hookSpecificOutput:{decision:{behavior:'deny', message:'blocked permission'}}}));
  } else if (mode === 'exit2') {
    process.stderr.write('blocked via exit 2');
    process.exitCode = 2;
  } else if (mode === 'fail') {
    process.exitCode = 1;
  } else if (mode === 'slow') {
    setTimeout(() => {}, 1500);
  }
});
