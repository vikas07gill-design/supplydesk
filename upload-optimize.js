"use strict";
/**
 * Post-upload optimisation for supplier documents.
 *  - Verifies the real file type from its magic bytes (the browser-sent mimetype is not trusted).
 *  - Images -> resized (max 1800px) + WebP. PDFs -> Ghostscript (/ebook) or, if missing, qpdf (lossless).
 *  - Never makes a file bigger: if the result is not smaller the original is kept.
 *  - Fail-safe: if a tool is missing/crashes the original file is kept (only a bad/mismatched file is rejected).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

let sharp = null;
try { sharp = require("sharp"); sharp.cache(false); sharp.concurrency(1); } catch { sharp = null; }

const IMG_MAX_PX = Number(process.env.UPLOAD_IMAGE_MAX_PX || 1800);
const IMG_QUALITY = Number(process.env.UPLOAD_IMAGE_QUALITY || 78);
const PDF_TIMEOUT_MS = Number(process.env.UPLOAD_PDF_TIMEOUT_MS || 60000);
const GS_BIN = process.env.GS_BIN || "gs";
const QPDF_BIN = process.env.QPDF_BIN || "qpdf";

class UploadError extends Error {}

function sniff(p) {
  const fd = fs.openSync(p, "r"); const b = Buffer.alloc(12);
  try { fs.readSync(fd, b, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return "webp";
  if (b.slice(0, 5).toString() === "%PDF-") return "pdf";
  return null;
}
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

function run(bin, args) {
  return new Promise(resolve => execFile(bin, args, { timeout: PDF_TIMEOUT_MS, windowsHide: true }, err => resolve(!err)));
}
const size = p => fs.statSync(p).size;
const rm = p => { try { fs.rmSync(p, { force: true }); } catch {} };

async function optimizeImage(file) {
  if (!sharp) return null;
  const out = path.join(path.dirname(file.path), crypto.randomUUID() + ".webp");
  try {
    await sharp(file.path, { failOn: "error", limitInputPixels: 120e6, animated: false })
      .rotate().resize({ width: IMG_MAX_PX, height: IMG_MAX_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: IMG_QUALITY, effort: 4 }).toFile(out);
  } catch (e) { rm(out); throw new UploadError("This image could not be read. Please upload a valid JPG, PNG or WEBP file."); }
  return out;
}

async function optimizePdf(file) {
  const dir = path.dirname(file.path); const cands = [];
  const gsOut = path.join(dir, crypto.randomUUID() + ".gs.pdf");
  if (await run(GS_BIN, ["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/ebook", "-dDetectDuplicateImages=true",
    "-dDownsampleColorImages=true", "-dDownsampleGrayImages=true", "-dColorImageResolution=150", "-dGrayImageResolution=150",
    "-dColorImageDownsampleThreshold=1.0", "-dGrayImageDownsampleThreshold=1.0",
    "-dAutoFilterColorImages=false", "-dAutoFilterGrayImages=false", "-dColorImageFilter=/DCTEncode", "-dGrayImageFilter=/DCTEncode", "-dJPEGQ=70",
    "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER", "-sOutputFile=" + gsOut, file.path]) && fs.existsSync(gsOut) && size(gsOut) > 0 && sniff(gsOut) === "pdf") cands.push(gsOut); else rm(gsOut);
  const base = cands[0] || file.path;
  const qOut = path.join(dir, crypto.randomUUID() + ".q.pdf");
  if (await run(QPDF_BIN, ["--object-streams=generate", "--recompress-flate", "--compression-level=9", base, qOut]) && fs.existsSync(qOut) && size(qOut) > 0 && sniff(qOut) === "pdf") cands.push(qOut); else rm(qOut);
  let best = null;
  for (const c of cands) if (!best || size(c) < size(best)) best = c;
  for (const c of cands) if (c !== best) rm(c);
  return best;
}

/** Optimise one multer file in place (path/filename/mimetype/size). Throws UploadError for bad files. */
async function optimizeFile(file, { allowPdf = true } = {}) {
  const kind = sniff(file.path);
  if (!kind || (kind === "pdf" && !allowPdf)) throw new UploadError("Only PDF, JPG, PNG and WEBP files are allowed.");
  const declared = file.mimetype;
  if (MIME[kind] !== declared) throw new UploadError("File content does not match its type (" + String(file.originalname || "").slice(0, 80) + ").");
  const before = file.size;
  let out = null;
  try { out = kind === "pdf" ? await optimizePdf(file) : await optimizeImage(file); }
  catch (e) { if (e instanceof UploadError) throw e; console.error("Upload optimisation failed, keeping original:", e.message); }
  if (out && size(out) < before) {
    const orig = file.path;
    if (kind === "pdf") { const clean = path.join(path.dirname(out), crypto.randomUUID() + ".pdf"); fs.renameSync(out, clean); out = clean; }
    file.path = out; file.filename = path.basename(out); file.size = size(out);
    if (kind !== "pdf") file.mimetype = "image/webp";
    rm(orig);
    console.log("Upload optimised:", kind, before, "->", file.size, "bytes");
  } else if (out) rm(out);
  return file;
}

// Small global queue so a burst of uploads cannot starve a shared host.
let active = 0; const waiting = [];
const acquire = () => new Promise(r => { if (active < 2) { active++; r(); } else waiting.push(r); });
const release = () => { const n = waiting.shift(); if (n) n(); else active--; };

/** Express middleware factory: run after multer. */
function optimizeUploads({ allowPdf = true } = {}) {
  return async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
    if (!files.length) return next();
    await acquire();
    try { for (const f of files) await optimizeFile(f, { allowPdf }); next(); }
    catch (e) {
      for (const f of files) rm(f.path);
      if (e instanceof UploadError) return res.status(400).json({ error: e.message });
      console.error("Upload processing failed:", e); res.status(500).json({ error: "Could not process the uploaded file." });
    } finally { release(); }
  };
}

module.exports = { optimizeUploads, optimizeFile, sniff, UploadError };
