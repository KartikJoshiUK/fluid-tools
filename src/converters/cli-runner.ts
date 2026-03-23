#!/usr/bin/env ts-node
/**
 * Improved CLI tool to convert Postman collections to LangChain tools
 * Now supports TypeScript execution and better error handling
 */

import * as fs from 'fs';
import * as path from 'path';
import { postmanToLangChainCode } from './utils';
import type { PostmanCollection } from './types';

interface CLIOptions {
  inputFile: string;
  outputFile?: string;
  help?: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { inputFile: '' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--output' || arg === '-o') {
      options.outputFile = args[++i];
    } else if (!options.inputFile) {
      options.inputFile = arg;
    } else if (!options.outputFile) {
      options.outputFile = arg;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
[FluidTools: Postman to LangChain Converter]

Usage: 
  npm run convert-tools <input-file> [output-file]
  npm run convert-tools -- --help

Options:
  -h, --help              Show this help display
  -o, --output <file>     Designate output file

Examples:
  npm run convert-tools api.json tools.ts
  npm run convert-tools api.json -o generated-tools.ts
  npm run convert-tools -- --help

Input: Postman collection JSON file
Output: TypeScript file containing LangChain tools (output is directed to stdout if no file is specified)
  `);
}

function validateInputFile(inputFile: string): void {
  if (!inputFile) {
    throw new Error('Input file is required');
  }

  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const ext = path.extname(inputFile).toLowerCase();
  if (ext !== '.json') {
    console.warn(`[FluidTools: CLI Warning] Unexpected file extension: expected '.json', but received '${ext}'.`);
  }
}

function readPostmanCollection(inputFile: string): PostmanCollection {
  try {
    const content = fs.readFileSync(inputFile, 'utf-8');
    const collection = JSON.parse(content);
    
    if (!collection.info) {
      console.warn('[FluidTools: CLI Warning] The provided collection is missing the required "info" section.');
    }
    
    if (!collection.item || !Array.isArray(collection.item)) {
      throw new Error('Invalid Postman collection: missing or invalid item array');
    }

    return collection;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in input file: ${error.message}`);
    }
    throw error;
  }
}

function writeOutput(code: string, outputFile?: string, toolCount: number = 0): void {
  if (outputFile) {
    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (outputDir !== '.' && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputFile, code);
    console.info(`[FluidTools: Conversion Success] Successfully converted ${toolCount} tools to LangChain format.`);
    console.info(`[FluidTools: File System] Output persistence established at: ${outputFile}`);
    console.info(`[FluidTools: Statistics] Generated file size: ${(code.length / 1024).toFixed(2)} KB`);
  } else {
    console.log(code);
  }
}

function main(): void {
  try {
    const options = parseArgs();

    if (options.help) {
      showHelp();
      process.exit(0);
    }

    validateInputFile(options.inputFile);
    
    console.info(`[FluidTools: Processing] Initiating conversion for: ${options.inputFile}`);
    
    const collection = readPostmanCollection(options.inputFile);
    const toolCount = collection.item ? collection.item.length : 0;
    
    console.info(`[FluidTools: Metadata] Collection Name: ${collection.info?.name || 'Unknown'}`);
    console.info(`[FluidTools: Analysis] Identified ${toolCount} potential tools within the collection.`);
    
    const code = postmanToLangChainCode(collection);
    
    writeOutput(code, options.outputFile, toolCount);
    
  } catch (error) {
    console.error(`[FluidTools: Fatal Error] ${error instanceof Error ? error.message : error}`);
    console.info('\nUse the --help flag for detailed usage information.');
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  main();
}

export { main as runCLI };