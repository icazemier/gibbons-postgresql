#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { init } from './init.js';

/**
 * Main CLI entry point using yargs for command parsing and routing.
 */
void yargs(hideBin(process.argv))
  .scriptName('gibbons-postgresql')
  .command(
    'init',
    'Create the schema and populate new groups and permissions tables in your existing PostgreSQL instance',
    (yargs) => {
      return yargs
        .options({
          uri: {
            demandOption: true,
            alias: 'u',
            type: 'string',
            description:
              'PostgreSQL connection URI (Note: table names are configured through config)',
            nargs: 1,
          },
          config: {
            demandOption: false,
            alias: 'c',
            type: 'string',
            description: 'Point to custom/own config file',
            nargs: 1,
          },
        })
        .example(
          '$0 init --uri=postgresql://localhost:5432/mydb --config=./someconfig.json',
          'Populates groups and permissions in PostgreSQL for given URI specified by a custom config file'
        );
    },
    async (argv) => {
      try {
        await init(argv);
        console.log('✓ Database initialization completed successfully');
        process.exit(0);
      } catch (error) {
        console.error(
          '✗ Initialization failed:',
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    }
  )
  .usage('Usage: $0 <command> [options]')
  .demandCommand(1, 'Expected a command, e.g. `init`')
  .strict()
  .help()
  .alias('help', 'h')
  .version()
  .alias('version', 'v')
  .parse();
