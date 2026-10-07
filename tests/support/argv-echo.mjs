// Stand-in for the Impeccable CLI in tests: prints its own arguments as the
// JSON findings array, so a test can see exactly what the runner passed.
process.stdout.write(JSON.stringify([{ argv: process.argv.slice(2) }]));
