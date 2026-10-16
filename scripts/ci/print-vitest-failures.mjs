import fs from 'node:fs';

const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const suite of report.testResults ?? []) {
  for (const test of suite.assertionResults ?? []) {
    if (test.status === 'passed') continue;
    console.error(`${test.status}: ${test.fullName}`);
    for (const failure of test.failureMessages ?? []) console.error(failure);
  }
}
console.error(JSON.stringify({
  success: report.success,
  numFailedTests: report.numFailedTests,
  numPendingTests: report.numPendingTests,
}));
