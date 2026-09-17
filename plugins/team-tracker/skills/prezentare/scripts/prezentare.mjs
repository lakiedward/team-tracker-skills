import { readFileSync } from 'node:fs';
import { inspect, prepare, verify, reset } from './adapters.mjs';
import { productOperation } from './product-flows.mjs';
import { contextQueries } from './transport.mjs';

const operations = { inspect, prepare, verify, reset, flow: productOperation, context: contextQueries };
const [operation, inputPath] = process.argv.slice(2);
if (!operations[operation] || !inputPath) {
  console.error('Usage: node prezentare.mjs <inspect|prepare|verify|reset|flow|context> <input.json>');
  process.exitCode = 1;
} else {
  try { process.stdout.write(`${JSON.stringify(operations[operation](JSON.parse(readFileSync(inputPath, 'utf8'))), null, 2)}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
