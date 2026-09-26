require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");

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
const connectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many connection requests. Please try again later." }
});

const supplierUpdateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many update requests. Please try again later." }
});

const supplierDashboardLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many dashboard access requests. Please try again later." }
});

function dashboardTokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function requireSupplierDashboard(req, res, next) {
  const rawToken = clean(req.get("x-supplier-dashboard-token"), 128);
  if (!rawToken) return res.status(401).json({ error: "Dashboard access required." });
  try {
    const [[supplier]] = await pool.execute(
      `SELECT s.id, s.application_id, s.legal_name, s.trade_name, s.business_type, s.country, s.city,
              s.address, s.website, s.business_email, s.business_phone, s.contact_person, s.designation,
              s.category, s.subcategory, s.profile_details_json, s.verified, s.published, t.id AS token_id, t.expires_at
       FROM supplier_dashboard_tokens t
       JOIN supplier_profiles s ON s.id = t.supplier_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL
         AND t.expires_at > NOW() AND s.verified = 1 AND s.published = 1`,
      [dashboardTokenHash(rawToken)]
    );
    if (!supplier) return res.status(401).json({ error: "Dashboard link is expired or invalid." });
    await pool.execute("UPDATE supplier_dashboard_tokens SET last_used_at=NOW() WHERE id=?", [supplier.token_id]);
    req.supplier = supplier;
    next();
  } catch (error) {
    console.error("Supplier dashboard auth failed:", error);
    res.status(500).json({ error: "Could not authenticate dashboard." });
  }
}

const updateStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const updateId = req.updateId || crypto.randomUUID();
    req.updateId = updateId;
    const dir = path.join(UPLOAD_DIR, "supplier-updates", updateId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const updateUpload = multer({
  storage: updateStorage,
  limits: { files: 12, fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedDocTypes.has(file.mimetype)) return cb(new Error("Only PDF, JPG, PNG and WEBP files are allowed."));
    cb(null, true);
  }
});

const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, "supplier-products", clean(req.params.id, 80));
    fs.mkdirSync(dir, { recursive: true }); cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const productImageUpload = multer({
  storage: productImageStorage,
  limits: { files: 6, fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!["image/jpeg","image/png","image/webp"].includes(file.mimetype)) return cb(new Error("Product images must be JPG, PNG or WEBP."));
    cb(null, true);
  }
});

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
});

async function ensureConnectRequestsTable() {
  await pool.execute("CREATE TABLE IF NOT EXISTS connect_requests (id CHAR(36) PRIMARY KEY, supplier_id CHAR(36) NOT NULL, customer_name VARCHAR(180) NOT NULL, customer_email VARCHAR(255) NOT NULL, customer_phone VARCHAR(80) NULL, product_name VARCHAR(255) NULL, source_action ENUM('phone','email','contact') NOT NULL DEFAULT 'contact', message TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT fk_connect_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE, INDEX idx_connect_supplier (supplier_id, created_at), INDEX idx_connect_customer (customer_email, created_at)) ENGINE=InnoDB");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function clean(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeEqual(a,b){
  const x=Buffer.from(String(a||"")), y=Buffer.from(String(b||""));
  return x.length===y.length && x.length>0 && crypto.timingSafeEqual(x,y);
}

async function getAdminSession(req){
  const token=clean(req.get("x-admin-token"),256);
  if(!token)return null;
  const [[session]]=await pool.execute(
    "SELECT id,role,admin_id FROM admin_sessions WHERE token_hash=? AND expires_at>NOW()",
    [tokenHash(token)]
  );
  if(session){
    await pool.execute("UPDATE admin_sessions SET last_used_at=NOW() WHERE id=?",[session.id]);
    return session;
  }
  const legacy=String(process.env.ADMIN_TOKEN||"").trim();
  if(legacy && safeEqual(token,legacy)) return {id:null,role:"admin",admin_id:"legacy-admin"};
  return null;
}

async function requireAdmin(req,res,next){
  try{
    const session=await getAdminSession(req);
    if(!session)return res.status(401).json({error:"Unauthorized"});
    req.admin=session; next();
  }catch(error){console.error("Admin auth failed:",error);res.status(500).json({error:"Could not authenticate admin."});}
}

async function requireSuperAdmin(req,res,next){
  try{
    const session=await getAdminSession(req);
    if(!session || session.role!=="super_admin")return res.status(403).json({error:"Super Admin access required."});
    req.admin=session; next();
  }catch(error){console.error("Super Admin auth failed:",error);res.status(500).json({error:"Could not authenticate Super Admin."});}
}

app.post("/api/admin/login", async (req,res)=>{
  const adminId=clean(req.body?.adminId,120);
  const password=String(req.body?.password||"");
  const normalId=String(process.env.ADMIN_ID||"").trim();
  const normalPassword=String(process.env.ADMIN_PASSWORD||"");
  const superId=String(process.env.SUPER_ADMIN_ID||"").trim();
  const superPassword=String(process.env.SUPER_ADMIN_PASSWORD||"");
  let role=null;
  if(superId && safeEqual(adminId,superId) && safeEqual(password,superPassword)) role="super_admin";
  else if(normalId && safeEqual(adminId,normalId) && safeEqual(password,normalPassword)) role="admin";
  else return res.status(401).json({error:"Invalid Admin ID or password."});
  const rawToken=crypto.randomBytes(32).toString("hex");
  await pool.execute("INSERT INTO admin_sessions (id,token_hash,role,admin_id,expires_at) VALUES (?,?,?,?,DATE_ADD(NOW(),INTERVAL 12 HOUR))",[crypto.randomUUID(),tokenHash(rawToken),role,adminId]);
  res.json({ok:true,token:rawToken,role,expiresInHours:12});
});

app.post("/api/admin/test-email", requireAdmin, async (req,res)=>{
  const recipient=clean(req.body?.recipient,255).toLowerCase() || String(process.env.SMTP_USER||"").trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(recipient)) return res.status(400).json({error:"A valid test email recipient is required."});
  if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM) {
    return res.status(503).json({error:"SMTP environment variables are not configured."});
  }
  try{
    const info=await mailer.sendMail({
      from:process.env.SMTP_FROM,
      to:recipient,
      subject:"SupplyDesk SMTP Test Email",
      text:[
        "This is a test email from SupplyDesk.",
        "",
        "SMTP connection and authentication are working correctly.",
        "Sent at: "+new Date().toISOString(),
        "Triggered by Admin: "+req.admin.admin_id
      ].join("\n")
    });
    res.json({ok:true,recipient,messageId:info.messageId});
  }catch(error){
    console.error("SMTP test email failed:",error);
    res.status(502).json({error:"SMTP test failed: "+(error?.code||"SEND_ERROR")+" "+(error?.responseCode||"")+" "+(error?.message||"Unknown SMTP error")});
  }
});

app.post("/api/admin/test-supplier-email", requireAdmin, async (req,res)=>{
  const supplierId=clean(req.body?.supplierId,80);
  if(!supplierId)return res.status(400).json({error:"Supplier ID is required."});
  try{
    const [[supplier]]=await pool.execute(
      "SELECT id,legal_name,trade_name,business_email,verified,published FROM supplier_profiles WHERE id=?",
      [supplierId]
    );
    if(!supplier)return res.status(404).json({error:"Supplier not found."});
    if(!supplier.verified || !supplier.published)return res.status(400).json({error:"Supplier is not verified/published."});
    if(!supplier.business_email)return res.status(400).json({error:"Supplier business email is missing."});
    const info=await mailer.sendMail({
      from:process.env.SMTP_FROM,
      to:supplier.business_email,
      subject:"SupplyDesk supplier email test",
      text:[
        "This is a test email from SupplyDesk.",
        "",
        "The supplier connection email channel is being tested.",
        "Supplier: "+(supplier.trade_name||supplier.legal_name),
        "Triggered by Admin: "+req.admin.admin_id,
        "Sent at: "+new Date().toISOString()
      ].join("\n")
    });
    const masked=supplier.business_email.replace(/^(.{2}).*(@.*)$/,"$1***$2");
    res.json({ok:true,supplier:supplier.trade_name||supplier.legal_name,recipient:masked,messageId:info.messageId});
  }catch(error){
    console.error("Supplier email test failed:",{
      supplierId,
      code:error?.code,
      responseCode:error?.responseCode,
      command:error?.command,
      response:error?.response,
      message:error?.message
    });
    res.status(502).json({error:"Supplier email test failed: "+(error?.code||"SEND_ERROR")+" "+(error?.responseCode||"")+" "+(error?.message||"Unknown SMTP error")});
  }
});

app.post("/api/admin/logout", requireAdmin, async (req,res)=>{
  const raw=clean(req.get("x-admin-token"),256);
  await pool.execute("DELETE FROM admin_sessions WHERE token_hash=?",[tokenHash(raw)]);
  res.json({ok:true});
});

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


app.post("/api/connect-requests", connectLimiter, async (req, res) => {
  const supplierId = clean(req.body?.supplierId, 80);
  const customerName = clean(req.body?.customerName, 180);
  const customerEmail = clean(req.body?.customerEmail, 255).toLowerCase();
  const customerPhone = clean(req.body?.customerPhone, 80) || null;
  const productName = clean(req.body?.productName, 255) || null;
  const sourceAction = ["phone","email","contact"].includes(req.body?.sourceAction) ? req.body.sourceAction : "contact";
  const message = clean(req.body?.message, 2000) || null;
  if (!supplierId || !customerName || !customerEmail) return res.status(400).json({ error: "Name and email are required." });
  if (!/^\S+@\S+\.\S+$/.test(customerEmail)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM) return res.status(503).json({ error: "Connection email service is not configured yet." });
  const requestId = crypto.randomUUID();
  try {
    const [[supplier]] = await pool.execute(
      "SELECT id, legal_name, trade_name, business_email, category, subcategory FROM supplier_profiles WHERE id = ? AND verified = 1 AND published = 1",
      [supplierId]
    );
    if (!supplier || !supplier.business_email) return res.status(404).json({ error: "Supplier contact is not available." });
    const supplierName = supplier.trade_name || supplier.legal_name;
    const subject = "SupplyDesk: New connection request" + (productName ? " for " + productName : "");
    const text = [
      "A customer wants to connect with " + supplierName + " through SupplyDesk.",
      "",
      "Customer: " + customerName,
      "Email: " + customerEmail,
      customerPhone ? "Mobile: " + customerPhone : "",
      productName ? "Product / requirement: " + productName : "Category: " + supplier.category + " / " + supplier.subcategory,
      message ? "Message: " + message : "",
      "",
      "Please contact the customer directly to continue the discussion.",
      "",
      "This connection was initiated on SupplyDesk.",
      "Request ID: " + requestId
    ].filter(Boolean).join("\n");
    await pool.execute(
      "INSERT INTO connect_requests (id, supplier_id, customer_name, customer_email, customer_phone, product_name, source_action, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [requestId, supplierId, customerName, customerEmail, customerPhone, productName, sourceAction, message]
    );
    try {
      const info = await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: supplier.business_email,
        replyTo: customerEmail,
        subject,
        text
      });
      console.log("Connection email sent:", {requestId, supplierId, to: supplier.business_email, messageId: info.messageId});
      return res.status(201).json({ ok: true, message: "Connection request sent to the supplier." });
    } catch (mailError) {
      console.error("Connection email delivery failed:", {
        requestId, supplierId, to: supplier.business_email,
        code: mailError?.code, responseCode: mailError?.responseCode, command: mailError?.command,
        response: mailError?.response, message: mailError?.message
      });
      return res.status(502).json({ error: "Connection request was saved, but the supplier email could not be delivered. Please try again.", requestId });
    }
  } catch (error) {
    console.error("Connection request failed:", {requestId, supplierId, code:error?.code, message:error?.message});
    res.status(500).json({ error: "Could not save the connection request. Please try again.", requestId });
  }
});


app.post("/api/supplier-update/request", supplierUpdateLimiter, async (req, res) => {
  const email = clean(req.body?.email, 255).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Please enter a valid business email address." });
  try {
    const [[supplier]] = await pool.execute(
      "SELECT id, legal_name, trade_name, business_email FROM supplier_profiles WHERE business_email = ? AND verified = 1 AND published = 1",
      [email]
    );
    if (!supplier) return res.json({ ok: true, message: "If the email belongs to a verified SupplyDesk supplier, an update link has been sent." });
    const rawToken = crypto.randomBytes(32).toString("hex");
    await pool.execute(
      "INSERT INTO supplier_update_tokens (id, supplier_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))",
      [crypto.randomUUID(), supplier.id, hashToken(rawToken)]
    );
    const origin = String(process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
    const link = origin + "/supplier-update.html?token=" + encodeURIComponent(rawToken);
    await mailer.sendMail({
      from: process.env.SMTP_FROM,
      to: supplier.business_email,
      subject: "SupplyDesk: Update your supplier profile",
      text: [
        "You requested to update your SupplyDesk supplier profile.",
        "",
        "Open this secure link within 30 minutes:",
        link,
        "",
        "Your current public profile will remain unchanged until SupplyDesk reviews and approves the update.",
        "",
        "If you did not request this, you can ignore this email."
      ].join("\n")
    });
    res.json({ ok: true, message: "If the email belongs to a verified SupplyDesk supplier, an update link has been sent." });
  } catch (error) {
    console.error("Supplier update link failed:", error);
    res.status(500).json({ error: "Could not send the update link. Please try again." });
  }
});

app.get("/api/supplier-update/:token", async (req, res) => {
  try {
    const tokenHash = hashToken(clean(req.params.token, 128));
    const [[row]] = await pool.execute(
      "SELECT t.id AS token_id, t.expires_at, t.used_at, s.id, s.legal_name, s.trade_name, s.business_type, s.country, s.city, s.address, s.business_email, s.business_phone, s.contact_person, s.designation, s.website, s.category, s.subcategory FROM supplier_update_tokens t JOIN supplier_profiles s ON s.id = t.supplier_id WHERE t.token_hash = ? AND s.verified = 1 AND s.published = 1",
      [tokenHash]
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "This update link has expired or has already been used." });
    res.json({ supplier: {
      id: row.id, legalName: row.legal_name, tradeName: row.trade_name, businessType: row.business_type,
      country: row.country, city: row.city, address: row.address, email: row.business_email,
      phone: row.business_phone, contact: row.contact_person, designation: row.designation,
      website: row.website, category: row.category, subcategory: row.subcategory
    }});
  } catch (error) {
    console.error("Supplier update lookup failed:", error);
    res.status(500).json({ error: "Could not load the supplier profile." });
  }
});

app.post("/api/supplier-update/:token", supplierUpdateLimiter,
  (req, res, next) => updateUpload.fields([
    { name: "registrationDoc", maxCount: 1 },
    { name: "taxDoc", maxCount: 1 },
    { name: "licenceDoc", maxCount: 1 },
    { name: "addressProof", maxCount: 1 },
    { name: "businessPhotos", maxCount: 8 }
  ])(req, res, next),
  async (req, res) => {
    const tokenHash = hashToken(clean(req.params.token, 128));
    try {
      const [[supplier]] = await pool.execute(
        "SELECT t.id AS token_id, t.used_at, t.expires_at, s.* FROM supplier_update_tokens t JOIN supplier_profiles s ON s.id=t.supplier_id WHERE t.token_hash=? AND s.verified=1 AND s.published=1",
        [tokenHash]
      );
      if (!supplier || supplier.used_at || new Date(supplier.expires_at).getTime() < Date.now()) return res.status(410).json({ error: "This update link has expired or has already been used." });
      const body=req.body||{};
      const fields={
        legal_name: clean(body.legalName,255), trade_name: clean(body.tradeName,255),
        business_type: clean(body.businessType,100), country: clean(body.country,100), city: clean(body.city,150),
        address: clean(body.address,4000), business_email: clean(body.email,255).toLowerCase(),
        business_phone: clean(body.phone,80), contact_person: clean(body.contact,180), designation: clean(body.designation,150),
        website: clean(body.website,500), category: clean(body.category,180), subcategory: clean(body.subcategory,180)
      };
      if (fields.business_email && !/^\S+@\S+\.\S+$/.test(fields.business_email)) return res.status(400).json({error:"Please enter a valid business email."});
      if (fields.category && (!catalog[fields.category] || !catalog[fields.category].includes(fields.subcategory))) return res.status(400).json({error:"Invalid category or sub-category."});
      const changes={};
      for (const [key,value] of Object.entries(fields)) if (value && String(value)!==String(supplier[key]||"")) changes[key]=value;
      if (!Object.keys(changes).length && !(req.files && Object.keys(req.files).length)) return res.status(400).json({error:"No changes or new documents were submitted."});
      const updateId=req.updateId || crypto.randomUUID();
      const fileRows=[];
      const saveFiles=(field,type)=>{ for(const file of (req.files?.[field]||[])){ const relative=path.relative(UPLOAD_DIR,file.path).split(path.sep).join("/"); fileRows.push([crypto.randomUUID(),updateId,type,clean(file.originalname,255),path.basename(file.path),relative,file.mimetype,file.size]); } };
      saveFiles("registrationDoc","business_registration"); saveFiles("taxDoc","tax_registration"); saveFiles("licenceDoc","licence_certificate"); saveFiles("addressProof","address_proof"); saveFiles("businessPhotos","business_photo");
      const conn=await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute("INSERT INTO supplier_update_requests (id,supplier_id,status,payload_json) VALUES (?,?,?,?)",[updateId,supplier.id,"pending",JSON.stringify(changes)]);
        if(fileRows.length) await conn.query("INSERT INTO supplier_update_files (id,update_id,file_type,original_name,stored_name,relative_path,mime_type,file_size) VALUES ?",[fileRows]);
        await conn.execute("UPDATE supplier_update_tokens SET used_at=NOW() WHERE id=?",[supplier.token_id]);
        await conn.commit();
      } catch(error) {
        await conn.rollback();
        const dir=path.join(UPLOAD_DIR,"supplier-updates",updateId);
        if(fs.existsSync(dir)) fs.rmSync(dir,{recursive:true,force:true});
        throw error;
      } finally { conn.release(); }
      res.status(201).json({ok:true,message:"Update submitted. Your current profile remains unchanged until SupplyDesk verifies and approves the changes."});
    } catch(error) {
      console.error("Supplier update submission failed:",error);
      res.status(500).json({error:"Could not submit the update. Please try again."});
    }
  }
);


app.post("/api/supplier-dashboard/request-access", supplierDashboardLimiter, async (req, res) => {
  const email = clean(req.body?.email, 255).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Please enter a valid business email address." });
  try {
    const [[supplier]] = await pool.execute(
      "SELECT id, legal_name, trade_name, business_email FROM supplier_profiles WHERE business_email=? AND verified=1 AND published=1",
      [email]
    );
    if (supplier) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await pool.execute(
        "INSERT INTO supplier_dashboard_tokens (id,supplier_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL 24 HOUR))",
        [crypto.randomUUID(), supplier.id, dashboardTokenHash(rawToken)]
      );
      const origin = String(process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
      const link = origin + "/supplier-dashboard.html?token=" + encodeURIComponent(rawToken);
      await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: supplier.business_email,
        subject: "SupplyDesk: Your supplier dashboard access",
        text: [
          "You requested access to your SupplyDesk supplier dashboard.",
          "",
          "Open this secure link within 24 hours:",
          link,
          "",
          "From the dashboard you can manage products, submit profile updates for review and view your SupplyDesk activity.",
          "",
          "If you did not request this, you can ignore this email."
        ].join("\n")
      });
    }
    res.json({ok:true,message:"If the email belongs to a verified SupplyDesk supplier, a dashboard link has been sent."});
  } catch(error) {
    console.error("Supplier dashboard access failed:",error);
    res.status(500).json({error:"Could not send the dashboard link. Please try again."});
  }
});

app.get("/api/supplier-dashboard", requireSupplierDashboard, async (req,res) => {
  try {
    const supplierId=req.supplier.id;
    const [[counts]]=await pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM supplier_products WHERE supplier_id=? AND status <> 'archived') AS product_count,
        (SELECT COUNT(*) FROM supplier_products WHERE supplier_id=? AND status='approved') AS approved_products,
        (SELECT COUNT(*) FROM supplier_products WHERE supplier_id=? AND status='pending') AS pending_products,
        (SELECT COUNT(*) FROM supplier_profile_views WHERE supplier_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS profile_views_30d,
        (SELECT COUNT(DISTINCT visitor_hash) FROM supplier_profile_views WHERE supplier_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS unique_visitors_30d,
        (SELECT COUNT(*) FROM connect_requests WHERE supplier_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS connections_30d`,
      [supplierId,supplierId,supplierId,supplierId,supplierId,supplierId]
    );
    const [products]=await pool.execute(
      "SELECT id,product_name,category,subcategory,description,moq,unit,market_scope,status,admin_notes,created_at,updated_at FROM supplier_products WHERE supplier_id=? AND status <> 'archived' ORDER BY updated_at DESC LIMIT 100",
      [supplierId]
    );
    const [connections]=await pool.execute(
      "SELECT id,customer_name,customer_email,customer_phone,product_name,source_action,message,created_at FROM connect_requests WHERE supplier_id=? ORDER BY created_at DESC LIMIT 20",
      [supplierId]
    );
    const [[pendingUpdate]]=await pool.execute(
      "SELECT id,status,submitted_at,admin_notes FROM supplier_update_requests WHERE supplier_id=? AND status IN ('pending','query') ORDER BY submitted_at DESC LIMIT 1",
      [supplierId]
    );
    res.json({
      supplier:{
        id:req.supplier.id,legal_name:req.supplier.legal_name,trade_name:req.supplier.trade_name,business_type:req.supplier.business_type,
        country:req.supplier.country,city:req.supplier.city,address:req.supplier.address,website:req.supplier.website,
        business_email:req.supplier.business_email,business_phone:req.supplier.business_phone,contact_person:req.supplier.contact_person,
        designation:req.supplier.designation,category:req.supplier.category,subcategory:req.supplier.subcategory,profileDetails:(()=>{try{return JSON.parse(req.supplier.profile_details_json||"{}")}catch{return {}}})(),verified:true
      },
      metrics:{
        product_count:Number(counts.product_count||0),approved_products:Number(counts.approved_products||0),
        pending_products:Number(counts.pending_products||0),profile_views_30d:Number(counts.profile_views_30d||0),
        unique_visitors_30d:Number(counts.unique_visitors_30d||0),connections_30d:Number(counts.connections_30d||0)
      },
      products,connections,pendingUpdate
    });
  } catch(error) {
    console.error("Supplier dashboard load failed:",error);
    res.status(500).json({error:"Could not load dashboard."});
  }
});

app.post("/api/supplier-dashboard/logout", requireSupplierDashboard, async (req,res) => {
  const rawToken=clean(req.get("x-supplier-dashboard-token"),128);
  await pool.execute("UPDATE supplier_dashboard_tokens SET revoked_at=NOW() WHERE token_hash=?",[dashboardTokenHash(rawToken)]);
  res.json({ok:true});
});

app.post("/api/supplier-dashboard/profile-update", requireSupplierDashboard, async (req,res) => {
  const allowed=["legal_name","trade_name","business_type","country","city","address","business_email","business_phone","contact_person","designation","website","category","subcategory"];
  const changes={};
  if(req.body?.profileDetails && typeof req.body.profileDetails==="object"){
    const d=req.body.profileDetails;
    changes.profile_details={
      about:clean(d.about,2000),capabilities:clean(d.capabilities,1500),industries:clean(d.industries,1000),
      markets:clean(d.markets,1000),monthlyCapacity:clean(d.monthlyCapacity,300),leadTime:clean(d.leadTime,300),
      paymentTerms:clean(d.paymentTerms,500),incoterms:clean(d.incoterms,500),shippingModes:clean(d.shippingModes,500),
      certifications:clean(d.certifications,1000),oem:clean(d.oem,100),customManufacturing:clean(d.customManufacturing,100)
    };
  }
  for(const key of allowed){
    if(req.body && Object.prototype.hasOwnProperty.call(req.body,key)){
      const value=clean(req.body[key], key==="address"?4000:500);
      if(value) changes[key]=value;
    }
  }
  if(changes.business_email && !/^\S+@\S+\.\S+$/.test(changes.business_email)) return res.status(400).json({error:"Please enter a valid business email."});
  if(changes.category && (!catalog[changes.category] || (changes.subcategory && !catalog[changes.category].includes(changes.subcategory)))) return res.status(400).json({error:"Invalid category or sub-category."});
  if(changes.subcategory && !catalog[changes.category || req.supplier.category]?.includes(changes.subcategory)) return res.status(400).json({error:"Invalid sub-category."});
  if(!Object.keys(changes).length) return res.status(400).json({error:"No changes submitted."});
  try{
    const id=crypto.randomUUID();
    await pool.execute(
      "INSERT INTO supplier_update_requests (id,supplier_id,status,payload_json) VALUES (?,?, 'pending', ?)",
      [id,req.supplier.id,JSON.stringify(changes)]
    );
    res.status(201).json({ok:true,message:"Profile changes submitted for SupplyDesk review. Your public profile will stay unchanged until approval."});
  }catch(error){
    console.error("Dashboard profile update failed:",error);
    res.status(500).json({error:"Could not submit profile update."});
  }
});

app.get("/api/supplier-dashboard/products", requireSupplierDashboard, async (req,res) => {
  const [products]=await pool.execute(
    "SELECT id,product_name,category,subcategory,description,moq,unit,market_scope,status,admin_notes,created_at,updated_at FROM supplier_products WHERE supplier_id=? AND status <> 'archived' ORDER BY updated_at DESC",
    [req.supplier.id]
  );
  const ids=products.map(p=>p.id); let files=[];
  if(ids.length){const ph=ids.map(()=>"?").join(",");[files]=await pool.execute("SELECT id,product_id,original_name,mime_type,file_size,status,created_at FROM supplier_product_files WHERE product_id IN ("+ph+") AND status <> 'archived' ORDER BY created_at",ids);}
  const by={};for(const f of files)(by[f.product_id] ||= []).push(f);for(const p of products)p.images=by[p.id]||[];
  res.json({products});
});

app.post("/api/supplier-dashboard/products", requireSupplierDashboard, async (req,res) => {
  const productName=clean(req.body?.product_name,255);
  const category=clean(req.body?.category,180);
  const subcategory=clean(req.body?.subcategory,180);
  const description=clean(req.body?.description,3000)||null;
  const moq=clean(req.body?.moq,120)||null;
  const unit=clean(req.body?.unit,80)||null;
  const marketScope=["Domestic","International","Both"].includes(req.body?.market_scope)?req.body.market_scope:"Both";
  if(!productName||!category||!subcategory) return res.status(400).json({error:"Product name, category and sub-category are required."});
  if(!catalog[category]||!catalog[category].includes(subcategory)) return res.status(400).json({error:"Invalid category or sub-category."});
  try{
    const id=crypto.randomUUID();
    await pool.execute(
      "INSERT INTO supplier_products (id,supplier_id,product_name,category,subcategory,description,moq,unit,market_scope,status) VALUES (?,?,?,?,?,?,?,?,?,'pending')",
      [id,req.supplier.id,productName,category,subcategory,description,moq,unit,marketScope]
    );
    res.status(201).json({ok:true,id,message:"Product submitted for SupplyDesk review."});
  }catch(error){
    console.error("Supplier product create failed:",error);
    res.status(500).json({error:"Could not add product."});
  }
});

app.patch("/api/supplier-dashboard/products/:id", requireSupplierDashboard, async (req,res) => {
  const id=clean(req.params.id,80);
  const [[product]]=await pool.execute("SELECT * FROM supplier_products WHERE id=? AND supplier_id=? AND status <> 'archived'",[id,req.supplier.id]);
  if(!product) return res.status(404).json({error:"Product not found."});
  const fields={};
  for(const key of ["product_name","category","subcategory","description","moq","unit"]){
    if(Object.prototype.hasOwnProperty.call(req.body||{},key)) fields[key]=clean(req.body[key], key==="description"?3000:500)||null;
  }
  if(Object.prototype.hasOwnProperty.call(req.body||{},"market_scope")) fields.market_scope=["Domestic","International","Both"].includes(req.body.market_scope)?req.body.market_scope:"Both";
  const category=fields.category||product.category, subcategory=fields.subcategory||product.subcategory;
  if(!catalog[category]||!catalog[category].includes(subcategory)) return res.status(400).json({error:"Invalid category or sub-category."});
  const keys=Object.keys(fields);
  if(!keys.length) return res.status(400).json({error:"No changes submitted."});
  const set=keys.map(k=>k+"=?").join(",");
  await pool.execute("UPDATE supplier_products SET "+set+", status='pending', admin_notes=NULL, reviewed_at=NULL, reviewed_by=NULL WHERE id=? AND supplier_id=?",[...keys.map(k=>fields[k]),id,req.supplier.id]);
  res.json({ok:true,message:"Product changes submitted for review."});
});

app.delete("/api/supplier-dashboard/products/:id", requireSupplierDashboard, async (req,res) => {
  const [result]=await pool.execute("UPDATE supplier_products SET status='archived' WHERE id=? AND supplier_id=?",[clean(req.params.id,80),req.supplier.id]);
  if(!result.affectedRows) return res.status(404).json({error:"Product not found."});
  res.json({ok:true});
});

app.post("/api/supplier-dashboard/products/:id/images", requireSupplierDashboard, (req,res,next)=>productImageUpload.array("productImages",6)(req,res,next), async (req,res)=>{
  const productId=clean(req.params.id,80);
  try{
    const [[product]]=await pool.execute("SELECT id FROM supplier_products WHERE id=? AND supplier_id=? AND status <> 'archived'",[productId,req.supplier.id]);
    if(!product){for(const f of (req.files||[]))fs.rmSync(f.path,{force:true});return res.status(404).json({error:"Product not found."});}
    if(!req.files?.length)return res.status(400).json({error:"Please select at least one product image."});
    const rows=req.files.map(f=>[crypto.randomUUID(),productId,clean(f.originalname,255),path.basename(f.path),path.relative(UPLOAD_DIR,f.path).split(path.sep).join("/"),f.mimetype,f.size,"pending"]);
    await pool.query("INSERT INTO supplier_product_files (id,product_id,original_name,stored_name,relative_path,mime_type,file_size,status) VALUES ?",[rows]);
    await pool.execute("UPDATE supplier_products SET status='pending',admin_notes=NULL,reviewed_at=NULL,reviewed_by=NULL WHERE id=? AND supplier_id=?",[productId,req.supplier.id]);
    res.status(201).json({ok:true,message:"Images uploaded. The product is back in review and will be published after SupplyDesk approval."});
  }catch(error){for(const f of (req.files||[]))fs.rmSync(f.path,{force:true});console.error(error);res.status(500).json({error:"Could not upload product images."});}
});

app.get("/api/supplier-dashboard/products/:productId/images/:imageId", requireSupplierDashboard, async (req,res)=>{
  try{
    const [[f]]=await pool.execute("SELECT f.relative_path,f.original_name,f.mime_type FROM supplier_product_files f JOIN supplier_products p ON p.id=f.product_id WHERE f.id=? AND f.product_id=? AND p.supplier_id=? AND f.status <> 'archived'",[clean(req.params.imageId,80),clean(req.params.productId,80),req.supplier.id]);
    if(!f)return res.status(404).json({error:"Image not found."});
    const absolute=path.resolve(UPLOAD_DIR,f.relative_path),root=path.resolve(UPLOAD_DIR);
    if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute))return res.status(404).json({error:"Image not found."});
    res.setHeader("Content-Type",f.mime_type);res.setHeader("Content-Disposition",`inline; filename="${f.original_name.replace(/["\\]/g,"")}"`);res.sendFile(absolute);
  }catch(error){res.status(500).json({error:"Could not load image."});}
});

app.delete("/api/supplier-dashboard/products/:productId/images/:imageId", requireSupplierDashboard, async (req,res)=>{
  try{
    const [[f]]=await pool.execute("SELECT f.id FROM supplier_product_files f JOIN supplier_products p ON p.id=f.product_id WHERE f.id=? AND f.product_id=? AND p.supplier_id=? AND f.status <> 'archived'",[clean(req.params.imageId,80),clean(req.params.productId,80),req.supplier.id]);
    if(!f)return res.status(404).json({error:"Image not found."});
    await pool.execute("UPDATE supplier_product_files SET status='archived' WHERE id=?",[f.id]);res.json({ok:true});
  }catch(error){res.status(500).json({error:"Could not remove image."});}
});

app.get("/api/products/:productId/images/:imageId", async (req,res)=>{
  try{
    const [[f]]=await pool.execute("SELECT f.relative_path,f.original_name,f.mime_type FROM supplier_product_files f JOIN supplier_products p ON p.id=f.product_id JOIN supplier_profiles s ON s.id=p.supplier_id WHERE f.id=? AND f.product_id=? AND f.status='approved' AND p.status='approved' AND s.verified=1 AND s.published=1",[clean(req.params.imageId,80),clean(req.params.productId,80)]);
    if(!f)return res.status(404).json({error:"Image not found."});
    const absolute=path.resolve(UPLOAD_DIR,f.relative_path),root=path.resolve(UPLOAD_DIR);
    if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute))return res.status(404).json({error:"Image not found."});
    res.setHeader("Content-Type",f.mime_type);res.setHeader("Content-Disposition",`inline; filename="${f.original_name.replace(/["\\]/g,"")}"`);res.sendFile(absolute);
  }catch(error){res.status(500).json({error:"Could not load image."});}
});

app.get("/api/admin/product-files/:id", requireAdmin, async (req,res)=>{
  try{
    const [[f]]=await pool.execute("SELECT relative_path,original_name,mime_type FROM supplier_product_files WHERE id=?",[clean(req.params.id,80)]);
    if(!f)return res.status(404).json({error:"Image not found."});
    const absolute=path.resolve(UPLOAD_DIR,f.relative_path),root=path.resolve(UPLOAD_DIR);
    if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute))return res.status(404).json({error:"Image not found."});
    res.setHeader("Content-Type",f.mime_type);res.setHeader("Content-Disposition",`inline; filename="${f.original_name.replace(/["\\]/g,"")}"`);res.sendFile(absolute);
  }catch(error){res.status(500).json({error:"Could not open image."});}
});

app.post("/api/suppliers/:id/view", async (req,res) => {
  const supplierId=clean(req.params.id,80);
  try{
    const [[supplier]]=await pool.execute("SELECT id FROM supplier_profiles WHERE id=? AND verified=1 AND published=1",[supplierId]);
    if(!supplier) return res.status(404).json({error:"Supplier not found."});
    const visitorHash=crypto.createHash("sha256").update(String(process.env.ADMIN_TOKEN||"")+"|"+String(req.ip||"")+"|"+String(req.get("user-agent")||"")).digest("hex");
    await pool.execute(
      "INSERT IGNORE INTO supplier_profile_views (id,supplier_id,visitor_hash,viewed_on) VALUES (?,?,?,CURRENT_DATE())",
      [crypto.randomUUID(),supplierId,visitorHash]
    );
    res.json({ok:true});
  }catch(error){
    console.error("Supplier view tracking failed:",error);
    res.status(500).json({error:"Could not record view."});
  }
});

app.get("/api/suppliers/:id/products", async (req,res) => {
  try{
    const [rows]=await pool.execute(
      "SELECT id,product_name,category,subcategory,description,moq,unit,market_scope FROM supplier_products WHERE supplier_id=? AND status='approved' ORDER BY updated_at DESC LIMIT 100",
      [clean(req.params.id,80)]
    );
    res.json({products:rows});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load supplier products."});}
});

app.get("/api/products", async (req,res) => {
  const q=clean(req.query.q,200).toLowerCase();
  const category=clean(req.query.category,180);
  const country=clean(req.query.country,100);
  const params=[];
  let sql=`SELECT p.id,p.product_name,p.category,p.subcategory,p.description,p.moq,p.unit,p.market_scope,
                   s.id AS supplier_id,s.legal_name,s.trade_name,s.business_type,s.country,s.city
            FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id
            WHERE p.status='approved' AND s.verified=1 AND s.published=1`;
  if(category){sql+=" AND p.category=?";params.push(category);}
  if(country){sql+=" AND s.country=?";params.push(country);}
  if(q){
    sql+=" AND (LOWER(p.product_name) LIKE ? OR LOWER(p.category) LIKE ? OR LOWER(p.subcategory) LIKE ? OR LOWER(COALESCE(p.description,'')) LIKE ? OR LOWER(s.legal_name) LIKE ? OR LOWER(COALESCE(s.trade_name,'')) LIKE ?)";
    const like="%"+q+"%"; params.push(like,like,like,like,like,like);
  }
  sql+=" ORDER BY p.updated_at DESC LIMIT 200";
  try{
    const [rows]=await pool.execute(sql,params);
    res.json({products:rows.map(p=>({
      id:p.id,name:p.product_name,type:"product",city:p.city,country:p.country,
      market:p.market_scope,desc:p.description||`${p.category} · ${p.subcategory}`,category:p.category,
      subcategories:[p.subcategory],tags:[p.category,p.subcategory,p.business_type],supplierId:p.supplier_id,
      supplierName:p.trade_name||p.legal_name,verified:true
    }))});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load products."});}
});

app.get("/api/products/:id", async (req,res) => {
  try{
    const [[p]]=await pool.execute(
      `SELECT p.id,p.product_name,p.category,p.subcategory,p.description,p.moq,p.unit,p.market_scope,
              s.id AS supplier_id,s.legal_name,s.trade_name,s.business_type,s.country,s.city,s.website
       FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id
       WHERE p.id=? AND p.status='approved' AND s.verified=1 AND s.published=1`,
      [req.params.id]
    );
    if(!p) return res.status(404).json({error:"Product not found."});
    const [images]=await pool.execute("SELECT id,original_name FROM supplier_product_files WHERE product_id=? AND status='approved' ORDER BY created_at",[p.id]);
    res.json({product:{
      id:p.id,name:p.product_name,category:p.category,subcategory:p.subcategory,description:p.description,
      moq:p.moq,unit:p.unit,market_scope:p.market_scope,supplierId:p.supplier_id,
      supplierName:p.trade_name||p.legal_name,supplierType:p.business_type,country:p.country,city:p.city,
      website:p.website,
      images:images.map(x=>({id:x.id,name:x.original_name,url:"/api/products/"+encodeURIComponent(p.id)+"/images/"+encodeURIComponent(x.id)}))
    }});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load product."});}
});

app.get("/api/suppliers/:id", async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      `SELECT id, legal_name, trade_name, business_type, country, city, address, website,
              category, subcategory, verified, published
       FROM supplier_profiles
       WHERE id = ? AND verified = 1 AND published = 1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Supplier not found." });
    const supplier = {
      id: row.id,
      legal_name: row.legal_name,
      trade_name: row.trade_name,
      business_type: row.business_type,
      country: row.country,
      city: row.city,
      address: row.address,
      website: row.website,
      category: row.category,
      subcategory: row.subcategory,
      verified: row.verified,
      published: row.published
    };
    // Direct supplier phone, email and contact-person data are intentionally private.
    res.json({ supplier });
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


app.get("/api/super-admin/suppliers/:id", requireSuperAdmin, async (req,res)=>{
  try{
    const [[supplier]]=await pool.execute("SELECT * FROM supplier_profiles WHERE id=?",[clean(req.params.id,80)]);
    if(!supplier)return res.status(404).json({error:"Supplier not found."});
    const [[application]]=await pool.execute("SELECT * FROM supplier_applications WHERE id=?",[supplier.application_id]);
    const [connections]=await pool.execute("SELECT id,customer_name,customer_email,customer_phone,product_name,source_action,message,created_at FROM connect_requests WHERE supplier_id=? ORDER BY created_at DESC LIMIT 200",[supplier.id]);
    res.json({supplier,application,connections});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load confidential supplier details."});}
});

app.get("/api/admin/supplier-updates", requireAdmin, async (req,res)=>{
  try {
    const [rows]=await pool.execute("SELECT u.id,u.status,u.created_at,u.reviewed_at,s.legal_name,s.trade_name,s.country,s.city FROM supplier_update_requests u JOIN supplier_profiles s ON s.id=u.supplier_id ORDER BY u.created_at DESC LIMIT 200");
    res.json({updates:rows});
  } catch(error) { console.error(error); res.status(500).json({error:"Could not load supplier updates."}); }
});

app.get("/api/admin/supplier-updates/:id", requireAdmin, async (req,res)=>{
  try {
    const [[update]]=await pool.execute("SELECT u.*,s.legal_name,s.trade_name,s.category,s.subcategory FROM supplier_update_requests u JOIN supplier_profiles s ON s.id=u.supplier_id WHERE u.id=?",[req.params.id]);
    if(!update)return res.status(404).json({error:"Update not found."});
    const [files]=await pool.execute("SELECT id,file_type,original_name,mime_type,file_size FROM supplier_update_files WHERE update_id=? ORDER BY created_at",[req.params.id]);
    const payload=JSON.parse(update.payload_json||"{}");
    if(req.admin.role!=="super_admin"){delete payload.business_email;delete payload.business_phone;delete payload.contact_person;delete payload.designation;delete payload.registration_number;delete payload.tax_number;delete payload.import_export_number;}
    res.json({update,payload,files:req.admin.role==="super_admin"?files:[]});
  } catch(error) { console.error(error); res.status(500).json({error:"Could not load supplier update."}); }
});

app.patch("/api/admin/supplier-updates/:id", requireAdmin, async (req,res)=>{
  const status=clean(req.body?.status,30), notes=clean(req.body?.adminNotes,4000);
  if(!["approved","query","rejected"].includes(status))return res.status(400).json({error:"Invalid update status."});
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[u]]=await conn.execute("SELECT * FROM supplier_update_requests WHERE id=? FOR UPDATE",[req.params.id]);
    if(!u){await conn.rollback();return res.status(404).json({error:"Update not found."});}
    const changes=JSON.parse(u.payload_json||"{}");
    const [[currentSupplier]]=await conn.execute("SELECT legal_name,trade_name,business_email FROM supplier_profiles WHERE id=?",[u.supplier_id]);
    if(!currentSupplier){await conn.rollback();return res.status(404).json({error:"Supplier not found."});}
    if(status==="approved"){
      if(changes.business_email){
        const [[dup]]=await conn.execute("SELECT id FROM supplier_profiles WHERE business_email=? AND id<>? LIMIT 1",[changes.business_email,u.supplier_id]);
        if(dup){await conn.rollback();return res.status(409).json({error:"This business email is already linked to another supplier."});}
      }
      const map={legal_name:"legal_name",trade_name:"trade_name",business_type:"business_type",country:"country",city:"city",address:"address",business_email:"business_email",business_phone:"business_phone",contact_person:"contact_person",designation:"designation",website:"website",category:"category",subcategory:"subcategory",profile_details:"profile_details_json"};
      const keys=Object.keys(changes).filter(k=>map[k]);
      if(keys.length){
        const set=keys.map(k=>map[k]+"=?").join(",");
        const values=keys.map(k=>k==="profile_details"?JSON.stringify(changes[k]||{}):changes[k]);
        await conn.execute("UPDATE supplier_profiles SET "+set+" WHERE id=?",[...values,u.supplier_id]);
        const appSet=keys.map(k=>"a."+map[k]+"=?").join(",");
        await conn.execute("UPDATE supplier_applications a JOIN supplier_profiles s ON s.application_id=a.id SET "+appSet+" WHERE s.id=?",[...values,u.supplier_id]);
      }
    }
    await conn.execute("UPDATE supplier_update_requests SET status=?,admin_notes=?,reviewed_at=NOW(),reviewed_by=? WHERE id=?",[status,notes||null,req.admin.admin_id,req.params.id]);
    await conn.commit();

    const notifyEmail=(status==="approved" && changes.business_email)?String(changes.business_email).trim().toLowerCase():String(currentSupplier.business_email||"").trim().toLowerCase();
    if(notifyEmail && /^\S+@\S+\.\S+$/.test(notifyEmail)){
      const supplierName=changes.trade_name||changes.legal_name||currentSupplier.trade_name||currentSupplier.legal_name||"Supplier";
      const subject=status==="approved"?"SupplyDesk: Profile update approved":status==="query"?"SupplyDesk: More information required for your profile update":"SupplyDesk: Profile update not approved";
      const text=status==="approved"
        ? ["Hello "+supplierName+",","", "Your SupplyDesk profile update has been approved and is now live.","",changes.business_email?"Your registered business email is now: "+changes.business_email:"","Reviewed by: "+req.admin.admin_id,"", "Thank you,","SupplyDesk"].filter(Boolean).join("\n")
        : status==="query"
        ? ["Hello "+supplierName+",","", "SupplyDesk has reviewed your profile update and needs more information before it can be approved.","",notes?"Admin note: "+notes:"Please sign in to your Supplier Dashboard to review the request and submit the required changes.","","SupplyDesk"].filter(Boolean).join("\n")
        : ["Hello "+supplierName+",","", "Your SupplyDesk profile update was not approved.","",notes?"Admin note: "+notes:"Please contact SupplyDesk if you need clarification.","","SupplyDesk"].filter(Boolean).join("\n");
      try{await mailer.sendMail({from:process.env.SMTP_FROM,to:notifyEmail,subject,text});}
      catch(mailError){console.error("Supplier update notification email failed:",mailError);}
    }
    res.json({ok:true,status});
  } catch(error) { await conn.rollback(); console.error(error); res.status(500).json({error:"Could not update supplier profile."}); }
  finally { conn.release(); }
});


app.get("/api/admin/products", requireAdmin, async (req,res)=>{
  try{
    const status=["pending","approved","rejected","archived"].includes(clean(req.query.status,30))?clean(req.query.status,30):"pending";
    const [rows]=await pool.execute(
      "SELECT p.id,p.product_name,p.category,p.subcategory,p.description,p.moq,p.unit,p.market_scope,p.status,p.admin_notes,p.created_at,p.updated_at,s.legal_name,s.trade_name,s.country,s.city FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id WHERE p.status=? ORDER BY p.created_at DESC LIMIT 200",
      [status]
    );
    res.json({products:rows});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load products."});}
});

app.get("/api/admin/products/:id/images", requireAdmin, async (req,res)=>{
  try{const [images]=await pool.execute("SELECT id,product_id,original_name,mime_type,file_size,status,admin_notes,created_at FROM supplier_product_files WHERE product_id=? AND status <> 'archived' ORDER BY created_at",[clean(req.params.id,80)]);res.json({images});}
  catch(error){res.status(500).json({error:"Could not load product images."});}
});

app.patch("/api/admin/products/:id", requireAdmin, async (req,res)=>{
  const status=clean(req.body?.status,30), notes=clean(req.body?.adminNotes,4000);
  if(!["approved","rejected","pending"].includes(status)) return res.status(400).json({error:"Invalid product status."});
  try{
    const [result]=await pool.execute("UPDATE supplier_products SET status=?,admin_notes=?,reviewed_at=NOW(),reviewed_by=? WHERE id=?",[status,notes||null,"admin",clean(req.params.id,80)]);
    if(status==="approved") await pool.execute("UPDATE supplier_product_files SET status='approved',admin_notes=?,reviewed_at=NOW(),reviewed_by='admin' WHERE product_id=? AND status='pending'",[notes||null,clean(req.params.id,80)]);
    if(status==="rejected") await pool.execute("UPDATE supplier_product_files SET status='rejected',admin_notes=?,reviewed_at=NOW(),reviewed_by='admin' WHERE product_id=? AND status='pending'",[notes||null,clean(req.params.id,80)]);
    if(!result.affectedRows) return res.status(404).json({error:"Product not found."});
    res.json({ok:true,status});
  }catch(error){console.error(error);res.status(500).json({error:"Could not review product."});}
});

app.get("/api/admin/supplier-update-files/:id", requireSuperAdmin, async (req,res)=>{
  try {
    const [[file]]=await pool.execute("SELECT original_name,mime_type,relative_path FROM supplier_update_files WHERE id=?",[req.params.id]);
    if(!file)return res.status(404).json({error:"File not found."});
    const absolute=path.resolve(UPLOAD_DIR,file.relative_path), root=path.resolve(UPLOAD_DIR);
    if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute))return res.status(404).json({error:"File not found."});
    res.setHeader("Content-Type",file.mime_type);
    res.setHeader("Content-Disposition",`inline; filename="${file.original_name.replace(/["\\]/g,"")}"`);
    res.sendFile(absolute);
  } catch(error) { console.error(error); res.status(500).json({error:"Could not open file."}); }
});

app.get("/api/admin/files/:id", requireSuperAdmin, async (req, res) => {
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

app.get("/api/admin/applications/:id", requireAdmin, async (req,res) => {
  try {
    const [[application]] = await pool.execute(
      "SELECT id,legal_name,trade_name,business_type,year_established,country,city,address,website,category,subcategory,status,admin_notes,submitted_at,reviewed_at FROM supplier_applications WHERE id=?",
      [req.params.id]
    );
    if(!application)return res.status(404).json({error:"Application not found."});
    const [files]=await pool.execute("SELECT id,file_type,original_name,mime_type,file_size,created_at FROM supplier_files WHERE application_id=? ORDER BY created_at",[req.params.id]);
    const [[verification]]=await pool.execute("SELECT registration_checked,documents_checked,photos_checked,address_checked,verification_notes,verified_at,verified_by FROM supplier_verification WHERE application_id=?",[req.params.id]);
    res.json({application,files,verification});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load application."});}
});

app.get("/api/super-admin/applications/:id", requireSuperAdmin, async (req,res)=>{
  try{
    const [[application]]=await pool.execute("SELECT * FROM supplier_applications WHERE id=?",[req.params.id]);
    if(!application)return res.status(404).json({error:"Application not found."});
    const [files]=await pool.execute("SELECT id,file_type,original_name,mime_type,file_size,created_at FROM supplier_files WHERE application_id=? ORDER BY created_at",[req.params.id]);
    const [[verification]]=await pool.execute("SELECT * FROM supplier_verification WHERE application_id=?",[req.params.id]);
    res.json({application,files,verification});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load confidential supplier details."});}
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

app.use((req, res, next) => {
  const blocked = [
    /^\/database(?:\/|$)/i,
    /^\/\.github(?:\/|$)/i,
    /^\/\.env(?:\.|$)/i,
    /^\/package(?:\.json|-lock\.json)$/i,
    /^\/HOSTINGER_SETUP\.md$/i
  ];
  if (blocked.some(pattern => pattern.test(req.path))) return res.status(404).send("Not found");
  next();
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

async function start() {
  // Production database tables are managed through database/hostinger.sql.
  // Avoid running CREATE TABLE during app startup because the runtime DB user
  // may not have DDL privileges.
  try {
    await pool.query("SELECT 1");
    app.listen(PORT, () => console.log(`SupplyDesk running on port ${PORT}`));
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}
start();
