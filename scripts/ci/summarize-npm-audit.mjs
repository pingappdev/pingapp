import fs from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/ci/summarize-npm-audit.mjs <npm-audit-json>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`Could not parse npm audit report: ${error.message}`);
  process.exit(2);
}

const counts = report.metadata?.vulnerabilities;
if (!counts || !['info', 'low', 'moderate', 'high', 'critical'].every((key) => Number.isInteger(counts[key]))) {
  console.error('npm audit report is missing its severity summary.');
  process.exit(2);
}

console.log(
  `npm audit: ${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low, ${counts.info} info; blocking at moderate.`,
);
if (counts.critical + counts.high + counts.moderate > 0) process.exit(1);
