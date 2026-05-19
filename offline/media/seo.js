#!/usr/bin/env node

/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const Minimist = require('minimist');
const { exit } = require('process');
const { readFileSync: readJson, writeFileSync: writeJson } = require('jsonfile');
const { exec } = require('shelljs')
const { join, resolve } = require('path');
const { existsSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } = require("fs");
const { spawn: Spawn } = require("child_process");
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

// Text processing
const SEPARATOR = /[ ,.:;?!\/\-\_\$\&\'\"\\|\@=+\t\n\r\f\)\(\[\]\'\`]+/;
const stopword = require('stopword');

// OCR
/** 
 * Disabled due to security issue 
 * Maybe switching to AI solution ?
*/
// const tesseract = require("node-tesseract-ocr");

// PDF processing
const pdfParse = require('pdf-parse');

const { remove_item } = require('@drumee/server-core').MfsTools;
const { Mariadb, Attr, Offline } = require('@drumee/server-essentials');

class __seo_indexer extends Offline {


  // ========================
  // initialize
  // ========================
  initialize() {
    const argv = Minimist(process.argv.slice(2));
    let node;

    try {
      node = JSON.parse(argv._[0]);
      //console.log(node);
    } catch (e) {
      console.error("Failed to parse arguments", e);
      exit(1);
    }

    // Validate node
    if (!node || !node.id || !node.filetype) {
      console.error("Invalid node data", node);
      exit(1);
    }

    let db_name = node.actual_db || node.db_name;
    if (!db_name) {
      console.error("No database name provided", node);
      exit(1);
    }

    this.db = new Mariadb({ name: db_name });
    this.node = node;
    this.tempFiles = [];

    // Logger.debug(`START`);
    this.syslog(`START INDEXING ${node.filename} ${node.filetype}`);

    // Supported file types
    const supportedTypes = [Attr.document, Attr.image];
    if (!supportedTypes.includes(node.filetype)) {
      this.syslog('Unsupported file type', node.filetype);
      process.exit(1);
    }

    // Start processing with error handling
    this.parse(node)
      .then(() => {
        this.stop();
      })
      .catch((e) => {
        this.stop(e);
      });
  }

  /**
   * 
   * Stop with cleanup
   */
  stop(error) {
    if (!error) {
      this.syslog('INDEXING COMPLETE', this.node.filename);
    } else {
      this.syslog('STOP INDEXING DUE TO ERROR', error.message || error);
    }

    // Cleanup temp files
    this.cleanup();

    super.stop(error);
    process.exit(error ? 1 : 0);
  }

  /**
   * Cleanup temporary files
   */
  cleanup() {
    if (!this.node) return;

    const mfs_dir = resolve(this.node.mfs_root, this.node.id);
    const tempFiles = [
      join(mfs_dir, 'index.txt'),
      join(mfs_dir, 'preview.pdf'),
      join(mfs_dir, 'jpgout')
    ];

    for (let file of tempFiles) {
      try {
        if (existsSync(file)) {
          remove_item(file, 1);
        }
      } catch (e) {
        this.syslog(`Cleanup failed for ${file}:`, e.message);
      }
    }
  }

  /**
   * Execute shell command with timeout
   */
  async execCommand(cmd, timeout = 60000) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout });
      if (stderr && !stderr.includes('Warning')) {
        this.syslog('Command stderr:', stderr);
      }
      return stdout;
    } catch (e) {
      throw new Error(`Command failed: ${cmd}\n${e.message}`);
    }
  }

  /**
   * Extract text from image using OCR
   */
  async extractFromImage(src, index) {
    if (!existsSync(src)) {
      throw new Error(`Source file not found: ${src}`);
    }

    this.syslog(`Extracting text from image: ${src}`);

    const config = {
      lang: "eng+fra", // Support multiple languages
      oem: 1,          // LSTM OCR Engine Mode
      psm: 3           // Fully automatic page segmentation
    };

    try {
      const text = await tesseract.recognize(src, config);

      if (!text || text.trim().length === 0) {
        this.syslog('OCR produced no text');
        return '';
      }

      writeFileSync(index, text, 'utf8');
      this.syslog(`OCR extracted ${text.length} characters`);
      return text;

    } catch (e) {
      throw new Error(`OCR failed: ${e.message}`);
    }
  }

  /**
   * Extract text from PDF using pdf-parse
   */
  async extractFromPdf(src, index) {
    if (!existsSync(src)) {
      throw new Error(`PDF file not found: ${src}`);
    }

    this.syslog(`Extracting text from PDF: ${src}`);

    try {
      // Try pdf-parse first (handles both text and some scanned PDFs)
      const dataBuffer = readFileSync(src);
      const data = await pdfParse(dataBuffer);

      if (data.text && data.text.trim().length > 50) {
        writeFileSync(index, data.text, 'utf8');
        this.syslog(`PDF extracted ${data.text.length} characters from ${data.numpages} pages`);
        return data.text;
      }

      // If no text extracted, PDF is likely image-based
      this.syslog('PDF has no text layer, trying pdftotext...');

      // Fallback to pdftotext
      const cmd = `/usr/bin/pdftotext -layout "${src}" "${index}"`;
      await this.execCommand(cmd);

      if (existsSync(index)) {
        const text = readFileSync(index, 'utf8');
        if (text.trim().length > 50) {
          this.syslog(`pdftotext extracted ${text.length} characters`);
          return text;
        }
      }

      // Last resort: OCR
      this.log('PDF has no text, OCR has been disabled...');
      return ""
      /** Disabled due to security issue */
      // return await this.pdfToImageOCR(src, index);

    } catch (e) {
      throw new Error(`PDF extraction failed: ${e.message}`);
    }
  }

  /**
   * Convert PDF to images and OCR
   */
  async pdfToImageOCR(src, index) {
    try {
      // Requires: pdf2image (Python library)
      const mfs_dir = resolve(this.node.mfs_root, this.node.id);
      const outputDir = join(mfs_dir, 'pdf_pages');

      // Convert PDF to images
      const cmd = `python3 -c "
from pdf2image import convert_from_path
images = convert_from_path('${src}', dpi=300, output_folder='${outputDir}', fmt='jpg')
print(f'Converted {len(images)} pages')
"`;

      await this.execCommand(cmd, 120000); // 2 min timeout

      // OCR first page only to save time
      const firstPage = join(outputDir, '1.jpg');
      if (existsSync(firstPage)) {
        return await this.extractFromImage(firstPage, index);
      }

      throw new Error('PDF to image conversion produced no output');

    } catch (e) {
      throw new Error(`PDF OCR failed: ${e.message}`);
    }
  }

  /**
   * Convert Office file to PDF
   */
  async convertToPdf(node) {
    const mfs_dir = resolve(node.mfs_root, node.id);
    const pdfPath = join(mfs_dir, 'preview.pdf');

    // Check if already converted
    if (existsSync(pdfPath)) {
      this.syslog('Using existing preview.pdf');
      return pdfPath;
    }

    this.syslog('Converting to PDF...');

    // Call conversion script and wait
    const cmd = resolve(__dirname, 'to-pdf.js');
    const args = {
      node,
      uid: this.uid,
      noSocket: 1
    };

    try {
      // Execute and wait for completion
      await this.execCommand(`${cmd} '${JSON.stringify(args)}'`, 180000); // 3 min timeout

      // Wait for file to appear
      let attempts = 0;
      while (!existsSync(pdfPath) && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        attempts++;
      }

      if (!existsSync(pdfPath)) {
        throw new Error('PDF conversion timeout');
      }

      this.syslog('PDF conversion complete');
      return pdfPath;

    } catch (e) {
      throw new Error(`Office conversion failed: ${e.message}`);
    }
  }

  /**
   * Tokenize and clean words
   */
  processWords(text, minLength = 3) {
    if (!text) return [];

    // Convert to lowercase
    let normalized = text.toLowerCase();

    // Split by separators
    let words = normalized.split(SEPARATOR).filter(w => {
      if (!w) return false;
      if (w.length < minLength) return false;
      if (!/\w/.test(w)) return false;
      return true;
    });

    // Remove stop words (English + French)
    words = stopword.removeStopwords(words, [...stopword.en, ...stopword.fr]);

    // Remove duplicates
    words = [...new Set(words)];

    this.syslog(`Processed ${words.length} unique words`);
    return words;
  }

  /**
   * 
   * Main parsing logic
   */
  async parse(node) {
    const mfs_dir = resolve(node.mfs_root, node.id);
    const index = join(mfs_dir, `index.txt`);
    const src = resolve(mfs_dir, `orig.${node.extension}`);

    let text = '';

    try {
      // Get file attributes
      const attr = await this.db.await_proc('mfs_access_node', node.uid, node.id);
      if (!attr) {
        throw new Error('File not found in database');
      }

      // Extract text based on file type
      switch (node.extension.toLowerCase()) {
        // PDF
        case 'pdf':
          text = await this.extractFromPdf(src, index);
          break;

        // Office Documents
        case 'doc':
        case 'docx':
        case 'xls':
        case 'xlsx':
        case 'ppt':
        case 'pptx':
        case 'odt':
        case 'odp':
          // Convert to PDF first
          const pdfPath = await this.convertToPdf(node);
          text = await this.extractFromPdf(pdfPath, index);
          break;

        // Plain Text
        case 'txt':
        case 'html':
        case 'csv':
        case 'json':
        case 'log':
        case 'md':
          if (existsSync(src)) {
            text = readFileSync(src, 'utf8');
            writeFileSync(index, text, 'utf8');
          } else {
            throw new Error(`Source file not found: ${src}`);
          }
          break;

        // Images (OCR)
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
        case 'bmp':
          text = await this.extractFromImage(src, index);
          break;

        default:
          throw new Error(`Unsupported file extension: ${node.extension}`);
      }

      // Validate extraction
      if (!text || text.trim().length === 0) {
        throw new Error('No text extracted from file');
      }

      // Process words
      let words = this.processWords(text);

      if (words.length === 0) {
        throw new Error('No meaningful words found');
      }

      // Add filepath words
      if (attr.file_path) {
        const pathWords = attr.file_path
          .split(/[\/\\]+/)
          .flatMap(segment => this.processWords(segment, 2));
        words = [...new Set([...words, ...pathWords])];
      }

      // Prepare data for database
      let data = words.map(w => ({
        word: w,
        hub_id: node.hub_id,
        nid: node.id
      }));

      this.syslog(`Indexing ${data.length} words...`);

      // Store in database
      await this.db.await_proc("seo_index", JSON.stringify(data));
      await this.db.await_proc("seo_register", node.hub_id, node.id, JSON.stringify(attr));

      // Update info.json with index timestamp
      const info = join(mfs_dir, 'info.json');
      if (existsSync(info)) {
        try {
          let json = readJson(info);
          json.index = new Date().getTime();
          json.words = words.length;
          writeJson(info, json);
        } catch (e) {
          this.syslog('Failed to update info.json:', e.message);
        }
      }

      this.syslog(`Successfully indexed ${node.filename}: ${data.length} words`);

    } catch (e) {
      this.syslog('Parsing error:', e.message);
      throw e;
    }
  }
}

new __seo_indexer();
module.exports = __seo_indexer;
