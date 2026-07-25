import { execFileSync } from 'node:child_process';

function run(script) {
  const output = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    cwd: process.cwd()
  });
  return JSON.parse(output);
}

const regionalInputContract = run('scripts/validate-regional-inputs.mjs');
const hackathonDiagnostic = run('scripts/validate-hackathon-benchmarks.mjs');

console.log(JSON.stringify({
  validator: 'regional-offline-suite',
  status: 'pass',
  networkRequired: false,
  regionalInputContract,
  hackathonDiagnostic
}, null, 2));
