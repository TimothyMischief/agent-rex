#!/usr/bin/env node
/**
 * Bootstrap Tangler for Organjsm
 * 
 * A minimal tangler that can extract source code from org files
 * without depending on the full organjsm package.
 * 
 * Usage: node bootstrap-tangle.mjs [options] <files...>
 * 
 * Options:
 *   --out-dir <dir>   Output directory (default: dist)
 *   --dry-run         Show what would be written without writing
 *   --verbose         Show detailed output
 *   --no-clean        Skip cleaning TypeScript build cache
 * 
 * After tangling, this script automatically removes tsconfig.tsbuildinfo files
 * to force a full TypeScript recheck. This prevents CI/local discrepancies
 * caused by stale incremental build caches.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

/**
 * @typedef {Object} SourceBlock
 * @property {string} name - Block name (from #+name:)
 * @property {string} language - Language identifier
 * @property {string} content - Block content
 * @property {Object} headerArgs - Parsed header arguments
 * @property {number} startLine - Line number of #+begin_src
 * @property {number} contentStartLine - Line number of first content line
 * @property {number} endLine - Line number of #+end_src
 * @property {string} sourcePath - Path to source org file
 */

/**
 * @typedef {Object} TangleTarget
 * @property {string} path - Output file path
 * @property {SourceBlock[]} blocks - Blocks contributing to this file
 */

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse header arguments from a #+begin_src line
 * @param {string} line - The #+begin_src line
 * @returns {{ language: string, args: Object }}
 */
function parseHeaderArgs(line) {
  const match = line.match(/^#\+begin_src\s+(\S+)(.*)$/i);
  if (!match) return { language: '', args: {} };
  
  const language = match[1];
  const argsStr = match[2].trim();
  const args = {};
  
  // Parse :key value pairs (key can contain hyphens)
  const argRegex = /:([\w-]+)\s+([^\s:]+|"[^"]*")/g;
  let argMatch;
  while ((argMatch = argRegex.exec(argsStr)) !== null) {
    let value = argMatch[2];
    // Remove quotes if present
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    args[argMatch[1]] = value;
  }
  
  // Handle boolean flags like :noweb yes
  const flagRegex = /:([\w-]+)\s+(yes|no|t|nil)\b/gi;
  let flagMatch;
  while ((flagMatch = flagRegex.exec(argsStr)) !== null) {
    const value = flagMatch[2].toLowerCase();
    args[flagMatch[1]] = value === 'yes' || value === 't';
  }
  
  return { language, args };
}

/**
 * Extract all source blocks from an org file
 * @param {string} content - File content
 * @param {string} sourcePath - Path to source file
 * @param {Object} fileProperties - Document-level properties
 * @returns {SourceBlock[]}
 */
function extractBlocks(content, sourcePath, fileProperties = {}) {
  // Normalize line endings (CRLF -> LF) for cross-platform compatibility
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedContent.split('\n');
  const blocks = [];
  let currentName = null;
  let inBlock = false;
  let currentBlock = null;
  let inExampleBlock = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim().toLowerCase();
    
    // Only process blocks that start at column 0 (not inside code strings)
    const isAtColumnZero = line.match(/^#\+/i);
    
    // Track example blocks (skip source blocks inside them)
    // But DON'T process these if we're already inside a source block (it's content)
    if (!inBlock && isAtColumnZero && trimmed.startsWith('#+begin_example')) {
      inExampleBlock = true;
      continue;
    }
    if (!inBlock && isAtColumnZero && trimmed.startsWith('#+end_example')) {
      inExampleBlock = false;
      continue;
    }
    
    // Skip all processing if we're inside an example block
    if (inExampleBlock) {
      continue;
    }
    
    // Track #+name: for next block (only at column 0, not inside a block)
    if (isAtColumnZero && trimmed.startsWith('#+name:') && !inBlock) {
      currentName = line.substring(line.indexOf(':') + 1).trim();
      continue;
    }
    
    // Start of source block (only at column 0, not already inside a block)
    if (isAtColumnZero && trimmed.startsWith('#+begin_src') && !inBlock) {
      const { language, args } = parseHeaderArgs(line.trim());
      
      // Merge with file-level properties: global (*), then language-specific, then block args
      const globalProps = fileProperties['*'] || {};
      const langProps = fileProperties[language] || {};
      const mergedArgs = { ...globalProps, ...langProps, ...args };
      
      // Blocks with :noweb-ref implicitly have :tangle no (unless explicitly overridden)
      const hasNowebRef = args['noweb-ref'] || args.nowebRef;
      const hasTangleInBlock = 'tangle' in args;
      if (hasNowebRef && !hasTangleInBlock) {
        mergedArgs.tangle = 'no';
      }
      
      currentBlock = {
        name: currentName,
        language,
        content: '',
        headerArgs: mergedArgs,
        startLine: i,
        contentStartLine: i + 1,
        endLine: -1,
        sourcePath,
      };
      inBlock = true;
      currentName = null;
      continue;
    }
    
    // End of source block (only at column 0)
    if (isAtColumnZero && trimmed.startsWith('#+end_src') && inBlock) {
      currentBlock.endLine = i;
      // Remove trailing newline from content
      currentBlock.content = currentBlock.content.replace(/\n$/, '');
      blocks.push(currentBlock);
      currentBlock = null;
      inBlock = false;
      continue;
    }
    
    // Content line inside block
    if (inBlock && currentBlock) {
      // Strip org's comma escaping: commas at start of line escape special chars
      // This prevents them from being interpreted as org directives/headings
      let contentLine = line;
      // Remove comma escaping at start of line for #+, *, etc.
      if (line.startsWith(',')) {
        contentLine = line.substring(1);
      }
      // Also handle comma escaping inside strings (e.g., in template literals)
      // Pattern: newline followed by comma and #+
      contentLine = contentLine.replace(/(\n),#\+/g, '$1#+');
      // Pattern: comma + #+ at the start of a template literal line content
      contentLine = contentLine.replace(/`,#\+/g, '`#+');
      currentBlock.content += contentLine + '\n';
    }
  }
  
  return blocks;
}

/**
 * Extract document-level properties
 * @param {string} content - File content
 * @returns {Object}
 */
function extractFileProperties(content) {
  const props = {};
  // Normalize line endings for cross-platform compatibility
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // #+PROPERTY: header-args:typescript :tangle path
    const propMatch = trimmed.match(/^#\+PROPERTY:\s+header-args(?::(\w+))?\s+(.+)$/i);
    if (propMatch) {
      const lang = propMatch[1] || '*';
      const argsStr = propMatch[2];
      
      // Parse the args
      const { args } = parseHeaderArgs('#+begin_src dummy ' + argsStr);
      props[lang] = { ...props[lang], ...args };
    }
  }
  
  return props;
}

// ============================================================================
// Noweb Expansion
// ============================================================================

/**
 * Build a map of block names to blocks
 * @param {SourceBlock[]} blocks
 * @returns {Map<string, SourceBlock[]>}
 */
function buildBlockIndex(blocks) {
  const index = new Map();
  for (const block of blocks) {
    // Index by #+name:
    if (block.name) {
      if (!index.has(block.name)) {
        index.set(block.name, []);
      }
      index.get(block.name).push(block);
    }
    
    // Also index by :noweb-ref (for blocks without names, or with different names)
    const nowebRef = block.headerArgs['noweb-ref'] || block.headerArgs.nowebRef;
    if (nowebRef && nowebRef !== block.name) {
      if (!index.has(nowebRef)) {
        index.set(nowebRef, []);
      }
      index.get(nowebRef).push(block);
    }
  }
  return index;
}

/**
 * Expand noweb references in content
 * @param {string} content - Block content
 * @param {Map<string, SourceBlock[]>} blockIndex - Named blocks index
 * @param {Set<string>} visited - Already visited blocks (cycle detection)
 * @param {string} indent - Current indentation
 * @returns {string}
 */
function expandNoweb(content, blockIndex, visited = new Set(), indent = '') {
  const lines = content.split('\n');
  const result = [];
  
  for (const line of lines) {
    const nowebMatch = line.match(/^(\s*)<<([^>]+)>>(.*)$/);
    
    if (nowebMatch) {
      const [, leadingIndent, refName, trailing] = nowebMatch;
      const totalIndent = indent + leadingIndent;
      
      if (visited.has(refName)) {
        result.push(`${totalIndent}/* ERROR: Circular reference to ${refName} */${trailing}`);
        continue;
      }
      
      const referencedBlocks = blockIndex.get(refName);
      if (!referencedBlocks || referencedBlocks.length === 0) {
        // Leave unresolved references intact (like the shipped tangler)
        result.push(`${totalIndent}<<${refName}>>${trailing}`);
        continue;
      }
      
      // Expand all blocks with this name
      visited.add(refName);
      for (let i = 0; i < referencedBlocks.length; i++) {
        const block = referencedBlocks[i];
        const expanded = expandNoweb(block.content, blockIndex, visited, totalIndent);
        // expandNoweb already applied totalIndent, so just split and add to result
        const expandedLines = expanded.split('\n');
        result.push(...expandedLines);
        
        // Add a blank line between multiple blocks with the same noweb-ref
        // (except after the last block)
        if (i < referencedBlocks.length - 1) {
          result.push('');
        }
      }
      visited.delete(refName);
      
      if (trailing) {
        result[result.length - 1] += trailing;
      }
    } else {
      result.push(indent + line);
    }
  }
  
  return result.join('\n');
}

// ============================================================================
// Tangling
// ============================================================================

/**
 * Get default file extension for a language
 * @param {string} lang - Language identifier
 * @returns {string}
 */
function getExtensionForLanguage(lang) {
  const extensions = {
    typescript: '.ts', javascript: '.js', python: '.py',
    rust: '.rs', go: '.go', java: '.java', c: '.c',
    cpp: '.cpp', sh: '.sh', bash: '.sh', ruby: '.rb',
    json: '.json', yaml: '.yaml', yml: '.yml',
    markdown: '.md', org: '.org',
  };
  return extensions[lang.toLowerCase()] || '.txt';
}

/**
 * Get the comment prefix for a file based on its extension
 * @param {string} targetPath - Path to the file
 * @returns {string}
 */
function getCommentPrefix(targetPath) {
  const ext = targetPath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'py':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'toml':
    case 'rb':
    case 'pl':
    case 'r':
      return '#';
    case 'lisp':
    case 'el':
    case 'clj':
    case 'scm':
      return ';;';
    case 'lua':
    case 'sql':
    case 'hs':
      return '--';
    case 'css':
      return '/*';
    case 'html':
    case 'xml':
      return '<!--';
    case 'json':
    case 'yaml':
    case 'yml':
    case 'md':
    case 'org':
    case 'wasm':
    case 'txt':
      return '';
    default:
      return '//';
  }
}

/**
 * Get the comment suffix for a file based on its extension
 * @param {string} targetPath - Path to the file
 * @returns {string}
 */
function getCommentSuffix(targetPath) {
  const ext = targetPath.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'css':
      return ' */';
    case 'html':
    case 'xml':
      return ' -->';
    default:
      return '';
  }
}

/**
 * Group blocks by tangle target
 * @param {SourceBlock[]} blocks
 * @param {string} baseDir - Base directory for relative paths
 * @returns {Map<string, SourceBlock[]>}
 */
function groupByTarget(blocks, baseDir) {
  const targets = new Map();
  
  for (const block of blocks) {
    // Blocks with :noweb-ref should not be tangled independently
    // (they are only included via noweb expansion in other blocks)
    const hasNowebRef = block.headerArgs['noweb-ref'] || block.headerArgs.nowebRef;
    const hasTangle = 'tangle' in block.headerArgs;
    
    // Skip noweb-ref blocks unless they explicitly set :tangle
    if (hasNowebRef && !hasTangle) {
      continue;
    }
    
    const tangle = block.headerArgs.tangle;
    if (!tangle || tangle === 'no' || tangle === false) continue;
    
    // Determine target path
    let targetPath;
    if (tangle === true || tangle === 'yes') {
      // :tangle yes - derive from org filename and language
      const sourceDir = dirname(block.sourcePath);
      const baseName = block.sourcePath.replace(/\.org$/, '');
      const ext = getExtensionForLanguage(block.language);
      targetPath = baseName + ext;
    } else {
      // :tangle "path" - use explicit path
      const sourceDir = dirname(block.sourcePath);
      targetPath = resolve(sourceDir, tangle);
    }
    
    if (!targets.has(targetPath)) {
      targets.set(targetPath, []);
    }
    targets.get(targetPath).push(block);
  }
  
  return targets;
}

/**
 * Generate tangled content for a target
 * @param {SourceBlock[]} blocks - Blocks for this target
 * @param {Map<string, SourceBlock[]>} blockIndex - All named blocks
 * @param {string} targetPath - The target file path
 * @returns {string}
 */
function generateContent(blocks, blockIndex, targetPath) {
  const parts = [];
  
  // Determine file type to decide comment style
  const isJson = targetPath.endsWith('.json');
  const isYaml = targetPath.endsWith('.yaml') || targetPath.endsWith('.yml');
  const isMarkdown = targetPath.endsWith('.md');
  const isOrg = targetPath.endsWith('.org');
  const isBinary = targetPath.endsWith('.wasm');
  
  // Check if any block has :comments no
  const noComments = blocks.some(b => b.headerArgs.comments === 'no' || b.headerArgs.comments === false);
  
  // Skip comments for JSON, YAML, Markdown, Org, binary, or if :comments no
  const skipComments = isJson || isYaml || isMarkdown || isOrg || isBinary || noComments;
  
  // Check for shebang:
  // 1. From :shebang header arg (org-mode standard)
  // 2. From first line of content (if it starts with #!)
  let shebang = null;
  for (const block of blocks) {
    // Check header arg first
    if (block.headerArgs.shebang) {
      shebang = block.headerArgs.shebang;
      break;
    }
    // Check content
    const firstLine = block.content.split('\n')[0];
    if (firstLine && firstLine.startsWith('#!')) {
      shebang = firstLine;
      // Remove shebang from block content so we don't duplicate it
      block.content = block.content.substring(firstLine.length + 1);
      break;
    }
  }
  
  // Add shebang first if present
  if (shebang) {
    parts.push(shebang);
  }
  
  // Add header comment (unless skipping comments)
  const commentPrefix = getCommentPrefix(targetPath);
  const commentSuffix = getCommentSuffix(targetPath);
  if (!skipComments && commentPrefix) {
    parts.push(`${commentPrefix} This file is auto-generated by organjsm tangle. Do not edit directly.${commentSuffix}`);
    const relativeSources = [...new Set(blocks.map(b => relative(process.cwd(), b.sourcePath)))];
    parts.push(`${commentPrefix} Source: ${relativeSources.join(', ')}${commentSuffix}`);
    parts.push('');
  }
  
  for (const block of blocks) {
    // Add source link comment (unless skipping comments)
    if (!skipComments && commentPrefix) {
      const relativePath = relative(process.cwd(), block.sourcePath);
      parts.push(`${commentPrefix} [[file:${relativePath}::${block.startLine + 1}]]${commentSuffix}`);
    }
    
    // Expand noweb references (but not for .org files - preserve them literally as test data)
    const expanded = isOrg ? block.content : expandNoweb(block.content, blockIndex);
    parts.push(expanded);
    
    // Add footer comment (unless skipping comments)
    if (!skipComments && commentPrefix) {
      parts.push(`${commentPrefix} ${block.name || 'unnamed'} ends here${commentSuffix}`);
      parts.push('');
    }
  }
  
  return parts.join('\n');
}

// ============================================================================
// CLI
// ============================================================================

/**
 * Recursively find all .org files in a directory
 */
function findOrgFiles(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'scripts' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findOrgFiles(full, results);
    } else if (entry.endsWith('.org')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Find and delete tsconfig.tsbuildinfo files to force TypeScript recheck.
 * This prevents CI/local discrepancies caused by stale incremental builds.
 * See 90-04-testing.org "CI vs Local Build Discrepancies" for details.
 */
function cleanTsBuildInfo(dir, verbose) {
  const buildInfoFiles = [];
  
  function findBuildInfo(searchDir) {
    try {
      for (const entry of readdirSync(searchDir)) {
        if (entry === 'node_modules') continue;
        const full = join(searchDir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          findBuildInfo(full);
        } else if (entry === 'tsconfig.tsbuildinfo' || entry.endsWith('.tsbuildinfo')) {
          buildInfoFiles.push(full);
        }
      }
    } catch (e) {
      // Ignore permission errors
    }
  }
  
  findBuildInfo(dir);
  
  if (buildInfoFiles.length > 0) {
    console.log(`Cleaning ${buildInfoFiles.length} TypeScript build cache file(s)...`);
    for (const file of buildInfoFiles) {
      try {
        unlinkSync(file);
        if (verbose) {
          console.log(`  Deleted: ${relative(process.cwd(), file)}`);
        }
      } catch (e) {
        console.warn(`  Warning: Could not delete ${file}: ${e.message}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  // Parse options
  let outDir = 'dist';
  let dryRun = false;
  let verbose = false;
  let cleanCache = true;
  const files = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out-dir' && args[i + 1]) {
      outDir = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--verbose') {
      verbose = true;
    } else if (args[i] === '--no-clean') {
      cleanCache = false;
    } else if (!args[i].startsWith('-')) {
      files.push(args[i]);
    }
  }
  
  // Default to all .org files in literate-refactor directory
  let orgFiles = files;
  if (orgFiles.length === 0) {
    orgFiles = findOrgFiles(__dirname);
  }
  
  if (orgFiles.length === 0) {
    console.log('No .org files found');
    process.exit(1);
  }
  
  console.log(`Processing ${orgFiles.length} org files...`);
  
  // Extract all blocks from all files
  const allBlocks = [];
  
  for (const file of orgFiles) {
    try {
      const content = readFileSync(file, 'utf-8');
      const fileProps = extractFileProperties(content);
      const blocks = extractBlocks(content, file, fileProps);
      allBlocks.push(...blocks);
      
      if (verbose) {
        console.log(`  ${relative(process.cwd(), file)}: ${blocks.length} blocks`);
      }
    } catch (err) {
      console.error(`Error reading ${file}: ${err.message}`);
    }
  }
  
  console.log(`Found ${allBlocks.length} source blocks`);
  
  // Build block index for noweb expansion
  const blockIndex = buildBlockIndex(allBlocks);
  console.log(`Named blocks: ${blockIndex.size}`);
  
  // Group by tangle target
  const targets = groupByTarget(allBlocks, process.cwd());
  console.log(`Tangle targets: ${targets.size}`);
  
  // Generate and write each target
  let written = 0;
  for (const [targetPath, blocks] of targets) {
    const content = generateContent(blocks, blockIndex, targetPath);
    const relativePath = relative(process.cwd(), targetPath);
    
    if (dryRun) {
      console.log(`Would write: ${relativePath} (${content.length} bytes, ${blocks.length} blocks)`);
    } else {
      const dir = dirname(targetPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(targetPath, content, 'utf-8');
      if (verbose) {
        console.log(`Wrote: ${relativePath}`);
      }
      written++;
    }
  }
  
  if (!dryRun) {
    console.log(`Wrote ${written} files`);
    
    // Clean TypeScript build cache to force full recheck on next build
    if (cleanCache) {
      cleanTsBuildInfo(outDir, verbose);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
