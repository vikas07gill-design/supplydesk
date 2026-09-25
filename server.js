require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const mysql = require("mysql2/promise");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, "private-uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "supplydesk",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4"
});

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const applicationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions. Please try again later." }
});

const allowedDocTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const applicationId = req.applicationId || crypto.randomUUID();
    req.applicationId = applicationId;
    const dir = path.join(UPLOAD_DIR, applicationId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    files: 12,
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!allowedDocTypes.has(file.mimetype)) {
      return cb(new Error("Only PDF, JPG, PNG and WEBP files are allowed."));
    }
    cb(null, true);
  }
});

const catalog = {
  "Raw Materials": ["Metals","Minerals","Polymers","Industrial Raw Materials"],
  "Plastics & Packaging": ["Plastic Containers","Plastic Bottles","Packaging Films","Plastic Components"],
  "Machinery": ["Injection Moulding Machines","CNC Machines","Packaging Machines","Industrial Machinery"],
  "Electronics & Components": ["Electronic Components","PCB","Power Supplies","Sensors"],
  "Automotive": ["Auto Components","Accessories","Aftermarket Parts"],
  "Textiles & Apparel": ["Fabrics","Garments","Home Textiles"],
  "Food & Agriculture": ["Food Ingredients","Agri Products","Processed Food"],
  "Chemicals": ["Industrial Chemicals","Specialty Chemicals","Cleaning Chemicals"],
  "Consumer Products": ["Household Products","Kitchenware","Personal Care"],
  "Construction Materials": ["Building Materials","Tiles & Surfaces","Plumbing Products"],
  "Logistics & Freight": ["Sea Freight","Air Freight","Road Transport","Freight Forwarding"],
  "Warehousing & Fulfilment": ["Warehousing","Consolidation","Fulfilment"],
  "Customs & Trade": ["Customs Clearance","Trade Documentation","Import Export Support"],
  "Inspection & Verification": ["Factory Inspection","Pre-shipment Inspection","Quality Inspection"],
  "Insurance": ["Cargo Insurance","Transit Insurance","Trade Insurance"],
  "Trade Finance": ["Trade Finance","Letter of Credit","Working Capital"],
  "Sourcing Services": ["Product Sourcing","Supplier Discovery","Procurement Support"],
  "Professional Services": ["Consulting","Accounting & Tax","Legal Services"],
  "Industrial Equipment": ["Process Equipment","Material Handling","Plant Equipment"],
  "Electrical Equipment": ["Electrical Components","Switchgear","Industrial Controls"],
  "Tools & Hardware": ["Hand Tools","Power Tools","Hardware"],
  "Metal Products": ["Steel Products","Aluminium Products","Fabricated Parts"],
  "Industrial Components": ["Bearings","Fasteners","Seals"],
  "Manufacturing Services": ["Contract Manufacturing","Assembly","Fabrication"]
};

const categories = Object.keys(catalog);

function clean(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_TOKEN || "").trim();
  const received = String(req.get("x-admin-token") || "").trim();
  if (!expected || received.length !== expected.length || received.length < 20 || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function safeDeleteApplicationFiles(applicationId) {
  const dir = path.join(UPLOAD_DIR, applicationId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

app.get("/api/admin/token-check", (req, res) => {
  const expected = String(process.env.ADMIN_TOKEN || "").trim();
  const received = String(req.get("x-admin-token") || "").trim();
  res.json({
    adminTokenConfigured: Boolean(expected),
    configuredLength: expected.length,
    receivedLength: received.length,
    minimumRequiredLength: 20,
    headerReceived: Boolean(received)
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.get("/api/categories", (req, res) => {
  res.json({ categories, subcategories: catalog });
});

app.post("/api/supplier-applications",
  applicationLimiter,
  (req, res, next) => upload.fields([
    { name: "registrationDoc", maxCount: 1 },
    { name: "taxDoc", maxCount: 1 },
    { name: "licenceDoc", maxCount: 1 },
    { name: "addressProof", maxCount: 1 },
    { name: "businessPhotos", maxCount: 8 }
  ])(req, res, next),
  async (req, res) => {
    const body = req.body || {};

    // Simple bot trap. The field is intentionally hidden in the frontend.
    if (clean(body.website_confirm, 100)) {
      return res.status(400).json({ error: "Invalid submission." });
    }

    const required = [
      "legalName","businessType","country","city","address",
      "email","phone","contact","category","subcategory"
    ];

    for (const key of required) {
      if (!clean(body[key], 500)) {
        return res.status(400).json({ error: "Please complete all required fields." });
      }
    }

    if (!catalog[body.category] || !catalog[body.category].includes(body.subcategory)) {
      return res.status(400).json({ error: "Invalid category or sub-category." });
    }

    const email = clean(body.email, 255);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid business email." });
    }

    const year = body.year ? Number(body.year) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1800 || year > new Date().getFullYear())) {
      return res.status(400).json({ error: "Please enter a valid year established." });
    }

    const applicationId = req.applicationId || crypto.randomUUID();
    const files = req.files || {};
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      await conn.execute(
        `INSERT INTO supplier_applications
        (id, legal_name, trade_name, business_type, year_established, country, city, address,
         business_email, business_phone, contact_person, designation, registration_number,
         tax_number, import_export_number, website, certification_details, category, subcategory,
         requested_category, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'under_review')`,
        [
          applicationId,
          clean(body.legalName, 255),
          clean(body.tradeName, 255) || null,
          clean(body.businessType, 100),
          year,
          clean(body.country, 100),
          clean(body.city, 150),
          clean(body.address, 4000),
          email,
          clean(body.phone, 80),
          clean(body.contact, 180),
          clean(body.designation, 150) || null,
          clean(body.regNo, 180) || null,
          clean(body.taxNo, 180) || null,
          clean(body.tradeNo, 180) || null,
          clean(body.website, 500) || null,
          clean(body.certs, 4000) || null,
          clean(body.category, 180),
          clean(body.subcategory, 180),
          clean(body.requestText, 1000) || null
        ]
      );

      const fileRows = [];
      const saveFiles = (field, type) => {
        for (const file of files[field] || []) {
          const relative = path.relative(UPLOAD_DIR, file.path).split(path.sep).join("/");
          fileRows.push([
            crypto.randomUUID(),
            applicationId,
            type,
            clean(file.originalname, 255),
            path.basename(file.path),
            relative,
            file.mimetype,
            file.size
          ]);
        }
      };

      saveFiles("registrationDoc", "business_registration");
      saveFiles("taxDoc", "tax_registration");
      saveFiles("licenceDoc", "licence_certificate");
      saveFiles("addressProof", "address_proof");
      saveFiles("businessPhotos", "business_photo");

      if (fileRows.length) {
        await conn.query(
          `INSERT INTO supplier_files
          (id, application_id, file_type, original_name, stored_name, relative_path, mime_type, file_size)
          VALUES ?`,
          [fileRows]
        );
      }

      await conn.execute(
        "INSERT INTO supplier_verification (application_id) VALUES (?)",
        [applicationId]
      );

      await conn.commit();
      res.status(201).json({
        ok: true,
        applicationId,
        status: "under_review",
        message: "Your application has been submitted for verification."
      });
    } catch (error) {
      await conn.rollback();
      safeDeleteApplicationFiles(applicationId);
      console.error("Supplier submission failed:", error);
      res.status(500).json({ error: "Could not save the application. Please try again." });
    } finally {
      conn.release();
    }
  }
);

app.get("/api/suppliers", async (req, res) => {
  const q = clean(req.query.q, 200).toLowerCase();
  const category = clean(req.query.category, 180);
  const country = clean(req.query.country, 100);
  const city = clean(req.query.city, 150);

  let sql = `SELECT id, legal_name, trade_name, business_type, country, city, website,
                    business_email, business_phone, category, subcategory
             FROM supplier_profiles
             WHERE verified = 1 AND published = 1`;
  const params = [];

  if (category) { sql += " AND category = ?"; params.push(category); }
  if (country) { sql += " AND country = ?"; params.push(country); }
  if (city) { sql += " AND city = ?"; params.push(city); }

  if (q) {
    sql += " AND (LOWER(legal_name) LIKE ? OR LOWER(COALESCE(trade_name,'')) LIKE ? OR LOWER(category) LIKE ? OR LOWER(subcategory) LIKE ? OR LOWER(country) LIKE ? OR LOWER(city) LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }

  sql += " ORDER BY updated_at DESC LIMIT 200";

  try {
    const [rows] = await pool.execute(sql, params);
    res.json({
      suppliers: rows.map(x => ({
        id: x.id,
        name: x.trade_name || x.legal_name,
        type: "supplier",
        city: x.city,
        country: x.country,
        market: "Listed Business",
        desc: `${x.business_type} in ${x.category} · ${x.subcategory}`,
        category: x.category,
        subcategories: [x.subcategory],
        tags: [x.business_type, x.category, x.subcategory],
        verified: true
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load suppliers." });
  }
});

app.get("/api/suppliers/:id", async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      `SELECT id, legal_name, trade_name, business_type, country, city, address, website,
              business_email, business_phone, contact_person, designation, category, subcategory,
              verified, published
       FROM supplier_profiles
       WHERE id = ? AND verified = 1 AND published = 1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Supplier not found." });
    res.json({ supplier: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load supplier." });
  }
});

app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  const status = clean(req.query.status, 40);
  const allowed = ["submitted","under_review","query","approved","rejected","suspended"];
  const params = [];
  let sql = `SELECT id, legal_name, trade_name, business_type, country, city, business_email,
                    category, subcategory, status, submitted_at, reviewed_at
             FROM supplier_applications`;

  if (allowed.includes(status)) {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY submitted_at DESC LIMIT 200";

  try {
    const [rows] = await pool.execute(sql, params);
    res.json({ applications: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load applications." });
  }
});

app.get("/api/admin/files/:id", requireAdmin, async (req, res) => {
  try {
    const [[file]] = await pool.execute(
      "SELECT stored_name, relative_path, original_name, mime_type FROM supplier_files WHERE id = ?",
      [req.params.id]
    );
    if (!file) return res.status(404).json({ error: "File not found." });

    const absolute = path.resolve(UPLOAD_DIR, file.relative_path);
    const root = path.resolve(UPLOAD_DIR);
    if (!absolute.startsWith(root + path.sep) || !fs.existsSync(absolute)) {
      return res.status(404).json({ error: "File not found." });
    }

    res.setHeader("Content-Type", file.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${file.original_name.replace(/["\\]/g, "")}"`);
    res.sendFile(absolute);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not open file." });
  }
});

app.get("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  try {
    const [[application]] = await pool.execute(
      "SELECT * FROM supplier_applications WHERE id = ?",
      [req.params.id]
    );
    if (!application) return res.status(404).json({ error: "Application not found." });

    const [files] = await pool.execute(
      "SELECT id, file_type, original_name, mime_type, file_size, created_at FROM supplier_files WHERE application_id = ? ORDER BY created_at",
      [req.params.id]
    );
    const [[verification]] = await pool.execute(
      "SELECT * FROM supplier_verification WHERE application_id = ?",
      [req.params.id]
    );
    res.json({ application, files, verification });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load application." });
  }
});

app.patch("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  const status = clean(req.body?.status, 40);
  const notes = clean(req.body?.adminNotes, 4000);
  const allowed = ["under_review","query","approved","rejected","suspended"];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[application]] = await conn.execute(
      "SELECT * FROM supplier_applications WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!application) {
      await conn.rollback();
      return res.status(404).json({ error: "Application not found." });
    }

    await conn.execute(
      "UPDATE supplier_applications SET status = ?, admin_notes = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ?",
      [status, notes || null, "admin", req.params.id]
    );

    if (status === "approved") {
      await conn.execute(
        `INSERT INTO supplier_profiles
        (id, application_id, legal_name, trade_name, business_type, country, city, address,
         website, business_email, business_phone, contact_person, designation, category, subcategory,
         verified, published)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
        ON DUPLICATE KEY UPDATE
          legal_name=VALUES(legal_name), trade_name=VALUES(trade_name), business_type=VALUES(business_type),
          country=VALUES(country), city=VALUES(city), address=VALUES(address), website=VALUES(website),
          business_email=VALUES(business_email), business_phone=VALUES(business_phone),
          contact_person=VALUES(contact_person), designation=VALUES(designation),
          category=VALUES(category), subcategory=VALUES(subcategory), verified=1, published=1`,
        [
          crypto.randomUUID(),
          req.params.id,
          application.legal_name,
          application.trade_name,
          application.business_type,
          application.country,
          application.city,
          application.address,
          application.website,
          application.business_email,
          application.business_phone,
          application.contact_person,
          application.designation,
          application.category,
          application.subcategory
        ]
      );
    } else {
      await conn.execute(
        "UPDATE supplier_profiles SET verified = 0, published = 0 WHERE application_id = ?",
        [req.params.id]
      );
    }

    await conn.commit();
    res.json({ ok: true, status });
  } catch (error) {
    await conn.rollback();
    console.error(error);
    res.status(500).json({ error: "Could not update application." });
  } finally {
    conn.release();
  }
});

app.use(express.static(ROOT, {
  index: "index.html",
  extensions: ["html"]
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Each file must be 10 MB or smaller." : "Upload limit reached." });
  }
  if (err?.message?.includes("Only PDF")) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`SupplyDesk running on port ${PORT}`);
});
