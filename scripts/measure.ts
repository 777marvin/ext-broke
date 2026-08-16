/**
 * Analyze the measurement ledger (measure.jsonl) from the command line:
 * `npm run measure`, or `npm run measure -- --file=<path>` for a specific
 * file. Prints the same honest summary as /broke measure - per-run sizes
 * and per-pass removals, summed over runs, explicitly NOT a cumulative
 * context claim.
 */

import { formatMeasure } from '../commands';
import { loadRunRecords, MEASURE_PATH, summarizeRunRecords } from '../tokens';

function main(): void {
  const flag = process.argv.slice(2).find((a) => a.startsWith('--file='));
  const filePath = flag ? flag.slice('--file='.length) : MEASURE_PATH;
  const summary = summarizeRunRecords(loadRunRecords(filePath));
  if (!summary) {
    console.log(`No measurement records found in ${filePath}`);
    console.log('broke records one line per compression run (config: stats.measure).');
    console.log('Record while working with /broke measure on, then run npm run measure again.');
  } else {
    console.log(formatMeasure(summary));
  }
}

main();
