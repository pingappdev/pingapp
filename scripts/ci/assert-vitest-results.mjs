import fs from 'node:fs';

const reportPath = process.argv[2];
const options = new Set(process.argv.slice(3));
if (!reportPath) {
  console.error('Usage: node scripts/ci/assert-vitest-results.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`Could not read Vitest JSON report at ${reportPath}: ${error.message}`);
  process.exit(2);
}

const assertions = (report.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
const skipped = assertions.filter((test) => ['pending', 'skipped', 'todo'].includes(test.status));
const failed = assertions.filter((test) => test.status === 'failed');
const integration = assertions.find((test) =>
  test.fullName?.includes('deploys locally and executes signed send, escrow, claim and refund'),
);
const expectedFiles = [...options]
  .filter((option) => option.startsWith('--expect-file='))
  .map((option) => option.slice('--expect-file='.length));
const expectedCount = Number([...options].find((option) => option.startsWith('--expect-count='))?.slice('--expect-count='.length) ?? 0);
const expectedAtLeast = Number([...options].find((option) => option.startsWith('--expect-at-least='))?.slice('--expect-at-least='.length) ?? 0);
const suiteCounts = [...options]
  .filter((option) => option.startsWith('--expect-suite-count='))
  .map((option) => {
    const value = option.slice('--expect-suite-count='.length);
    const separator = value.lastIndexOf('=');
    return separator > 0 ? [value.slice(0, separator), Number(value.slice(separator + 1))] : ['', NaN];
  });

if (report.success !== true || failed.length > 0) {
  console.error(`Vitest reported ${failed.length} failed assertion(s).`);
  process.exit(1);
}
if (skipped.length > 0) {
  console.error(`Vitest reported ${skipped.length} skipped/todo assertion(s):`);
  for (const test of skipped) console.error(`- ${test.fullName} (${test.status})`);
  process.exit(1);
}
if (!options.has('--no-anvil') && (!integration || integration.status !== 'passed')) {
  console.error('The local Anvil signed-router integration test did not run and pass.');
  process.exit(1);
}
for (const expectedFile of expectedFiles) {
  const matchingSuites = (report.testResults ?? []).filter((suite) => suite.name?.replaceAll('\\', '/').endsWith(expectedFile));
  if (matchingSuites.length === 0) {
    console.error(`Required Vitest suite ${expectedFile} did not run.`);
    process.exit(1);
  }
}
if (expectedCount > 0 || expectedAtLeast > 0) {
  const expectedSuiteAssertions = (report.testResults ?? [])
    .filter((suite) => expectedFiles.some((expectedFile) => suite.name?.replaceAll('\\', '/').endsWith(expectedFile)))
    .flatMap((suite) => suite.assertionResults ?? []);
  if ((expectedCount > 0 && expectedSuiteAssertions.length !== expectedCount)
    || expectedSuiteAssertions.length < expectedAtLeast
    || expectedSuiteAssertions.some((test) => test.status !== 'passed')) {
    const expected = expectedCount > 0 ? `exactly ${expectedCount}` : `at least ${expectedAtLeast}`;
    console.error(`Expected ${expected} passing assertion(s) across required suites; found ${expectedSuiteAssertions.length}.`);
    process.exit(1);
  }
}
for (const [expectedFile, expectedCount] of suiteCounts) {
  const assertionsInSuite = (report.testResults ?? [])
    .filter((suite) => suite.name?.replaceAll('\\', '/').endsWith(expectedFile))
    .flatMap((suite) => suite.assertionResults ?? []);
  if (!expectedFile || !Number.isInteger(expectedCount) || assertionsInSuite.length !== expectedCount
    || assertionsInSuite.some((test) => test.status !== 'passed')) {
    console.error(`Expected exactly ${expectedCount} passing assertion(s) in ${expectedFile}; found ${assertionsInSuite.length}.`);
    process.exit(1);
  }
}

console.log(`Vitest passed ${assertions.length} assertions${options.has('--no-anvil') ? '' : ', including the local Anvil integration'}.`);
