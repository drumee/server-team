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

/**
 * SEO Indexing Library
 * 
 * Extracted from seo.js for use in Bull Queue workers
 * Contains all text extraction and indexing logic
 */

const { resolve, join } = require('path');
const { existsSync, writeFileSync, readFileSync } = require("fs");
const { readFileSync: readJson, writeFileSync: writeJson } = require('jsonfile');
const { exec } = require("shelljs");
// Text processing
const SEPARATOR = /[ ,.:;?!\/\-\_\$\&\'\"\\|\@=+\t\n\r\f\)\(\[\]\'\`]+/;
const stopword = require('stopword');

// OCR
/** 
 * Disabled due to security issue 
 * Maybe switching to AI solution ?
*/
// const tesseract = require("node-tesseract-ocr");

const { remove_item } = require('@drumee/server-core').MfsTools;
const { Mariadb, sysEnv, nullValue } = require('@drumee/server-essentials');
const { PDFiumLibrary } = require("@hyzyla/pdfium");
const { data_dir } = sysEnv();

/**
 * SEO Indexing Class
 */
class SeoIndexer {
  constructor(node, options = {}) {
    node.mfs_root = node.xpath.replace(new RegExp('/data_dir/'), data_dir) /** Retrieve reall data dir */
    this.node = node;
    this.options = options;
    this.tempFiles = [];

    // Setup database connection
    let db_name = node.actual_db || node.db_name || node.xdb;
    if (!db_name) {
      throw new Error('No database name provided');
    }

    this.db = new Mariadb({ name: db_name });
    this.db = this.db.bind(this)
  }

  /**
   * Log message (compatible with Bull job.log)
   */
  log(message, ...args) {
    const msg = `[SeoIndexer] ${message}`;
    if (this.options.jobLog) {
      this.options.jobLog(msg);
    }
    console.log(msg, ...args);
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
      join(mfs_dir, 'jpgout'),
      join(mfs_dir, 'pdf_pages')
    ];

    for (let file of tempFiles) {
      try {
        if (existsSync(file)) {
          remove_item(file, 1);
        }
      } catch (e) {
        this.log(`Cleanup failed for ${file}:`, e.message);
      }
    }
  }

  /**
   * Execute shell command with timeout
   */
  execCommand(cmd, timeout = 60000) {
    try {
      const { stdout, stderr } = exec(cmd, { timeout });
      if (stderr && !stderr.includes('Warning')) {
        this.log('Command stderr:', stderr);
      }
      return stdout;
    } catch (e) {
      this.log('Failed to run:', cmd);
      throw new Error(`Command failed: **${e.message}**`, e);
    }
  }

  /**
   * Extract text from image using OCR
   */
  async extractFromImage(src, index) {
    if (!existsSync(src)) {
      throw new Error(`Source file not found: ${src}`);
    }

    this.log(`Extracting text from image: ${src}`);

    const config = {
      lang: "eng+fra",
      oem: 1,
      psm: 3
    };

    try {
      const text = await tesseract.recognize(src, config);

      if (!text || text.trim().length === 0) {
        this.log('OCR produced no text');
        return '';
      }

      writeFileSync(index, text, 'utf8');
      this.log(`OCR extracted ${text.length} characters`);
      return text;

    } catch (e) {
      throw new Error(`OCR failed: ${e.message}`);
    }
  }


  /**
  * Extract text from PDF using pdfjs-dist
  */
  async extractFromPdf(src, index) {
    if (!existsSync(src)) {
      throw new Error(`PDF file not found: ${src}`);
    }

    this.log(`Extracting text from PDF: ${src}`);

    try {
      const buff = await readFileSync(src);

      // Initialize the library
      const library = await PDFiumLibrary.init();

      // Load the document from the buffer
      const document = await library.loadDocument(buff);

      // Extract text from all pages
      let text = '';
      for (const page of document.pages()) {
        console.log(`Page ${page.number + 1}:`);
        text = text + page.getText();
      }

      writeFileSync(index, text, 'utf8');
      if (existsSync(index)) {
        return text
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
   * Convert PDF to images and OCR (placeholder - requires pdf2image)
   */
  async pdfToImageOCR(src, index) {
    try {
      // Check if pdf2image is available
      try {
        this.execCommand('python3 -c "import pdf2image"', 5000);
      } catch (e) {
        throw new Error('PDF OCR requires pdf2image Python library. Install: pip3 install pdf2image');
      }

      const mfs_dir = resolve(this.node.mfs_root, this.node.id);
      const outputDir = join(mfs_dir, 'pdf_pages');
      mkdirSync(outputDir, { recursive: true });

      // Convert PDF to images
      const cmd = `python3 -c "
  from pdf2image import convert_from_path
  images = convert_from_path('${src}', dpi=300, output_folder='${outputDir}', fmt='jpg')
  print(f'Converted {len(images)} pages')
  "`;

      this.execCommand(cmd, 120000);

      // OCR first page only
      const firstPage = join(outputDir, '0000001.jpg');
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

    if (existsSync(pdfPath)) {
      this.log('Using existing preview.pdf');
      return pdfPath;
    }

    this.log('Converting to PDF...');

    const cmd = resolve(__dirname, 'to-pdf.js');
    const args = {
      node,
      uid: this.options.uid,
      noSocket: 1
    };

    try {
      this.execCommand(`${cmd} '${JSON.stringify(args)}'`, 180000);

      // Wait for file to appear
      let attempts = 0;
      while (!existsSync(pdfPath) && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      if (!existsSync(pdfPath)) {
        throw new Error('PDF conversion timeout');
      }
      return pdfPath;

    } catch (e) {
      throw new Error(`Office conversion failed: ${e.message}`, e);
    }
  }

  /**
   * Tokenize and clean words
   */
  processWords(text, minLength = 3) {
    if (!text) return [];

    let normalized = text.toLowerCase();
    let words = normalized.split(SEPARATOR).filter(w => {
      if (!w) return false;
      if (w.length < minLength) return false;
      if (!/\w/.test(w)) return false;
      return true;
    });

    // Remove stop words
    words = stopword.removeStopwords(words, [...stopword.en, ...stopword.fr]);

    // Remove duplicates
    words = [...new Set(words)];

    this.log(`Processed ${words.length} unique words`);
    return words;
  }

  /**
   * Main indexing function
   */
  async index() {
    const node = this.node;
    const mfs_dir = resolve(node.mfs_root, node.id);
    const index = join(mfs_dir, `index.txt`);
    const src = resolve(mfs_dir, `orig.${node.extension}`);

    let text = '';
    const startTime = Date.now();

    try {
      // Get file attributes
      const attr = await this.db.await_proc('mfs_access_node', node.uid, node.id);
      if (!attr) {
        throw new Error('File not found in database');
      }

      // Extract text based on file type
      const ext = node.extension.toLowerCase();

      switch (ext) {
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
          throw new Error(`Unsupported file extension: ${ext}`);
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

      this.log(`Indexing ${data.length} words...`);

      // Store in database
      await this.db.await_proc("seo_index", JSON.stringify(data));
      await this.db.await_proc("seo_register", node.hub_id, node.id, JSON.stringify(attr));

      // Update info.json
      const info = join(mfs_dir, 'index_seo.json');
      if (existsSync(info)) {
        try {
          let json = readJson(info);
          json.index = new Date().getTime();
          json.words = words.length;
          writeJson(info, json);
        } catch (e) {
          this.log('Failed to update info.json:', e.message);
        }
      }

      const duration = Date.now() - startTime;
      this.log(`Successfully indexed ${node.filename}: ${data.length} words in ${duration}ms`, info);

      return {
        success: true,
        filename: node.filename,
        words: data.length,
        duration,
        extension: ext
      };

    } catch (e) {
      this.log('Indexing error:', e.message);
      throw e;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Close database connection
   */
  async close() {
    try {
      if (this.db && this.db.end) {
        await this.db.end();
      }
    } catch (e) {
      this.log('Error closing database:', this.db.connection, e.message);
    }
  }
}

/**
 * Standalone function for worker use
 * 
 * @param {Object} node - File node from MFS
 * @param {Object} options - Options (uid, jobLog, etc)
 * @returns {Promise<Object>} - Result object
 */
async function indexFile(node, options = {}) {
  const indexer = new SeoIndexer(node, options);

  try {
    const result = await indexer.index(node);
    await indexer.close();
    return result;
  } catch (error) {
    await indexer.close();
    throw error;
  }
}

module.exports = {
  SeoIndexer,
  indexFile
};