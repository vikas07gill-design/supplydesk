require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { optimizeUploads } = require("./upload-optimize");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BUILD_VERSION = process.env.SUPPLYDESK_BUILD || "rfq-engine-2026-09-28-01";
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
const cspDirectives = helmet.contentSecurityPolicy.getDefaultDirectives();
// The static pages use inline <script> blocks and onclick handlers.
cspDirectives["script-src"] = ["'self'", "'unsafe-inline'"];
cspDirectives["script-src-attr"] = ["'unsafe-inline'"];
cspDirectives["img-src"] = ["'self'", "data:", "blob:"];
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  contentSecurityPolicy: { useDefaults: false, directives: cspDirectives }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-SupplyDesk-Build", BUILD_VERSION);
  if (req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

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

const TAXONOMY = require("./taxonomy");
const RFQ = require("./rfq");
const catalog = TAXONOMY.catalog;
// Phase 1A: SupplyDesk sells to the buyer. Supplier identity/contact is never public unless explicitly switched off.
const HIDE_SUPPLIERS = String(process.env.SD_HIDE_SUPPLIERS || "true").toLowerCase() !== "false";
const CAPACITY_STALE_DAYS = 45;
const CAP_UNITS = ["pcs","kg","tons","meters","sets","units","liters","boxes","pairs","sq.m"];
function capacityStatus(monthly, available){
  if(!monthly || monthly<=0 || available==null) return "unknown";
  if(available<=0) return "full";
  return available/monthly<=0.25 ? "limited" : "available";
}
function capacityBand(n){
  n=Number(n); if(!n || n<=0) return "";
  const bands=[[1000,"Up to 1,000"],[10000,"1,000 - 10,000"],[50000,"10,000 - 50,000"],[100000,"50,000 - 100,000"],[500000,"100,000 - 500,000"],[1000000,"500,000 - 1,000,000"]];
  for(const [limit,label] of bands) if(n<=limit) return label;
  return "1,000,000+";
}
function publicCapacity(p){
  const monthly=p.monthly_capacity==null?null:Number(p.monthly_capacity);
  const available=p.available_capacity==null?null:Number(p.available_capacity);
  const updated=p.capacity_updated_at?new Date(p.capacity_updated_at):null;
  const stale=!updated || (Date.now()-updated.getTime())>CAPACITY_STALE_DAYS*86400000;
  return {
    band:capacityBand(monthly), unit:p.capacity_unit||p.unit||"",
    status:stale?"unknown":capacityStatus(monthly,available), stale,
    leadTimeDays:p.lead_time_days==null?null:Number(p.lead_time_days),
    region:p.origin_region||"", updatedAt:updated?updated.toISOString():null
  };
}
function newCapabilityCode(category){
  const first=String(category||"GEN").replace(/[^A-Za-z]/g," ").trim().split(/\s+/)[0]||"GEN";
  const cat=(first.toUpperCase()+"XXX").slice(0,3);
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let tail="";
  for(let i=0;i<4;i++) tail+=alphabet[crypto.randomInt(alphabet.length)];
  return "SD-"+cat+"-"+tail;
}
function parseCapacityInput(body){
  const out={}; const num=(v)=>{ if(v===undefined||v===null||v==="") return null; const n=Number(String(v).replace(/,/g,"")); return Number.isFinite(n)&&n>=0&&n<=1e12?Math.round(n):NaN; };
  const m=num(body?.monthly_capacity), a=num(body?.available_capacity), l=num(body?.lead_time_days);
  if(Number.isNaN(m)||Number.isNaN(a)||Number.isNaN(l)) return {error:"Capacity and lead time must be positive numbers."};
  if(m!=null && a!=null && a>m) return {error:"Available capacity cannot be more than monthly capacity."};
  if(l!=null && l>1000) return {error:"Lead time looks too long (max 1000 days)."};
  const unit=clean(body?.capacity_unit,40);
  if(unit && !CAP_UNITS.includes(unit)) return {error:"Choose a valid capacity unit."};
  out.monthly_capacity=m; out.available_capacity=a; out.lead_time_days=l; out.capacity_unit=unit||null;
  out.origin_region=clean(body?.origin_region,150)||null;
  return {values:out};
}

const categories = Object.keys(catalog);
// Test-only config (E2E_TEST_MODE) runs many buyers from one IP; production never sets it.
const e2eSkipLimit = () => String(process.env.E2E_TEST_MODE || "").toLowerCase() === "true";
const buyerOtpRequestLimiter = rateLimit({
  skip: e2eSkipLimit,
  windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many verification codes requested. Please wait a while and try again." }
});
const buyerOtpVerifyLimiter = rateLimit({
  skip: e2eSkipLimit,
  windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many verification attempts. Please wait a while and try again." }
});
const buyerRequirementLimiter = rateLimit({
  skip: e2eSkipLimit,
  windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requirements submitted from this network. Please try again later." }
});
const connectLimiter = rateLimit({
  skip: e2eSkipLimit,
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
  windowMs: 15 * 60 * 1000,
  limit: 100,
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

function escapeEmailHtml(value){return String(value??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function buildProfessionalEmail({preheader="",title="",intro="",bodyHtml="",textLines=[],ctaText="",ctaUrl=""}){
  const safe=(v)=>escapeEmailHtml(v), origin=String(process.env.PUBLIC_ORIGIN||"https://supplydesk.in").replace(/\/$/,"");
  const cta=ctaUrl?'<p style="margin:28px 0"><a href="'+safe(ctaUrl)+'" style="display:inline-block;background:#087f8c;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:700">'+safe(ctaText||"Open SupplyDesk")+"</a></p>":"";
  const html='<!doctype html><html><body style="margin:0;background:#f4f8fa;font-family:Arial,Helvetica,sans-serif;color:#173746"><div style="display:none;max-height:0;overflow:hidden">'+safe(preheader)+'</div><div style="max-width:620px;margin:28px auto;padding:0 16px"><div style="background:#06182b;padding:18px 24px;border-radius:14px 14px 0 0;color:#fff;font-size:22px;font-weight:800">Supply<span style="color:#45d9ea">Desk</span></div><div style="background:#fff;padding:30px 28px;border:1px solid #dbe8ed;border-top:0;border-radius:0 0 14px 14px"><h1 style="font-size:22px;margin:0 0 16px;color:#092438">'+safe(title)+'</h1>'+(intro?'<p style="line-height:1.6">'+safe(intro)+'</p>':"")+bodyHtml+cta+'<p style="margin-top:30px;color:#71838b;font-size:12px;line-height:1.5">This is an automated message from SupplyDesk. Please do not share passwords or verification codes with anyone.<br>© '+new Date().getFullYear()+' SupplyDesk</p></div></div></body></html>';
  const text=[title,intro,...textLines,ctaUrl?((ctaText||"Open SupplyDesk")+": "+(/^https?:\/\//i.test(ctaUrl)?ctaUrl:origin+ctaUrl)):"", "", "SupplyDesk"].filter(Boolean).join("\n");
  return {html,text};
}

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
});

async function sendSupplierDashboardOtp(supplier, requestId = "") {
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
  const traceId = String(requestId || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  const subject = "SupplyDesk dashboard verification code" + (traceId ? " [" + traceId + "]" : "");

  // Keep OTP mail deliberately standard. Some corporate mail gateways score
  // custom X-* headers or unusual transactional metadata more aggressively.
  const email=buildProfessionalEmail({
    preheader:"Your SupplyDesk supplier dashboard verification code",
    title:"Verify your Supplier Dashboard",
    intro:"Use the verification code below to securely access your Supplier Dashboard.",
    bodyHtml:'<div style="margin:24px 0;padding:20px;background:#eef9f8;border:1px solid #c9ebe5;border-radius:12px;text-align:center"><div style="font-size:12px;color:#58717c;text-transform:uppercase;font-weight:700;letter-spacing:1px">Verification Code</div><div style="font-size:34px;letter-spacing:8px;font-weight:800;color:#087f8c;margin-top:8px">'+otp+'</div></div><p style="line-height:1.6">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p><p style="color:#71838b;font-size:12px">Reference: '+escapeEmailHtml(traceId)+'</p>',
    textLines:["Verification code: "+otp,"Valid for 10 minutes.","Reference: "+traceId]
  });
  const info = await mailer.sendMail({
    from: process.env.SMTP_FROM,
    replyTo: process.env.SMTP_FROM,
    to: supplier.business_email,
    subject:"SupplyDesk | Supplier Dashboard Verification",
    text:email.text,
    html:email.html
  });

  // Every OTP row is an independent login attempt. Do not invalidate
  // another active OTP for the same supplier because multiple people/devices
  // may legitimately log in at the same time.
  const loginAttemptId = crypto.randomUUID();

  await pool.execute(
    "INSERT INTO supplier_dashboard_otps (id,supplier_id,otp_hash,expires_at,attempts) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE),0)",
    [loginAttemptId, supplier.id, otpHash]
  );

  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted : [],
    rejected: Array.isArray(info.rejected) ? info.rejected : [],
    response: info.response || "",
    traceId,
    recipient: supplier.business_email,
    subject
  };
}

async function ensureConnectRequestsTable() {
  await pool.execute("CREATE TABLE IF NOT EXISTS connect_requests (id CHAR(36) PRIMARY KEY, supplier_id CHAR(36) NOT NULL, customer_name VARCHAR(180) NOT NULL, customer_email VARCHAR(255) NOT NULL, customer_phone VARCHAR(80) NULL, product_name VARCHAR(255) NULL, source_action ENUM('phone','email','contact') NOT NULL DEFAULT 'contact', message TEXT NULL, status ENUM('new','contacted','in_discussion','closed') NOT NULL DEFAULT 'new', updated_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT fk_connect_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE, INDEX idx_connect_supplier (supplier_id, created_at), INDEX idx_connect_customer (customer_email, created_at)) ENGINE=InnoDB");
  try { await pool.query("ALTER TABLE connect_requests ADD COLUMN status ENUM('new','contacted','in_discussion','closed') NOT NULL DEFAULT 'new'"); } catch (e) { if (!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  try { await pool.query("ALTER TABLE connect_requests ADD COLUMN updated_at DATETIME NULL"); } catch (e) { if (!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  try { await pool.query("ALTER TABLE connect_requests ADD COLUMN enquiry_id CHAR(36) NULL"); } catch (e) { if (!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  try { await pool.query("ALTER TABLE connect_requests ADD INDEX idx_connect_enquiry (enquiry_id)"); } catch (e) { if (!["ER_DUP_KEYNAME","ER_DUP_INDEX","ER_DUP_KEY"].includes(e?.code)) throw e; }
}

async function ensureBuyerSchema() {
  await pool.execute(`CREATE TABLE IF NOT EXISTS buyers (
    id CHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(180) NULL,
    company VARCHAR(180) NULL,
    country VARCHAR(120) NULL,
    phone VARCHAR(80) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME NULL,
    UNIQUE KEY uq_buyer_email (email),
    INDEX idx_buyer_last_seen (last_seen)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS buyer_enquiries (
    id CHAR(36) PRIMARY KEY,
    buyer_id CHAR(36) NOT NULL,
    product_id CHAR(36) NULL,
    supplier_id CHAR(36) NOT NULL,
    message TEXT NULL,
    quantity VARCHAR(120) NULL,
    status ENUM('new','contacted','in_discussion','closed') NOT NULL DEFAULT 'new',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    CONSTRAINT fk_buyer_enquiry_buyer FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
    CONSTRAINT fk_buyer_enquiry_product FOREIGN KEY (product_id) REFERENCES supplier_products(id) ON DELETE SET NULL,
    CONSTRAINT fk_buyer_enquiry_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
    INDEX idx_buyer_enquiry_buyer (buyer_id, created_at),
    INDEX idx_buyer_enquiry_supplier (supplier_id, created_at),
    INDEX idx_buyer_enquiry_product (product_id, created_at)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS buyer_dashboard_tokens (
    id CHAR(36) PRIMARY KEY,
    buyer_id CHAR(36) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME NULL,
    last_used_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_buyer_dashboard_token_buyer FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
    INDEX idx_buyer_dashboard_token_buyer (buyer_id, created_at),
    INDEX idx_buyer_dashboard_token_expiry (expires_at)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS buyer_email_otps (
    id CHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    otp_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    verified_at DATETIME NULL,
    verification_token_hash CHAR(64) NULL,
    verification_expires_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_buyer_email_otp (email, created_at),
    INDEX idx_buyer_email_otp_token (verification_token_hash)
  ) ENGINE=InnoDB`);
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

// Full supplier details (identity, contact, exact capacity) are for Super Admin only.
// Normal admins/testers get an alias and capacity band so they can still work the queue.
const isSuper=(req)=>req.admin?.role==="super_admin";
const supplierAlias=(id)=>"Supplier "+crypto.createHash("sha1").update(String(id||"")).digest("hex").slice(0,6).toUpperCase();
function maskSupplierRow(req,row){
  if(isSuper(req)||!row)return row;
  const o={...row},alias=supplierAlias(row.supplier_id);
  for(const k of ["legal_name","trade_name"])if(k in o)o[k]=alias;
  for(const k of ["business_email","city","country","address","website","business_phone","contact_person"])if(k in o)o[k]="";
  if("supplier_id" in o)o.supplier_id=null;
  if("monthly_capacity" in o||"available_capacity" in o){
    o.capacity_band=capacityBand(row.available_capacity);o.capacity_status=capacityStatus(Number(row.monthly_capacity)||null,row.available_capacity==null?null:Number(row.available_capacity));
    o.monthly_capacity=null;o.available_capacity=null;
  }
  o.details_restricted=true;
  return o;
}

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please wait 15 minutes and try again." }
});
const scryptAsync=(pw,salt)=>new Promise((resolve,reject)=>crypto.scrypt(pw,salt,64,(e,k)=>e?reject(e):resolve(k.toString("hex"))));
async function hashAdminPassword(password){const salt=crypto.randomBytes(16).toString("hex");return {salt,hash:await scryptAsync(password,salt)};}
async function verifyAdminPassword(password,salt,hash){try{const h=await scryptAsync(password,salt);return safeEqual(h,hash);}catch{return false;}}
const DUMMY_SALT=crypto.randomBytes(16).toString("hex");
const envAdminIds=()=>[process.env.ADMIN_ID,process.env.SUPER_ADMIN_ID,process.env.TEST_ADMIN_ID].map(x=>String(x||"").trim().toLowerCase()).filter(Boolean);

app.post("/api/admin/login", adminLoginLimiter, async (req,res)=>{
  const adminId=clean(req.body?.adminId,120);
  const password=String(req.body?.password||"");
  const normalId=String(process.env.ADMIN_ID||"").trim();
  const normalPassword=String(process.env.ADMIN_PASSWORD||"");
  const superId=String(process.env.SUPER_ADMIN_ID||"").trim();
  const superPassword=String(process.env.SUPER_ADMIN_PASSWORD||"");
  const testId=String(process.env.TEST_ADMIN_ID||"").trim();
  const testPassword=String(process.env.TEST_ADMIN_PASSWORD||"");
  let role=null, sessionAdminId=adminId;
  try{
    if(superId && safeEqual(adminId,superId) && safeEqual(password,superPassword)) role="super_admin";
    else if(normalId && safeEqual(adminId,normalId) && safeEqual(password,normalPassword)) role="admin";
    else if(testId && testPassword && safeEqual(adminId,testId) && safeEqual(password,testPassword)) role="tester";
    else if(adminId){
      // Team accounts created by the Super Admin (stored with a salted scrypt hash).
      const [[u]]=await pool.execute("SELECT id,admin_id,role,password_salt,password_hash,active FROM admin_users WHERE admin_id=? LIMIT 1",[adminId]);
      const ok=await verifyAdminPassword(password,u?u.password_salt:DUMMY_SALT,u?u.password_hash:"0".repeat(128));
      if(u && ok && u.active){role=u.role;sessionAdminId=u.admin_id;await pool.execute("UPDATE admin_users SET last_login_at=NOW() WHERE id=?",[u.id]);}
    }
    if(!role)return res.status(401).json({error:"Invalid Admin ID or password."});
    const rawToken=crypto.randomBytes(32).toString("hex");
    await pool.execute("INSERT INTO admin_sessions (id,token_hash,role,admin_id,expires_at) VALUES (?,?,?,?,DATE_ADD(NOW(),INTERVAL 12 HOUR))",[crypto.randomUUID(),tokenHash(rawToken),role,sessionAdminId]);
    res.json({ok:true,token:rawToken,role,adminId:sessionAdminId,expiresInHours:12});
  }catch(error){console.error("Admin login failed:",error);res.status(500).json({error:"Could not sign in. Please try again."});}
});

// Diagnostic tools (test mail, test OTP, DB check) are limited to the Test ID and Super Admin.
async function requireTester(req,res,next){
  try{
    const session=await getAdminSession(req);
    if(!session)return res.status(401).json({error:"Unauthorized"});
    if(!["tester","super_admin"].includes(session.role))return res.status(403).json({error:"Test tools are available only to the Test Admin account."});
    req.admin=session; next();
  }catch(error){console.error("Tester auth failed:",error);res.status(500).json({error:"Could not authenticate."});}
}

// Team management (Super Admin only).
const ADMIN_ID_RE=/^[A-Za-z0-9._@-]{3,60}$/;
app.get("/api/super-admin/team", requireSuperAdmin, async (req,res)=>{
  try{
    const [users]=await pool.execute("SELECT id,admin_id,display_name,role,active,created_by,created_at,last_login_at FROM admin_users ORDER BY created_at DESC LIMIT 200");
    res.json({users,envTestAccount:Boolean(process.env.TEST_ADMIN_ID&&process.env.TEST_ADMIN_PASSWORD)});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load team."});}
});
app.post("/api/super-admin/team", requireSuperAdmin, async (req,res)=>{
  const adminId=clean(req.body?.adminId,60),displayName=clean(req.body?.displayName,180)||null,role=clean(req.body?.role,20),password=String(req.body?.password||"");
  if(!ADMIN_ID_RE.test(adminId))return res.status(400).json({error:"Admin ID must be 3-60 characters: letters, numbers, . _ @ -"});
  if(!["admin","tester"].includes(role))return res.status(400).json({error:"Role must be Admin or Test Admin."});
  if(password.length<10||password.length>200)return res.status(400).json({error:"Password must be at least 10 characters."});
  if(envAdminIds().includes(adminId.toLowerCase()))return res.status(409).json({error:"This ID is reserved. Choose another."});
  try{
    const [[dup]]=await pool.execute("SELECT id FROM admin_users WHERE admin_id=? LIMIT 1",[adminId]);
    if(dup)return res.status(409).json({error:"This Admin ID already exists."});
    const {salt,hash}=await hashAdminPassword(password);
    const id=crypto.randomUUID();
    await pool.execute("INSERT INTO admin_users (id,admin_id,display_name,role,password_salt,password_hash,active,created_by,password_changed_at) VALUES (?,?,?,?,?,?,1,?,NOW())",[id,adminId,displayName,role,salt,hash,req.admin.admin_id]);
    res.status(201).json({ok:true,id});
  }catch(error){console.error(error);res.status(500).json({error:"Could not create the account."});}
});
app.patch("/api/super-admin/team/:id", requireSuperAdmin, async (req,res)=>{
  const id=clean(req.params.id,80),sets=[],params=[];let endSessions=false;
  try{
    const [[u]]=await pool.execute("SELECT id,admin_id FROM admin_users WHERE id=?",[id]);
    if(!u)return res.status(404).json({error:"Account not found."});
    if(typeof req.body?.active==="boolean"){sets.push("active=?");params.push(req.body.active?1:0);if(!req.body.active)endSessions=true;}
    if(req.body?.role!==undefined){const role=clean(req.body.role,20);if(!["admin","tester"].includes(role))return res.status(400).json({error:"Invalid role."});sets.push("role=?");params.push(role);endSessions=true;}
    if(req.body?.displayName!==undefined){sets.push("display_name=?");params.push(clean(req.body.displayName,180)||null);}
    if(req.body?.password!==undefined){
      const pw=String(req.body.password);if(pw.length<10||pw.length>200)return res.status(400).json({error:"Password must be at least 10 characters."});
      const {salt,hash}=await hashAdminPassword(pw);sets.push("password_salt=?","password_hash=?","password_changed_at=NOW()");params.push(salt,hash);endSessions=true;
    }
    if(!sets.length)return res.status(400).json({error:"Nothing to update."});
    await pool.execute("UPDATE admin_users SET "+sets.join(",")+" WHERE id=?",[...params,id]);
    if(endSessions)await pool.execute("DELETE FROM admin_sessions WHERE admin_id=?",[u.admin_id]);
    res.json({ok:true});
  }catch(error){console.error(error);res.status(500).json({error:"Could not update the account."});}
});

app.post("/api/admin/test-email", requireTester, async (req,res)=>{
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

async function sendAdminInvitation({recipientEmail,recipientName,inviteType,message}){
  if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM) throw new Error("SMTP environment variables are not configured.");
  const origin=String(process.env.PUBLIC_ORIGIN||"https://supplydesk.in").replace(/\/$/,"");
  const inviteUrl=origin+"/";
  const safeMessage=escapeEmailHtml(message).replace(/\r?\n/g,"<br>");
  const email=buildProfessionalEmail({
    preheader:"Get more customers with SupplyDesk. Limited-time launch offer: listing FREE.",
    title:"Get More Customers. Grow Your Business.",
    intro:recipientName?("Hello "+recipientName+", we would like to invite your business to explore SupplyDesk."):"We would like to invite your business to explore SupplyDesk.",
    bodyHtml:'<div style="margin:22px 0;padding:18px;background:#f5fafb;border:1px solid #dbe8ed;border-radius:12px;line-height:1.7">'+safeMessage+'</div><p style="line-height:1.6">SupplyDesk helps businesses showcase products and services, reach potential buyers and create new B2B sales opportunities.</p><div style="margin:24px 0;padding:20px;background:#eef9f8;border:1px solid #bfe4df;border-radius:12px;text-align:center"><div style="display:inline-block;background:#087f8c;color:#fff;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.6px">LIMITED-TIME LAUNCH OFFER</div><div style="margin-top:12px;color:#5c7078;font-size:13px">Business Listing</div><div style="margin-top:4px;font-size:17px;color:#64777f"><span style="text-decoration:line-through">INR 21,000</span></div><div style="margin-top:3px;font-size:30px;line-height:1.15;font-weight:900;color:#087f8c">FREE</div><div style="margin-top:6px;font-size:12px;color:#526970">Available free during the launch period.</div></div><div style="margin:24px 0"><div style="font-size:13px;font-weight:800;color:#092438;margin-bottom:10px">KEY BUSINESS BENEFITS</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0 7px"><tr><td width="28" valign="top" style="color:#087f8c;font-weight:900;font-size:16px">✓</td><td style="font-size:13px;line-height:1.5">Get discovered by potential buyers</td></tr><tr><td width="28" valign="top" style="color:#087f8c;font-weight:900;font-size:16px">✓</td><td style="font-size:13px;line-height:1.5">Showcase your business and products professionally</td></tr><tr><td width="28" valign="top" style="color:#087f8c;font-weight:900;font-size:16px">✓</td><td style="font-size:13px;line-height:1.5">Receive business enquiries through SupplyDesk</td></tr><tr><td width="28" valign="top" style="color:#087f8c;font-weight:900;font-size:16px">✓</td><td style="font-size:13px;line-height:1.5">Expand your market reach and sales opportunities</td></tr></table></div>',
    textLines:[message,"Invitation type: "+inviteType,"Launch offer: business listing normally INR 21,000, currently FREE for a limited time during launch.","To stop future onboarding emails, reply with Unsubscribe."],
    ctaText:"Explore SupplyDesk", ctaUrl:inviteUrl
  });
  return await mailer.sendMail({from:process.env.SMTP_FROM,replyTo:process.env.SMTP_FROM,to:recipientEmail,subject:"SupplyDesk | Get More Customers. Limited-Time Launch Offer",text:email.text,html:email.html});
}

// ---- Potential contacts helpers -------------------------------------------
// Compare emails with an explicit collation so queries work whatever collation an
// older production table/column or the connection happens to use.
const PC_COLLATE = "utf8mb4_unicode_ci";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(v){ return clean(v,255).toLowerCase(); }
// Canonical mobile key: digits only, international prefix (00) removed, and for
// numbers of 10+ digits only the last 10 (so +91 98765 43210, 098765-43210 and
// 9876543210 are the same contact).
function mobileKey(v){
  let d=String(v||"").replace(/\D/g,"").replace(/^00/,"");
  if(d.length>10) d=d.slice(-10);
  return d.length>=7?d:"";
}
const PC_INVITE_BATCH_MAX = 25;
const PC_IMPORT_BATCH_MAX = 500;
const DEFAULT_INVITE_MESSAGE = "Looking for more customers and new business opportunities?\n\nSupplyDesk is a global B2B sourcing platform helping businesses connect with buyers and suppliers for international trade. List your business, showcase your products or services, and get discovered by potential customers.\n\nWhy join SupplyDesk?\n• Get discovered by potential buyers\n• Showcase your business and products professionally\n• Receive business enquiries through SupplyDesk\n• Expand your market reach and sales opportunities\n\nExplore SupplyDesk: "+String(process.env.PUBLIC_ORIGIN||"https://supplydesk.in").replace(/\/$/,"")+"/\n\nCreate your business presence with SupplyDesk while the launch offer is available.";
async function findPotentialContact(email,key){
  const [byEmail]=await pool.execute("SELECT id,status,email FROM potential_contacts WHERE email = ? COLLATE "+PC_COLLATE+" LIMIT 1",[email]);
  if(byEmail.length) return {row:byEmail[0],by:"email"};
  if(key){
    const [byMobile]=await pool.execute("SELECT id,status,email FROM potential_contacts WHERE mobile_key = ? LIMIT 1",[key]);
    if(byMobile.length) return {row:byMobile[0],by:"mobile"};
  }
  return null;
}
async function logInvitation(name,email,inviteType,ok,info,reason){
  try{await pool.execute("INSERT INTO admin_invitation_log (id,recipient_name,recipient_email,invite_type,status,message_id,sent_at,error_text) VALUES (?,?,?,?,?,?,"+(ok?"NOW()":"NULL")+",?)",[crypto.randomUUID(),name,email,inviteType,ok?"sent":"failed",ok?(info?.messageId||null):null,ok?null:reason])}catch(e){console.error("Invitation log failed:",e)}
}

app.post("/api/admin/potential-contacts/import", requireAdmin, async (req,res)=>{
  const inviteType=clean(req.body?.inviteType,30).toLowerCase();
  const recipients=Array.isArray(req.body?.recipients)?req.body.recipients:[];
  if(!["supplier","buyer"].includes(inviteType)) return res.status(400).json({error:"Contact type must be supplier or buyer."});
  if(!recipients.length) return res.status(400).json({error:"At least one contact is required."});
  if(recipients.length>PC_IMPORT_BATCH_MAX) return res.status(400).json({error:"Send at most "+PC_IMPORT_BATCH_MAX+" contacts per request (got "+recipients.length+"). Nothing was imported."});
  const added=[]; let skipped=0,invalid=0,duplicates=0;
  try{
    const seenEmail=new Set(), seenMobile=new Set();
    for(const raw of recipients){
      const email=normalizeEmail(raw?.email);
      const name=clean(raw?.name,180);
      const mobile=clean(raw?.phone,40);
      const location=clean(raw?.location,255);
      const key=mobileKey(mobile);
      if(!EMAIL_RE.test(email)||!name){skipped++;invalid++;continue}
      if(seenEmail.has(email)||(key&&seenMobile.has(key))){skipped++;duplicates++;continue}
      seenEmail.add(email);if(key)seenMobile.add(key);
      if(await findPotentialContact(email,key)){skipped++;duplicates++;continue}
      const id=crypto.randomUUID();
      try{
        await pool.execute("INSERT INTO potential_contacts (id,company_name,email,mobile,mobile_key,location,contact_type,source,status,last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,NOW())",[id,name,email,mobile,key,location,inviteType,"manual_import","new"]);
      }catch(e){
        if(e?.code==="ER_DUP_ENTRY"){skipped++;duplicates++;continue}
        throw e;
      }
      added.push({id,name,email,phone:mobile});
    }
    res.json({ok:true,added:added.length,skipped,invalid,duplicates,contacts:added});
  }catch(error){console.error("Potential contacts import failed:",error);res.status(500).json({error:"Could not import potential contacts."})}
});

app.get("/api/admin/potential-contacts", requireAdmin, async (req,res)=>{
  try{
    const type=clean(req.query?.type,20).toLowerCase();
    const search=clean(req.query?.search,255);
    const onboarding=clean(req.query?.onboarding,30).toLowerCase();
    const inviteStatus=clean(req.query?.status,30).toLowerCase();
    const where=[]; const params=[];
    if(["supplier","buyer"].includes(type)){where.push("pc.contact_type=?");params.push(type)}
    if(["new","invited","interested","registered","active","unsubscribed"].includes(inviteStatus)){where.push("pc.status=?");params.push(inviteStatus)}
    if(search){where.push("(pc.company_name LIKE ? OR pc.email LIKE ? OR pc.mobile LIKE ? OR pc.location LIKE ?)");const q="%"+search+"%";params.push(q,q,q,q)}
    const sql="SELECT pc.id,pc.company_name,pc.email,pc.mobile,pc.location,pc.contact_type,pc.status,pc.source,pc.created_at,pc.last_activity_at,sp.id AS supplier_profile_id,sp.verified AS supplier_verified,sp.published AS supplier_published,b.id AS buyer_id FROM potential_contacts pc LEFT JOIN supplier_profiles sp ON CONVERT(LOWER(sp.business_email) USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONVERT(LOWER(pc.email) USING utf8mb4) COLLATE utf8mb4_unicode_ci LEFT JOIN buyers b ON CONVERT(LOWER(b.email) USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONVERT(LOWER(pc.email) USING utf8mb4) COLLATE utf8mb4_unicode_ci "+(where.length?"WHERE "+where.join(" AND "):"")+" ORDER BY pc.last_activity_at DESC, pc.created_at DESC LIMIT 5001";
    const [allContacts]=await pool.execute(sql,params);
    const truncated=allContacts.length>5000;
    const contacts=truncated?allContacts.slice(0,5000):allContacts;
    const mapped=contacts.map(c=>({
      ...c,
      onboarded: c.contact_type==="supplier" ? !!c.supplier_profile_id : !!c.buyer_id,
      onboardedStatus: c.contact_type==="supplier" ? (c.supplier_profile_id ? (c.supplier_verified&&c.supplier_published ? "Active" : "Registered") : "Not Onboarded") : (c.buyer_id ? "Registered" : "Not Onboarded")
    })).filter(c=>!onboarding || (onboarding==="not_onboarded" ? !c.onboarded : c.onboardedStatus.toLowerCase()===onboarding));
    res.json({ok:true,total:mapped.length,truncated,contacts:mapped});
  }catch(error){console.error("Potential contacts load failed:",error);res.status(500).json({error:"Could not load potential contacts."})}
});

app.post("/api/admin/invite", requireAdmin, async (req,res)=>{
  const recipientEmail=clean(req.body?.recipientEmail,255).toLowerCase();
  const recipientName=clean(req.body?.recipientName,120);
  const inviteType=clean(req.body?.inviteType,30).toLowerCase();
  const message=clean(req.body?.message,2500);
  if(!/^\S+@\S+\.\S+$/.test(recipientEmail)) return res.status(400).json({error:"A valid recipient email is required."});
  if(!["supplier","buyer"].includes(inviteType)) return res.status(400).json({error:"Invitation type must be supplier or buyer."});
  if(!message) return res.status(400).json({error:"Invitation message is required."});
  try{
    const info=await sendAdminInvitation({recipientEmail,recipientName,inviteType,message});
    res.json({ok:true,recipient:recipientEmail,messageId:info.messageId});
  }catch(error){
    console.error("Admin invitation email failed:",error);
    res.status(502).json({error:"Invitation email failed: "+(error?.code||"SEND_ERROR")+" "+(error?.responseCode||"")+" "+(error?.message||"Unknown SMTP error")});
  }
});

// Sends invitations in small batches (the admin page loops over batches and shows
// progress). Two modes:
//  - recipients: [{name,email,phone}] -> contacts that are not yet invited are
//    sent; unknown ones are added to the Potential Database as `invited` only after
//    SMTP succeeds.
//  - pending:true -> sends to the next batch of Potential Database contacts whose
//    status is still `new` (excludeIds = ids that failed earlier in this run).
// A contact is marked `invited` only after SMTP accepts the message, so failed
// sends stay `new` / unsaved and can simply be retried.
app.post("/api/admin/bulk-invite", requireAdmin, async (req,res)=>{
  const inviteType=clean(req.body?.inviteType,30).toLowerCase();
  const delayMs=Math.min(Math.max(Number(req.body?.delayMs||2500),1000),10000);
  const pending=req.body?.pending===true;
  if(!["supplier","buyer"].includes(inviteType)) return res.status(400).json({error:"Invitation type must be supplier or buyer."});
  let recipients=[];
  let remaining=null;
  try{
    if(pending){
      const limit=Math.min(Math.max(parseInt(req.body?.limit,10)||10,1),PC_INVITE_BATCH_MAX);
      const exclude=(Array.isArray(req.body?.excludeIds)?req.body.excludeIds:[]).map(x=>String(x)).filter(x=>/^[0-9a-f-]{36}$/i.test(x)).slice(0,5000);
      const notIn=exclude.length?" AND id NOT IN ("+exclude.map(()=>"?").join(",")+")":"";
      const [[cnt]]=await pool.query("SELECT COUNT(*) AS n FROM potential_contacts WHERE status='new' AND contact_type=?"+notIn,[inviteType,...exclude]);
      remaining=Number(cnt.n);
      const [rows]=await pool.query("SELECT id,company_name,email,mobile FROM potential_contacts WHERE status='new' AND contact_type=?"+notIn+" ORDER BY created_at,id LIMIT ?",[inviteType,...exclude,limit]);
      recipients=rows.map(r=>({id:r.id,name:r.company_name,email:r.email,phone:r.mobile||""}));
    }else{
      recipients=Array.isArray(req.body?.recipients)?req.body.recipients:[];
      if(recipients.length>PC_INVITE_BATCH_MAX) return res.status(400).json({error:"Send at most "+PC_INVITE_BATCH_MAX+" recipients per request (got "+recipients.length+"). Nothing was sent."});
    }
  }catch(error){console.error("Bulk invite lookup failed:",error);return res.status(500).json({error:"Could not load contacts to invite."})}
  if(!recipients.length&&!pending) return res.status(400).json({error:"At least one recipient is required."});
  const results=[]; let sent=0,skipped=0,failed=0;
  for(let i=0;i<recipients.length;i++){
    const row=recipients[i]||{}; const email=normalizeEmail(row.email); const name=clean(row.name,180); const phone=clean(row.phone,40);
    const out={id:row.id||null,name,email,phone};
    if(!EMAIL_RE.test(email)){failed++;results.push({...out,status:"failed",reason:"Invalid email"});continue}
    let existing=null;
    try{
      existing=await findPotentialContact(email,mobileKey(phone));
      if(existing&&existing.row.status!=="new"){
        skipped++;results.push({...out,id:existing.row.id,status:"skipped",reason:"Already invited / in Potential Database ("+existing.row.status+")"});continue;
      }
      if(existing&&existing.by==="mobile"){
        skipped++;results.push({...out,id:existing.row.id,status:"skipped",reason:"Mobile number already belongs to another contact"});continue;
      }
    }catch(error){
      failed++;results.push({...out,status:"failed",reason:"Database error: "+(error?.code||error?.message||"unknown").slice(0,200)});continue;
    }
    let info;
    try{
      info=await sendAdminInvitation({recipientEmail:email,recipientName:name,inviteType,message:DEFAULT_INVITE_MESSAGE});
    }catch(error){
      failed++;
      const reason=(error?.message||"Send failed").slice(0,500);
      await logInvitation(name,email,inviteType,false,null,reason);
      results.push({...out,id:existing?existing.row.id:null,status:"failed",reason});
      if(delayMs&&i<recipients.length-1) await new Promise(r=>setTimeout(r,delayMs));
      continue;
    }
    // SMTP accepted the message: only now record the contact as invited.
    try{
      if(existing){
        await pool.execute("UPDATE potential_contacts SET status='invited',last_activity_at=NOW() WHERE id=?",[existing.row.id]);
      }else{
        try{
          await pool.execute("INSERT INTO potential_contacts (id,company_name,email,mobile,mobile_key,contact_type,source,status,last_activity_at) VALUES (?,?,?,?,?,?,?,?,NOW())",[crypto.randomUUID(),name||email,email,phone,mobileKey(phone),inviteType,"bulk_onboarding","invited"]);
        }catch(e){if(e?.code!=="ER_DUP_ENTRY")throw e}
      }
    }catch(error){console.error("Could not mark contact invited after successful send:",email,error)}
    await logInvitation(name,email,inviteType,true,info,null);
    sent++;results.push({...out,id:existing?existing.row.id:out.id,status:"sent"});
    if(delayMs&&i<recipients.length-1) await new Promise(r=>setTimeout(r,delayMs));
  }
  res.json({ok:true,total:recipients.length,sent,skipped,failed,remaining:remaining===null?null:Math.max(remaining-sent-skipped,0),results});
});

app.get("/api/admin/test-connection-storage", requireTester, async (req,res)=>{
  try{
    const [[table]] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='connect_requests'");
    if(!table) return res.status(500).json({ok:false,error:"connect_requests table does not exist in the active database."});
    const [columns]=await pool.query("SHOW COLUMNS FROM connect_requests");
    const [fk]=await pool.query(
      "SELECT CONSTRAINT_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='connect_requests' AND COLUMN_NAME='supplier_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
    );
    res.json({ok:true,table:"connect_requests",columns:columns.map(x=>({field:x.Field,type:x.Type,null:x.Null,key:x.Key,default:x.Default})),foreignKey:fk});
  }catch(error){
    console.error("Connection storage diagnostic failed:",error);
    res.status(500).json({ok:false,error:"Storage diagnostic failed: "+(error?.code||"DB_ERROR")+" "+(error?.message||"Unknown database error")});
  }
});

app.post("/api/admin/test-dashboard-otp", requireTester, async (req,res)=>{
  const lookup=clean(req.body?.supplierId,255);
  if(!lookup)return res.status(400).json({error:"Supplier ID or registered business email is required."});
  try{
    const [[supplier]]=await pool.execute(
      "SELECT id,legal_name,trade_name,business_email,verified,published FROM supplier_profiles WHERE id=? OR LOWER(TRIM(business_email))=LOWER(TRIM(?)) LIMIT 1",
      [lookup,lookup]
    );
    if(!supplier)return res.status(404).json({error:"Supplier not found for that ID/email."});
    if(!supplier.verified||!supplier.published)return res.status(400).json({error:"Supplier exists but is not verified and published."});
    if(!supplier.business_email)return res.status(400).json({error:"Supplier business email is missing."});
    const info=await sendSupplierDashboardOtp(supplier);
    const masked=supplier.business_email.replace(/^(.{2}).*(@.*)$/,"$1***$2");
    res.json({ok:true,recipient:masked,messageId:info.messageId});
  }catch(error){
    console.error("Admin dashboard OTP test failed:",{code:error?.code,responseCode:error?.responseCode,command:error?.command,response:error?.response,message:error?.message});
    res.status(502).json({error:"OTP email failed: "+(error?.code||"SEND_ERROR")+" "+(error?.responseCode||"")+" "+(error?.message||"Unknown SMTP error")});
  }
});

app.post("/api/admin/test-supplier-email", requireTester, async (req,res)=>{
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

app.get("/api/version", (req, res) => {
  res.json({ ok: true, build: BUILD_VERSION, node: process.version, serverTime: new Date().toISOString() });
});

app.get("/api/categories", (req, res) => {
  res.json({ categories, subcategories: catalog, groups: TAXONOMY.groups });
});

// Shared by every page so categories are defined in exactly one place (taxonomy.js).
app.get("/assets/taxonomy.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "public, max-age=300");
  res.send("window.SD_TAX=" + JSON.stringify({ groups: TAXONOMY.groups, subs: TAXONOMY.catalog, aliases: TAXONOMY.aliases, keywords: TAXONOMY.keywords }) + ";");
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
  optimizeUploads(),
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
  if (HIDE_SUPPLIERS) return res.json({ suppliers: [] });
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


async function getBuyerByDashboardToken(rawToken){
  const token=clean(rawToken,256);
  if(!token)return null;
  const [[buyer]]=await pool.execute(
    `SELECT b.id,b.email,b.name,b.company,b.country,b.phone,t.id AS token_id
     FROM buyer_dashboard_tokens t JOIN buyers b ON b.id=t.buyer_id
     WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>NOW()`,
    [tokenHash(token)]
  );
  if(!buyer)return null;
  await pool.execute("UPDATE buyer_dashboard_tokens SET last_used_at=NOW() WHERE id=?",[buyer.token_id]);
  await pool.execute("UPDATE buyers SET last_seen=NOW() WHERE id=?",[buyer.id]);
  return buyer;
}

async function requireBuyerDashboard(req,res,next){
  try{
    const buyer=await getBuyerByDashboardToken(req.get("x-buyer-dashboard-token"));
    if(!buyer)return res.status(401).json({error:"Buyer dashboard access has expired. Please verify your email again."});
    req.buyer=buyer; next();
  }catch(error){
    console.error("Buyer dashboard auth failed:",error);
    res.status(500).json({error:"Could not authenticate buyer dashboard."});
  }
}

app.get("/api/buyer-dashboard", requireBuyerDashboard, async (req,res)=>{
  try{
    const [enquiries]=await pool.execute(
      `SELECT e.id,e.product_id,e.supplier_id,e.message,e.quantity,e.status,e.created_at,e.updated_at,
              e.decision,e.approved_quantity,e.buyer_remark,e.decided_at,p.capability_code,
              p.product_name,s.trade_name,s.legal_name,s.country,s.city
       FROM buyer_enquiries e
       JOIN supplier_profiles s ON s.id=e.supplier_id
       LEFT JOIN supplier_products p ON p.id=e.product_id
       WHERE e.buyer_id=? ORDER BY e.created_at DESC LIMIT 100`,
      [req.buyer.id]
    );
    res.json({
      buyer:{id:req.buyer.id,email:req.buyer.email,name:req.buyer.name||"",company:req.buyer.company||"",country:req.buyer.country||"",phone:req.buyer.phone||""},
      enquiries:enquiries.map(e=>{
        const row={id:e.id,productId:e.product_id,productName:e.product_name||"General enquiry",capabilityCode:e.capability_code||"",quantity:e.quantity||"",message:e.message||"",status:e.status,decision:e.decision||"pending",approvedQuantity:e.approved_quantity||"",remark:e.buyer_remark||"",decidedAt:e.decided_at||null,createdAt:e.created_at,updatedAt:e.updated_at};
        return HIDE_SUPPLIERS?row:{...row,supplierId:e.supplier_id,supplierName:e.trade_name||e.legal_name,supplierCountry:e.country,supplierCity:e.city};
      })
    });
  }catch(error){
    console.error("Buyer dashboard load failed:",error);
    res.status(500).json({error:"Could not load buyer dashboard."});
  }
});

app.patch("/api/buyer-dashboard/profile", requireBuyerDashboard, async(req,res)=>{
  const name=clean(req.body?.name,180), company=clean(req.body?.company,180), country=clean(req.body?.country,120), phone=clean(req.body?.phone,80);
  try{
    await pool.execute("UPDATE buyers SET name=?,company=?,country=?,phone=?,last_seen=NOW() WHERE id=?",[name||null,company||null,country||null,phone||null,req.buyer.id]);
    res.json({ok:true});
  }catch(error){
    console.error("Buyer profile update failed:",error);
    res.status(500).json({error:"Could not update buyer profile."});
  }
});

app.post("/api/buyer-dashboard/logout", requireBuyerDashboard, async(req,res)=>{
  await pool.execute("UPDATE buyer_dashboard_tokens SET revoked_at=NOW() WHERE token_hash=?",[tokenHash(req.get("x-buyer-dashboard-token"))]);
  res.json({ok:true});
});

app.post("/api/buyer-email/request-otp", buyerOtpRequestLimiter, async (req,res)=>{
  const email=clean(req.body?.email,255).toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:"Please enter a valid email address."});
  const e2eMode=String(process.env.E2E_TEST_MODE||"").toLowerCase()==="true";
  const e2eKey=clean(req.get("x-e2e-key"),256);
  const configuredE2eKey=clean(process.env.E2E_TEST_KEY,256);
  const authorizedE2e=e2eMode && configuredE2eKey && safeEqual(e2eKey,configuredE2eKey);
  // Test mode (E2E_TEST_MODE + matching x-e2e-key) must work on CI, where no SMTP is configured.
  if(!authorizedE2e && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM)) return res.status(503).json({error:"Email verification service is not configured yet."});
  const otp=String(crypto.randomInt(100000,1000000));
  try{
    await pool.execute("UPDATE buyer_email_otps SET expires_at=NOW() WHERE email=? AND verified_at IS NULL AND expires_at>NOW()",[email]);
    await pool.execute("INSERT INTO buyer_email_otps (id,email,otp_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))",[crypto.randomUUID(),email,hashToken(otp)]);
    if(authorizedE2e){
      return res.json({ok:true,message:"Test verification code created.",expiresInMinutes:10,testOtp:otp});
    }
    const mail=buildProfessionalEmail({
      preheader:"Your SupplyDesk email verification code",
      title:"Verify your email",
      intro:"Use the verification code below to verify your email and submit your sourcing requirement on SupplyDesk.",
      bodyHtml:'<div style="margin:24px 0;padding:20px;background:#eef9f8;border:1px solid #c9ebe5;border-radius:12px;text-align:center"><div style="font-size:12px;color:#58717c;text-transform:uppercase;font-weight:700;letter-spacing:1px">Verification Code</div><div style="font-size:34px;letter-spacing:8px;font-weight:800;color:#087f8c;margin-top:8px">'+otp+'</div></div><p style="line-height:1.6">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p><p style="color:#71838b;font-size:12px">If you did not request this code, you can safely ignore this email.</p>',
      textLines:["Verification code: "+otp,"Valid for 10 minutes.","If you did not request this code, you can safely ignore this email."]
    });
    await mailer.sendMail({from:process.env.SMTP_FROM,replyTo:process.env.SMTP_FROM,to:email,subject:"SupplyDesk | Buyer Email Verification",text:mail.text,html:mail.html});
    res.json({ok:true,message:"Verification code sent to your email.",expiresInMinutes:10});
  }catch(error){
    console.error("Buyer email OTP failed:",{email,code:error?.code,message:error?.message});
    res.status(502).json({error:"Could not send the verification code. Please try again."});
  }
});

app.post("/api/buyer-email/verify-otp", buyerOtpVerifyLimiter, async (req,res)=>{
  const email=clean(req.body?.email,255).toLowerCase();
  const otp=clean(req.body?.otp,10);
  if(!/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(otp)) return res.status(400).json({error:"Enter the 6-digit verification code sent to your email."});
  try{
    const [[row]]=await pool.execute("SELECT id,otp_hash,expires_at,attempts FROM buyer_email_otps WHERE email=? AND verified_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1",[email]);
    if(!row) return res.status(400).json({error:"Code expired. Please request a new code."});
    if(Number(row.attempts)>=5) return res.status(429).json({error:"Too many incorrect attempts. Please request a new code."});
    if(!safeEqual(hashToken(otp),row.otp_hash)){
      await pool.execute("UPDATE buyer_email_otps SET attempts=attempts+1 WHERE id=?",[row.id]);
      return res.status(400).json({error:"Incorrect verification code."});
    }
    const rawToken=crypto.randomBytes(32).toString("hex");
    const dashboardToken=crypto.randomBytes(32).toString("hex");
    const [[existingBuyer]]=await pool.execute("SELECT id FROM buyers WHERE email=? LIMIT 1",[email]);
    const buyerId=existingBuyer?.id||crypto.randomUUID();
    if(existingBuyer){
      await pool.execute("UPDATE buyers SET last_seen=NOW() WHERE id=?",[buyerId]);
    }else{
      await pool.execute("INSERT INTO buyers (id,email,last_seen) VALUES (?,?,NOW())",[buyerId,email]);
    }
    await pool.execute("UPDATE buyer_email_otps SET verified_at=NOW(),verification_token_hash=?,verification_expires_at=DATE_ADD(NOW(),INTERVAL 30 MINUTE) WHERE id=?",[hashToken(rawToken),row.id]);
    await pool.execute("INSERT INTO buyer_dashboard_tokens (id,buyer_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 30 DAY))",[crypto.randomUUID(),buyerId,tokenHash(dashboardToken)]);
    res.json({ok:true,verificationToken:rawToken,dashboardToken,buyerId,dashboardUrl:"/buyer-dashboard.html",message:"Email verified. Your Buyer Dashboard is ready."});
  }catch(error){
    console.error("Buyer email verification failed:",error);
    res.status(500).json({error:"Could not verify the email. Please try again."});
  }
});

app.post("/api/connect-requests", connectLimiter, async (req, res) => {
  let supplierId = clean(req.body?.supplierId, 80);
  const productId = clean(req.body?.productId, 80) || null;
  const customerName = clean(req.body?.customerName, 180);
  const customerEmail = clean(req.body?.customerEmail, 255).toLowerCase();
  const customerCompany = clean(req.body?.customerCompany, 180) || null;
  const customerCountry = clean(req.body?.customerCountry, 120) || null;
  const customerPhone = clean(req.body?.customerPhone, 80) || null;
  const productName = clean(req.body?.productName, 255) || null;
  const quantity = clean(req.body?.quantity, 120) || null;
  const sourceAction = ["phone","email","contact"].includes(req.body?.sourceAction) ? req.body.sourceAction : "contact";
  const message = clean(req.body?.message, 2000) || null;
  const verificationToken=clean(req.body?.verificationToken,256);
  const dashboardToken=clean(req.body?.dashboardToken,256);

  if ((!supplierId && !(HIDE_SUPPLIERS && productId)) || !customerName || !customerEmail) return res.status(400).json({ error: HIDE_SUPPLIERS ? "Product, name and email are required." : "Name and email are required." });
  if (!/^\S+@\S+\.\S+$/.test(customerEmail)) return res.status(400).json({ error: "Please enter a valid email address." });
  const e2eMode=String(process.env.E2E_TEST_MODE||"").toLowerCase()==="true";
  const e2eKey=clean(req.get("x-e2e-key"),256);
  const configuredE2eKey=clean(process.env.E2E_TEST_KEY,256);
  const authorizedE2e=e2eMode && configuredE2eKey && safeEqual(e2eKey,configuredE2eKey);
  if (!authorizedE2e && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM)) return res.status(503).json({ error: "Connection email service is not configured yet." });

  const requestId = crypto.randomUUID();
  const enquiryId = crypto.randomUUID();
  try {
    let dashboardBuyer=null;
    if(dashboardToken){
      dashboardBuyer=await getBuyerByDashboardToken(dashboardToken);
      if(dashboardBuyer && dashboardBuyer.email!==customerEmail)dashboardBuyer=null;
    }
    if(!dashboardBuyer){
      const [[verifiedOtp]]=await pool.execute("SELECT id FROM buyer_email_otps WHERE email=? AND verification_token_hash=? AND verification_expires_at>NOW() AND verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1",[customerEmail,hashToken(verificationToken)]);
      if(!verifiedOtp) return res.status(400).json({error:"Email verification expired. Please verify your email again."});
    }

    let selectedProductName = productName, selectedCode = "";
    if (HIDE_SUPPLIERS) {
      // The buyer never names a supplier: SupplyDesk resolves it internally from the product.
      const [[product]] = await pool.execute(
        "SELECT p.id,p.product_name,p.supplier_id,p.capability_code FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id WHERE p.id=? AND p.status='approved' AND s.verified=1 AND s.published=1",
        [productId]
      );
      if (!product) return res.status(400).json({ error: "This product is not currently available." });
      supplierId = product.supplier_id; selectedProductName = product.product_name; selectedCode = product.capability_code || "";
    }
    const [[supplier]] = await pool.execute(
      "SELECT id, legal_name, trade_name, business_email, category, subcategory FROM supplier_profiles WHERE id=? AND verified=1 AND published=1",
      [supplierId]
    );
    if (!supplier || (!HIDE_SUPPLIERS && !supplier.business_email)) return res.status(404).json({ error: "Supplier contact is not available." });

    if (!HIDE_SUPPLIERS && productId) {
      const [[product]] = await pool.execute(
        "SELECT id,product_name FROM supplier_products WHERE id=? AND supplier_id=? AND status='approved'",
        [productId, supplierId]
      );
      if (!product) return res.status(400).json({ error: "This product is not currently available for connection." });
      selectedProductName = product.product_name;
    }

    const [[existingBuyer]] = await pool.execute("SELECT id FROM buyers WHERE email=? LIMIT 1", [customerEmail]);
    const buyerId = dashboardBuyer?.id || existingBuyer?.id || crypto.randomUUID();

    if (existingBuyer || dashboardBuyer) {
      await pool.execute(
        "UPDATE buyers SET name=COALESCE(NULLIF(?,''),name), company=COALESCE(NULLIF(?,''),company), country=COALESCE(NULLIF(?,''),country), phone=COALESCE(NULLIF(?,''),phone), last_seen=NOW() WHERE id=?",
        [customerName, customerCompany || "", customerCountry || "", customerPhone || "", buyerId]
      );
    } else {
      await pool.execute(
        "INSERT INTO buyers (id,email,name,company,country,phone,last_seen) VALUES (?,?,?,?,?,?,NOW())",
        [buyerId,customerEmail,customerName,customerCompany,customerCountry,customerPhone]
      );
    }

    await pool.execute(
      "INSERT INTO buyer_enquiries (id,buyer_id,product_id,supplier_id,message,quantity,status) VALUES (?,?,?,?,?,?,?)",
      [enquiryId,buyerId,productId,supplierId,message,quantity,"new"]
    );

    await pool.execute(
      "INSERT INTO connect_requests (id,supplier_id,customer_name,customer_email,customer_phone,product_name,source_action,message,status,updated_at,enquiry_id) VALUES (?,?,?,?,?,?,?,?,?,NOW(),?)",
      [requestId,supplierId,customerName,customerEmail,customerPhone,selectedProductName,sourceAction,message,"new",enquiryId]
    );

    if (HIDE_SUPPLIERS) {
      if (!authorizedE2e) {
        await sendBrandedMail(customerEmail, "SupplyDesk | Quote request received", {
          preheader: "We have received your quote request",
          title: "Quote request received",
          intro: "Hello " + customerName + ", SupplyDesk has received your quote request. We will check it against current manufacturing capacity and update you here and in your Buyer Dashboard.",
          bodyHtml: '<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px"><tr><td style="padding:8px 0;color:#58717c">Product</td><td style="padding:8px 0;font-weight:700">' + escapeEmailHtml(selectedProductName || "") + '</td></tr>' + (selectedCode ? '<tr><td style="padding:8px 0;color:#58717c">Capability ID</td><td style="padding:8px 0;font-weight:700">' + escapeEmailHtml(selectedCode) + '</td></tr>' : '') + (quantity ? '<tr><td style="padding:8px 0;color:#58717c">Quantity</td><td style="padding:8px 0;font-weight:700">' + escapeEmailHtml(quantity) + '</td></tr>' : '') + '<tr><td style="padding:8px 0;color:#58717c">Request ID</td><td style="padding:8px 0;font-weight:700">' + escapeEmailHtml(enquiryId.slice(0,8).toUpperCase()) + '</td></tr></table>',
          textLines: ["Product: " + (selectedProductName || ""), selectedCode ? "Capability ID: " + selectedCode : "", quantity ? "Quantity: " + quantity : "", "Request ID: " + enquiryId.slice(0,8).toUpperCase()].filter(Boolean),
          ctaText: "Track in Buyer Dashboard", ctaUrl: ORIGIN() + "/buyer-dashboard"
        });
      }
      return res.status(201).json({ ok:true, enquiryId, message:"Quote request sent to SupplyDesk. We will check capacity and update you in your Buyer Dashboard." });
    }

    const supplierName = supplier.trade_name || supplier.legal_name;
    const subject = "SupplyDesk: New connection request" + (selectedProductName ? " for " + selectedProductName : "");
    const supplierText = [
      "A customer wants to connect with " + supplierName + " through SupplyDesk.",
      "",
      "Customer: " + customerName,
      "Email: " + customerEmail,
      customerCompany ? "Company: " + customerCompany : "",
      customerCountry ? "Country: " + customerCountry : "",
      customerPhone ? "Mobile: " + customerPhone : "",
      selectedProductName ? "Product / requirement: " + selectedProductName : "Category: " + supplier.category + " / " + supplier.subcategory,
      quantity ? "Quantity / requirement: " + quantity : "",
      message ? "Message: " + message : "",
      "",
      "Please contact the customer directly to continue the discussion.",
      "",
      "This connection was initiated on SupplyDesk.",
      "Enquiry ID: " + enquiryId
    ].filter(Boolean).join("\n");

    if (!authorizedE2e) try {
      const info = await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: supplier.business_email,
        replyTo: customerEmail,
        subject,
        text: supplierText
      });
      console.log("Connection email sent:", {requestId,enquiryId,supplierId,to:supplier.business_email,messageId:info.messageId});
    } catch (mailError) {
      console.error("Connection email delivery failed:", {requestId,enquiryId,supplierId,to:supplier.business_email,code:mailError?.code,responseCode:mailError?.responseCode,command:mailError?.command,response:mailError?.response,message:mailError?.message});
      return res.status(502).json({error:"Connection request was saved, but the supplier email could not be delivered. Please try again.",requestId});
    }

    if (!authorizedE2e) try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: customerEmail,
        subject: "SupplyDesk: Connection request sent to " + supplierName,
        text: [
          "Your connection request has been sent to " + supplierName + " through SupplyDesk.",
          "",
          selectedProductName ? "Requirement: " + selectedProductName : "",
          quantity ? "Quantity: " + quantity : "",
          "The supplier has been notified and may contact you directly.",
          "",
          "Enquiry ID: " + enquiryId,
          "",
          "SupplyDesk is an information and connection platform. Any commercial discussion or transaction is arranged directly between you and the supplier."
        ].filter(Boolean).join("\n")
      });
    } catch (customerMailError) {
      console.error("Customer confirmation email failed:", {enquiryId,to:customerEmail,code:customerMailError?.code,responseCode:customerMailError?.responseCode,message:customerMailError?.message});
    }

    return res.status(201).json({
      ok:true,
      enquiryId,
      message:"Connection request sent to the supplier. A confirmation has also been sent to your email."
    });
  } catch (error) {
    console.error("Connection request failed:", {requestId,enquiryId,supplierId,code:error?.code,message:error?.message});
    res.status(500).json({error:"Could not save the connection request. Please try again.",requestId});
  }
});

// Admin: connection request queue
app.get("/api/admin/connect-requests", requireAdmin, async (req,res)=>{
  const status=clean(req.query.status,40);
  const allowed=["new","contacted","in_discussion","closed"];
  const params=[];
  let sql=`SELECT c.id,c.supplier_id,c.customer_name,c.customer_email,c.customer_phone,c.product_name,c.source_action,c.message,c.status,c.created_at,c.updated_at,c.enquiry_id,
                   b.company AS customer_company,b.country AS customer_country,e.quantity,
                   e.decision,e.approved_quantity,e.buyer_remark,e.decided_at,e.decided_by,
                   p.id AS product_id,p.capability_code,p.monthly_capacity,p.available_capacity,p.capacity_unit,p.lead_time_days,p.capacity_updated_at,
                   s.legal_name,s.trade_name,s.country,s.city
            FROM connect_requests c
            LEFT JOIN buyers b ON b.email=c.customer_email
            LEFT JOIN buyer_enquiries e ON e.id=c.enquiry_id
            LEFT JOIN supplier_products p ON p.id=e.product_id
            JOIN supplier_profiles s ON s.id=c.supplier_id`;
  if(allowed.includes(status)){sql+=" WHERE c.status=?";params.push(status);}
  sql+=" ORDER BY c.created_at DESC LIMIT 300";
  try{
    const [rows]=await pool.execute(sql,params);
    res.json({requests:rows.map(r=>maskSupplierRow(req,r)),detailsRestricted:!isSuper(req)});
  }catch(error){
    console.error("Admin connection requests failed:",error);
    res.status(500).json({error:"Could not load connection requests."});
  }
});

app.patch("/api/admin/connect-requests/:id", requireAdmin, async (req,res)=>{
  const status=clean(req.body?.status,40);
  if(!["new","contacted","in_discussion","closed"].includes(status)) return res.status(400).json({error:"Invalid connection request status."});
  try{
    const [result]=await pool.execute("UPDATE connect_requests SET status=?,updated_at=NOW() WHERE id=?",[status,clean(req.params.id,80)]);
    if(!result.affectedRows)return res.status(404).json({error:"Connection request not found."});
    try { await pool.execute("UPDATE buyer_enquiries SET status=?,updated_at=NOW() WHERE id=(SELECT enquiry_id FROM connect_requests WHERE id=?)",[status,clean(req.params.id,80)]); } catch (e) { console.warn("Buyer enquiry status sync skipped:",e?.message); }
    res.json({ok:true,status});
  }catch(error){
    console.error("Admin connection request update failed:",error);
    res.status(500).json({error:"Could not update connection request."});
  }
});

// Admin: decide a buyer quote request against current capacity (accept / partial / reject) and tell the buyer.
app.post("/api/admin/connect-requests/:id/decision", requireAdmin, async (req,res)=>{
  const decision=clean(req.body?.decision,20);
  const approvedQuantity=clean(req.body?.approved_quantity,120)||null;
  const remark=clean(req.body?.remark,1500)||null;
  if(!["accepted","partial","rejected"].includes(decision)) return res.status(400).json({error:"Choose accept, partial or reject."});
  if(decision==="partial" && !approvedQuantity) return res.status(400).json({error:"Enter the quantity you can supply for a partial acceptance."});
  if(decision!=="accepted" && !remark) return res.status(400).json({error:"Add a remark so the buyer understands the decision."});
  try{
    const id=clean(req.params.id,80);
    const [[row]]=await pool.execute(
      `SELECT c.id,c.enquiry_id,c.customer_email,c.customer_name,c.product_name,e.quantity,p.capability_code
       FROM connect_requests c JOIN buyer_enquiries e ON e.id=c.enquiry_id LEFT JOIN supplier_products p ON p.id=e.product_id WHERE c.id=?`,[id]);
    if(!row) return res.status(404).json({error:"Request not found."});
    const status=decision==="rejected"?"closed":"in_discussion";
    await pool.execute("UPDATE buyer_enquiries SET decision=?,approved_quantity=?,buyer_remark=?,decided_at=NOW(),decided_by=?,status=?,updated_at=NOW() WHERE id=?",
      [decision,decision==="accepted"?(row.quantity||null):approvedQuantity,remark,req.admin.admin_id||req.admin.id||"admin",status,row.enquiry_id]);
    await pool.execute("UPDATE connect_requests SET status=?,updated_at=NOW() WHERE id=?",[status,id]);
    await audit(pool,req,"quote_request.decided","quote_request",id,null,{decision,approvedQuantity:decision==="accepted"?(row.quantity||null):approvedQuantity,remark});
    const label={accepted:"Accepted",partial:"Partially accepted",rejected:"Not available"}[decision];
    const lead={accepted:"Good news. SupplyDesk can supply the quantity you asked for.",partial:"SupplyDesk can supply part of the quantity you asked for.",rejected:"SupplyDesk is unable to supply this request right now."}[decision];
    const rows=[["Product",row.product_name||""],row.capability_code?["Capability ID",row.capability_code]:null,["Requested",row.quantity||"-"],decision==="partial"?["Available to you",approvedQuantity]:null,remark?["Remarks",remark]:null].filter(Boolean);
    await sendBrandedMail(row.customer_email,"SupplyDesk | Quote request "+label.toLowerCase(),{
      preheader:label,title:"Quote request: "+label,intro:"Hello "+(row.customer_name||"Buyer")+", "+lead,
      bodyHtml:'<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">'+rows.map(r=>'<tr><td style="padding:8px 0;color:#58717c;vertical-align:top">'+escapeEmailHtml(r[0])+'</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(r[1])+'</td></tr>').join("")+'</table>',
      textLines:rows.map(r=>r[0]+": "+r[1]),ctaText:"View in Buyer Dashboard",ctaUrl:ORIGIN()+"/buyer-dashboard"});
    res.json({ok:true,decision,status});
  }catch(error){console.error("Quote request decision failed:",error);res.status(500).json({error:"Could not save the decision."});}
});

// Supplier: update the status of one of its own requests
app.patch("/api/supplier-dashboard/connections/:id", requireSupplierDashboard, async (req,res)=>{
  const status=clean(req.body?.status,40);
  if(!["new","contacted","in_discussion","closed"].includes(status)) return res.status(400).json({error:"Invalid connection request status."});
  try{
    const [result]=await pool.execute(
      "UPDATE connect_requests SET status=?,updated_at=NOW() WHERE id=? AND supplier_id=?",
      [status,clean(req.params.id,80),req.supplier.id]
    );
    if(!result.affectedRows)return res.status(404).json({error:"Connection request not found."});
    res.json({ok:true,status});
  }catch(error){
    console.error("Supplier connection status update failed:",error);
    res.status(500).json({error:"Could not update connection request."});
  }
});


app.post("/api/buyer-requirements", buyerRequirementLimiter, async(req,res)=>{
  const buyer=await getBuyerByDashboardToken(clean(req.body?.dashboardToken,256)); if(!buyer)return res.status(401).json({error:"Please verify your email before submitting a requirement."});
  const type=["product","raw_material","machinery","service","custom"].includes(req.body?.requirementType)?req.body.requirementType:"product";
  const buyerName=clean(req.body?.buyerName,180),buyerCompany=clean(req.body?.buyerCompany,180),buyerCountry=clean(req.body?.buyerCountry,120),buyerPhone=clean(req.body?.buyerPhone,80);
  const title=clean(req.body?.title,255),category=clean(req.body?.category,180)||null,subcategory=clean(req.body?.subcategory,180)||null,description=clean(req.body?.description,5000),quantity=clean(req.body?.quantity,120)||null,unit=clean(req.body?.unit,80)||null,currency=clean(req.body?.currency,10).toUpperCase()||"USD",deliveryCountry=clean(req.body?.deliveryCountry,120)||null,deliveryCity=clean(req.body?.deliveryCity,150)||null,requiredBy=clean(req.body?.requiredBy,20)||null,marketScope=["Domestic","International","Both"].includes(req.body?.marketScope)?req.body.marketScope:"Both";
  const targetPrice=req.body?.targetPrice===""||req.body?.targetPrice==null?null:Number(req.body.targetPrice);
  if(!buyerName||!buyerCountry)return res.status(400).json({error:"Name and country are required."}); if(!title||!description)return res.status(400).json({error:"Requirement title and description are required."}); if(targetPrice!==null&&(!Number.isFinite(targetPrice)||targetPrice<0))return res.status(400).json({error:"Enter a valid target price."});
  try{
    // Compute merged profile values in JS (no COALESCE/NULLIF collation mixing in SQL).
    await pool.execute("UPDATE buyers SET name=?,company=?,country=?,phone=?,last_seen=NOW() WHERE id=?",[buyerName||buyer.name||null,buyerCompany||buyer.company||null,buyerCountry||buyer.country||null,buyerPhone||buyer.phone||null,buyer.id]);
    const id=crypto.randomUUID();
    const specification=clean(req.body?.specification,4000)||null,qualityStandards=clean(req.body?.qualityStandards,1500)||null,certifications=clean(req.body?.certifications,255)||null,packaging=clean(req.body?.packaging,1500)||null,paymentTerms=clean(req.body?.paymentTerms,255)||null,incoterm=clean(req.body?.incoterm,40)||null;
    let rfqCode=null;
    for(let attempt=0;attempt<8;attempt++){
      rfqCode=RFQ.newRfqCode();
      try{
        await pool.execute("INSERT INTO buyer_requirements (id,buyer_id,requirement_type,title,category,subcategory,description,quantity,unit,target_price,currency,delivery_country,delivery_city,required_by,market_scope,status,rfq_code,rfq_state,state_changed_at,specification,quality_standards,certifications,packaging,payment_terms,incoterm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?,'submitted',NOW(),?,?,?,?,?,?)",[id,buyer.id,type,title,category,subcategory,description,quantity,unit,targetPrice,currency,deliveryCountry,deliveryCity,requiredBy||null,marketScope,rfqCode,specification,qualityStandards,certifications,packaging,paymentTerms,incoterm]);
        break;
      }catch(e){ if(e?.code!=="ER_DUP_ENTRY"||attempt===7) throw e; }
    }
    await audit(pool,{buyer},"rfq.created","rfq",id,null,{rfqCode,title,quantity,category,subcategory});
    try{if(buyer.email&&process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASSWORD&&process.env.SMTP_FROM){const cm=buildProfessionalEmail({preheader:"We received your sourcing requirement",title:"Requirement received",intro:"Hello "+(buyerName||"Buyer")+", your sourcing requirement has been submitted. The SupplyDesk team will review it and share it with matching suppliers. We will email you at each step.",bodyHtml:'<div style="margin:20px 0;padding:16px;background:#f4f9fc;border:1px solid #dbe8ed;border-radius:12px"><div style="font-size:12px;color:#58717c;text-transform:uppercase;font-weight:700;letter-spacing:1px">Your requirement</div><div style="font-size:16px;font-weight:700;margin-top:6px">'+escapeEmailHtml(title)+'</div></div><p style="line-height:1.6">Status: <strong>Under SupplyDesk review</strong>. Your email and phone number stay private. You can track progress and quotations in your Buyer Dashboard.</p>',textLines:["Hello "+(buyerName||"Buyer")+",","","Your sourcing requirement has been submitted:",title,"","Quotations will appear in your Buyer Dashboard."],ctaText:"Open Buyer Dashboard",ctaUrl:String(process.env.PUBLIC_ORIGIN||"https://supplydesk.in").replace(/\/$/,"")+"/buyer-dashboard.html"});await mailer.sendMail({from:process.env.SMTP_FROM,replyTo:process.env.SMTP_FROM,to:buyer.email,subject:"SupplyDesk | Requirement received",text:cm.text,html:cm.html});}}catch(mailError){console.error("Requirement confirmation email failed:",mailError);}
res.status(201).json({ok:true,requirementId:id,rfqCode,status:"pending_review",message:"Requirement submitted. SupplyDesk will review it and share it with matching suppliers. You can track it in your Buyer Dashboard."});}catch(error){const ref=crypto.randomUUID().slice(0,8);console.error("Requirement submit failed ["+ref+"]:",{code:error?.code,errno:error?.errno,sqlMessage:error?.sqlMessage||error?.message});res.status(500).json({error:"Could not submit the requirement. Please try again. (Ref "+ref+")"});}
});
app.get("/api/buyer-requirements",requireBuyerDashboard,async(req,res)=>{try{const [requirements]=await pool.execute("SELECT r.id,r.rfq_code,r.rfq_state,r.required_by,r.requirement_type,r.title,r.category,r.subcategory,r.quantity,r.unit,r.delivery_country,r.status,r.fulfilment_mode,r.buyer_note,r.created_at,r.reviewed_at,(SELECT COUNT(*) FROM requirement_supplier_matches m WHERE m.requirement_id=r.id) sent_count,(SELECT COUNT(*) FROM supplier_quotes q WHERE q.requirement_id=r.id AND q.status='submitted') quote_count FROM buyer_requirements r WHERE r.buyer_id=? ORDER BY r.created_at DESC LIMIT 100",[req.buyer.id]);res.json({requirements:requirements.map(r=>{const st=r.rfq_state||RFQ.LEGACY_STATUS_TO_STATE[r.status]||"submitted";return {...r,rfq_state:st,stateLabel:(RFQ.STATES[st]||RFQ.STATES.submitted).buyerLabel};})});}catch(error){res.status(500).json({error:"Could not load requirements."});}});
app.get("/api/buyer-requirements/:id/quotes",requireBuyerDashboard,async(req,res)=>{try{const [[requirement]]=await pool.execute("SELECT id,title,status FROM buyer_requirements WHERE id=? AND buyer_id=?",[clean(req.params.id,80),req.buyer.id]);if(!requirement)return res.status(404).json({error:"Requirement not found."});const [sdQuotes]=await pool.execute("SELECT id,quote_no,unit_price,currency,quantity,total_price,lead_time_days,valid_until,terms,note,status,created_at,responded_at FROM rfq_quotes WHERE rfq_id=? AND status IN ('sent','accepted','rejected') ORDER BY created_at DESC",[requirement.id]);if(HIDE_SUPPLIERS)return res.json({requirement,quotes:[],sdQuotes});const [quotes]=await pool.execute("SELECT q.id,q.unit_price,q.currency,q.quantity_available,q.moq,q.lead_time,q.payment_terms,q.incoterm,q.quote_valid_until,q.sample_available,q.notes,q.status,q.created_at,s.id supplier_id,s.trade_name,s.legal_name,s.country,s.city FROM supplier_quotes q JOIN supplier_profiles s ON s.id=q.supplier_id WHERE q.requirement_id=? AND q.status='submitted' ORDER BY q.created_at DESC",[requirement.id]);res.json({requirement,quotes:HIDE_SUPPLIERS?quotes.map((q,i)=>{const {supplier_id,trade_name,legal_name,country,city,...rest}=q;return {...rest,supplier_label:"SupplyDesk sourcing partner #"+(quotes.length-i)};}):quotes,sdQuotes});}catch(error){res.status(500).json({error:"Could not load quotations."});}});
app.get("/api/supplier-dashboard/requirements",requireSupplierDashboard,async(req,res)=>{try{const [rows]=await pool.execute("SELECT r.id,r.requirement_type,r.title,r.category,r.subcategory,r.description,r.quantity,r.unit,r.target_price,r.currency,r.delivery_country,r.delivery_city,r.required_by,r.market_scope,r.created_at,m.status match_status,q.id quote_id,q.unit_price quote_unit_price,q.currency quote_currency,q.updated_at quote_updated_at FROM buyer_requirements r JOIN requirement_supplier_matches m ON m.requirement_id=r.id AND m.supplier_id=? LEFT JOIN supplier_quotes q ON q.requirement_id=r.id AND q.supplier_id=? AND q.status='submitted' WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 100",[req.supplier.id,req.supplier.id]);res.json({requirements:rows});}catch(error){res.status(500).json({error:"Could not load buyer requirements."});}});
app.post("/api/supplier-dashboard/requirements/:id/view",requireSupplierDashboard,async(req,res)=>{try{const id=clean(req.params.id,80),[[r]]=await pool.execute("SELECT id,status FROM buyer_requirements WHERE id=?",[id]);if(!r||r.status!=="open")return res.status(404).json({error:"Requirement is no longer open."});const [vr]=await pool.execute("UPDATE requirement_supplier_matches SET status=IF(status='quoted',status,'viewed'),viewed_at=COALESCE(viewed_at,NOW()) WHERE requirement_id=? AND supplier_id=?",[id,req.supplier.id]);if(!vr.affectedRows)return res.status(404).json({error:"Requirement is no longer open."});res.json({ok:true});}catch(error){res.status(500).json({error:"Could not record requirement view."});}});
app.post("/api/supplier-dashboard/requirements/:id/quote",requireSupplierDashboard,async(req,res)=>{
  const id=clean(req.params.id,80),unitPrice=Number(req.body?.unitPrice),currency=clean(req.body?.currency,10).toUpperCase()||"USD",quantityAvailable=clean(req.body?.quantityAvailable,120)||null,moq=clean(req.body?.moq,120)||null,leadTime=clean(req.body?.leadTime,120)||null,paymentTerms=clean(req.body?.paymentTerms,255)||null,incoterm=clean(req.body?.incoterm,40)||null,quoteValidUntil=clean(req.body?.quoteValidUntil,20)||null,notes=clean(req.body?.notes,3000)||null,sampleAvailable=req.body?.sampleAvailable?1:0;
  if(!Number.isFinite(unitPrice)||unitPrice<0)return res.status(400).json({error:"Enter a valid unit price."});
  try{const [[r]]=await pool.execute("SELECT r.* FROM buyer_requirements r JOIN requirement_supplier_matches m ON m.requirement_id=r.id AND m.supplier_id=? WHERE r.id=? AND r.status='open'",[req.supplier.id,id]);if(!r)return res.status(404).json({error:"Requirement is no longer open."});
    await pool.execute("INSERT INTO supplier_quotes (id,requirement_id,supplier_id,unit_price,currency,quantity_available,moq,lead_time,payment_terms,incoterm,quote_valid_until,sample_available,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE unit_price=VALUES(unit_price),currency=VALUES(currency),quantity_available=VALUES(quantity_available),moq=VALUES(moq),lead_time=VALUES(lead_time),payment_terms=VALUES(payment_terms),incoterm=VALUES(incoterm),quote_valid_until=VALUES(quote_valid_until),sample_available=VALUES(sample_available),notes=VALUES(notes),status='submitted',updated_at=NOW()",[crypto.randomUUID(),id,req.supplier.id,unitPrice,currency,quantityAvailable,moq,leadTime,paymentTerms,incoterm,quoteValidUntil||null,sampleAvailable,notes]);
    await pool.execute("INSERT INTO requirement_supplier_matches (id,requirement_id,supplier_id,status,viewed_at) VALUES (?,?,?,'quoted',NOW()) ON DUPLICATE KEY UPDATE status='quoted',viewed_at=COALESCE(viewed_at,NOW())",[crypto.randomUUID(),id,req.supplier.id]);
    try{const [[buyer]]=await pool.execute("SELECT email,name FROM buyers WHERE id=?",[r.buyer_id]);if(buyer?.email&&process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASSWORD&&process.env.SMTP_FROM){const qm=buildProfessionalEmail({preheader:"A supplier has quoted on your requirement",title:"New quotation received",intro:"Hello "+(buyer.name||"Buyer")+", a supplier has submitted a quotation for your requirement.",bodyHtml:'<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px"><tr><td style="padding:8px 0;color:#58717c">Requirement</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(r.title)+'</td></tr><tr><td style="padding:8px 0;color:#58717c">Supplier</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(req.supplier.trade_name||req.supplier.legal_name||"Supplier")+'</td></tr><tr><td style="padding:8px 0;color:#58717c">Unit price</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(unitPrice+" "+currency)+'</td></tr>'+(moq?'<tr><td style="padding:8px 0;color:#58717c">MOQ</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(moq)+'</td></tr>':"")+(leadTime?'<tr><td style="padding:8px 0;color:#58717c">Lead time</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(leadTime)+'</td></tr>':"")+'</table>',textLines:["Hello "+(buyer.name||"Buyer")+",","","A supplier has submitted a quotation for your requirement:",r.title,"Supplier: "+(req.supplier.trade_name||req.supplier.legal_name||"Supplier"),"Unit price: "+unitPrice+" "+currency,moq?"MOQ: "+moq:"",leadTime?"Lead time: "+leadTime:""].filter(x=>x!==""),ctaText:"Open Buyer Dashboard",ctaUrl:String(process.env.PUBLIC_ORIGIN||"https://supplydesk.in").replace(/\/$/,"")+"/buyer-dashboard.html"});
await mailer.sendMail({from:process.env.SMTP_FROM,replyTo:process.env.SMTP_FROM,to:buyer.email,subject:"SupplyDesk | New quotation received",text:qm.text,html:qm.html});}}catch(mailError){console.error("Buyer quote notification failed:",mailError);}
    try{const c=await pool.getConnection();try{await c.beginTransaction();const [[st]]=await c.execute("SELECT rfq_state FROM buyer_requirements WHERE id=?",[id]);if(st?.rfq_state==="sourcing")await moveRfq(c,{supplier:req.supplier},id,"quotes_received","first supplier quote");await audit(c,{supplier:req.supplier},"supplier.quote_submitted","rfq",id,null,{supplierId:req.supplier.id,unitPrice,currency});await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}}catch(auditError){console.error("RFQ state/audit after supplier quote failed:",auditError);}
    res.status(201).json({ok:true,message:"Quotation sent to the buyer successfully."});
  }catch(error){console.error("Supplier quote failed:",error);res.status(500).json({error:"Could not submit the quotation."});}
});
app.patch("/api/buyer-requirements/:id",requireBuyerDashboard,async(req,res)=>{const status=clean(req.body?.status,20);if(!["closed","cancelled"].includes(status))return res.status(400).json({error:"Invalid requirement status."});const rid=clean(req.params.id,80);const conn=await pool.getConnection();try{await conn.beginTransaction();const [[own]]=await conn.execute("SELECT id FROM buyer_requirements WHERE id=? AND buyer_id=?",[rid,req.buyer.id]);if(!own){await conn.rollback();return res.status(404).json({error:"Requirement not found."});}await moveRfq(conn,req,rid,status==="cancelled"?"cancelled":"closed","buyer request");await conn.execute("UPDATE buyer_requirements SET status=?,updated_at=NOW() WHERE id=?",[status,rid]);await conn.commit();res.json({ok:true,status});}catch(error){await conn.rollback();if(error instanceof RfqError)return res.status(error.status).json({error:error.message});console.error("Buyer requirement update failed:",error);res.status(500).json({error:"Could not update requirement."});}finally{conn.release();}});
app.get("/api/admin/requirements",requireAdmin,async(req,res)=>{try{const [requirements]=await pool.execute("SELECT r.*,b.email buyer_email,b.name buyer_name,b.company buyer_company,b.phone buyer_phone,(SELECT COUNT(*) FROM supplier_quotes q WHERE q.requirement_id=r.id AND q.status='submitted') quote_count FROM buyer_requirements r JOIN buyers b ON b.id=r.buyer_id ORDER BY r.created_at DESC LIMIT 300");res.json({requirements});}catch(error){res.status(500).json({error:"Could not load buyer requirements."});}});

async function sendBrandedMail(to,subject,opts){
  if(!to||!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASSWORD||!process.env.SMTP_FROM)return false;
  try{const m=buildProfessionalEmail(opts);await mailer.sendMail({from:process.env.SMTP_FROM,replyTo:process.env.SMTP_FROM,to,subject,text:m.text,html:m.html});return true;}
  catch(e){console.error("Mail failed:",subject,e?.message);return false;}
}
const ORIGIN=()=>String(process.env.PUBLIC_ORIGIN||"https://supplydesk.in").replace(/\/$/,"");
const REQ_STATUS_LABEL={pending_review:"Under SupplyDesk review",open:"Shared with suppliers",fulfilling:"SupplyDesk is handling your requirement",rejected:"Not accepted",closed:"Closed",cancelled:"Cancelled"};

// Keep the buyer-facing order status in step with supplier POs (never moves backwards; delivery stays a manual SupplyDesk confirmation).
//  confirmed -> in_production when any live PO is in production/dispatched/completed
//  in_production -> shipped when every live PO (not declined/cancelled) is dispatched or completed
async function syncOrderFromPos(conn,req,orderId){
  const [[o]]=await conn.execute("SELECT o.id,o.po_number,o.status,o.title,b.email,b.name FROM orders o JOIN buyers b ON b.id=o.buyer_id WHERE o.id=? FOR UPDATE",[orderId]);
  if(!o||!["confirmed","in_production"].includes(o.status))return null;
  const [pos]=await conn.execute("SELECT status FROM supplier_pos WHERE order_id=? AND status NOT IN ('declined','cancelled')",[orderId]);
  if(!pos.length)return null;
  let to=null;
  if(pos.every(p=>["dispatched","completed"].includes(p.status)))to="shipped";
  else if(o.status==="confirmed"&&pos.some(p=>["in_production","dispatched","completed"].includes(p.status)))to="in_production";
  if(!to||to===o.status||!RFQ.canOrderTransition(o.status,to))return null;
  await conn.execute("UPDATE orders SET status=?,status_changed_at=NOW() WHERE id=?",[to,orderId]);
  await audit(conn,req,"order.status_change","order",orderId,{status:o.status},{status:to,note:"auto: supplier progress"});
  return {order:o,to};
}
// Margin report: Super Admin only. Revenue = accepted SupplyDesk price; cost = supplier PO cost (active POs) or the cost noted on the quote.
app.get("/api/super-admin/margin-report",requireSuperAdmin,async(req,res)=>{
  try{
    const [rows]=await pool.execute(`SELECT o.id,o.po_number,o.title,o.quantity,o.unit_price,o.currency,o.total_price,o.status,o.created_at,b.company buyer_company,b.name buyer_name,
        q.cost_unit_price,q.markup_pct,
        (SELECT COALESCE(SUM(po.total_cost),0) FROM supplier_pos po WHERE po.order_id=o.id AND po.status NOT IN ('declined','cancelled')) po_cost,
        (SELECT COUNT(*) FROM supplier_pos po WHERE po.order_id=o.id AND po.status NOT IN ('declined','cancelled')) po_count
      FROM orders o JOIN buyers b ON b.id=o.buyer_id LEFT JOIN rfq_quotes q ON q.id=o.rfq_quote_id WHERE o.status<>'cancelled' ORDER BY o.created_at DESC LIMIT 300`);
    const items=rows.map(r=>{
      const revenue=r.total_price==null?null:Number(r.total_price);
      const qty=RFQ.parseQuantity(r.quantity);
      let cost=Number(r.po_count)?Number(r.po_cost):(r.cost_unit_price&&qty?Math.round(Number(r.cost_unit_price)*qty*100)/100:null);
      const source=Number(r.po_count)?"supplier_po":(cost!=null?"quote_estimate":null);
      const margin=revenue!=null&&cost!=null?Math.round((revenue-cost)*100)/100:null;
      return {id:r.id,poNumber:r.po_number,title:r.title,buyer:r.buyer_company||r.buyer_name,currency:r.currency,status:r.status,revenue,cost,costSource:source,margin,marginPctOnPrice:margin!=null&&revenue?Math.round(margin/revenue*10000)/100:null,markupPct:r.markup_pct==null?null:Number(r.markup_pct),createdAt:r.created_at};
    });
    const totals={};
    for(const i of items){if(i.margin==null)continue;const t=totals[i.currency]||(totals[i.currency]={revenue:0,cost:0,margin:0,orders:0});t.revenue+=i.revenue;t.cost+=i.cost;t.margin+=i.margin;t.orders++;}
    for(const t of Object.values(totals)){t.revenue=Math.round(t.revenue*100)/100;t.cost=Math.round(t.cost*100)/100;t.margin=Math.round(t.margin*100)/100;t.marginPctOnPrice=t.revenue?Math.round(t.margin/t.revenue*10000)/100:null;}
    res.json({items,totals});
  }catch(error){console.error("Margin report failed:",error);res.status(500).json({error:"Could not load the margin report."});}
});

// ---- Invoices & payments (Phase 5): internal tracking, GST % shown. Not a statutory tax invoice (no GSTIN/HSN). ----
app.post("/api/admin/orders/:id/invoice",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),b=req.body||{};
  const gstRate=b.gstRate===""||b.gstRate==null?0:Number(b.gstRate),dueDate=clean(b.dueDate,10)||null,notes=clean(b.notes,1000)||null;
  if(!Number.isFinite(gstRate)||gstRate<0||gstRate>28)return res.status(400).json({error:"GST rate must be between 0 and 28."});
  if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))return res.status(400).json({error:"Enter a valid due date."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[o]]=await conn.execute("SELECT o.id,o.po_number,o.title,o.status,o.buyer_id,o.currency,o.total_price,b.email,b.name FROM orders o JOIN buyers b ON b.id=o.buyer_id WHERE o.id=? FOR UPDATE",[id]);
    if(!o){await conn.rollback();return res.status(404).json({error:"Order not found."});}
    if(o.status==="cancelled"){await conn.rollback();return res.status(409).json({error:"A cancelled order cannot be invoiced."});}
    const [[dup]]=await conn.execute("SELECT id FROM invoices WHERE order_id=? AND status<>'void' LIMIT 1",[id]);
    if(dup){await conn.rollback();return res.status(409).json({error:"This order already has an active invoice. Void it first to issue a new one."});}
    const subtotal=b.subtotal===""||b.subtotal==null?Number(o.total_price):Number(b.subtotal);
    const calc=RFQ.computeInvoice(subtotal,gstRate);
    if(!calc){await conn.rollback();return res.status(400).json({error:"Enter a valid invoice amount."});}
    const iid=crypto.randomUUID();let no;
    for(let a=0;a<8;a++){no=RFQ.newInvoiceNo();try{
      await conn.execute("INSERT INTO invoices (id,invoice_no,order_id,buyer_id,subtotal,gst_rate,gst_amount,total,currency,due_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[iid,no,id,o.buyer_id,calc.subtotal,gstRate,calc.gst,calc.total,o.currency,dueDate,notes,actorOf(req).id]);break;}
      catch(e){if(e?.code!=="ER_DUP_ENTRY"||a===7)throw e;}}
    await audit(conn,req,"invoice.issued","invoice",iid,null,{invoiceNo:no,orderId:id,subtotal:calc.subtotal,gstRate,total:calc.total,currency:o.currency});
    await conn.commit();
    try{await sendBrandedMail(o.email,"SupplyDesk | Invoice "+no,{preheader:"Invoice issued",title:"Invoice "+no,intro:"Hello "+(o.name||"Buyer")+", an invoice for order "+o.po_number+" ("+o.title+") has been issued. Total: "+calc.total+" "+o.currency+(dueDate?", due "+dueDate:"")+".",bodyHtml:"",textLines:["Invoice "+no+": "+calc.total+" "+o.currency],ctaText:"View invoice",ctaUrl:ORIGIN()+"/buyer-dashboard"});}catch(e){console.error("Invoice mail failed:",e);}
    res.status(201).json({ok:true,invoiceId:iid,invoiceNo:no,...calc});
  }catch(error){await conn.rollback();console.error("Invoice failed:",error);res.status(500).json({error:"Could not issue the invoice."});}
  finally{conn.release();}
});

app.get("/api/admin/orders/:id/invoice",requireAdmin,async(req,res)=>{
  try{const oid=clean(req.params.id,80);
    const [invoices]=await pool.execute("SELECT id,invoice_no,subtotal,gst_rate,gst_amount,total,currency,due_date,notes,status,paid_amount,created_at FROM invoices WHERE order_id=? ORDER BY created_at DESC",[oid]);
    const [payments]=invoices.length?await pool.query("SELECT id,invoice_id,amount,method,reference,received_on,note,recorded_by,created_at FROM payments WHERE invoice_id IN (?) ORDER BY received_on,created_at",[invoices.map(i=>i.id)]):[[]];
    res.json({invoices:invoices.map(i=>({...i,outstanding:RFQ.fromMinor(RFQ.toMinor(i.total)-RFQ.toMinor(i.paid_amount)),payments:payments.filter(p=>p.invoice_id===i.id)}))});}
  catch(error){console.error(error);res.status(500).json({error:"Could not load invoices."});}
});

app.post("/api/admin/invoices/:id/payments",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),b=req.body||{};
  const amount=Number(b.amount),method=clean(b.method,20),reference=clean(b.reference,120)||null,note=clean(b.note,500)||null;
  const receivedOn=clean(b.receivedOn,10)||new Date().toISOString().slice(0,10);
  if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"Enter a valid payment amount."});
  if(!RFQ.PAYMENT_METHODS.includes(method))return res.status(400).json({error:"Choose a payment method."});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)||new Date(receivedOn)>new Date(Date.now()+86400000))return res.status(400).json({error:"Received date cannot be in the future."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[inv]]=await conn.execute("SELECT i.id,i.invoice_no,i.total,i.paid_amount,i.status,i.currency,b.email,b.name FROM invoices i JOIN buyers b ON b.id=i.buyer_id WHERE i.id=? FOR UPDATE",[id]);
    if(!inv){await conn.rollback();return res.status(404).json({error:"Invoice not found."});}
    if(inv.status==="void"){await conn.rollback();return res.status(409).json({error:"This invoice is void."});}
    const outstanding=RFQ.toMinor(inv.total)-RFQ.toMinor(inv.paid_amount),pay=RFQ.toMinor(amount);
    if(outstanding<=0){await conn.rollback();return res.status(409).json({error:"This invoice is already fully paid."});}
    if(pay>outstanding){await conn.rollback();return res.status(400).json({error:"Payment exceeds the outstanding amount ("+RFQ.fromMinor(outstanding)+" "+inv.currency+")."});}
    const newPaid=RFQ.fromMinor(RFQ.toMinor(inv.paid_amount)+pay),status=RFQ.invoiceStatus(inv.total,newPaid);
    const pid=crypto.randomUUID();
    await conn.execute("INSERT INTO payments (id,invoice_id,amount,method,reference,received_on,note,recorded_by) VALUES (?,?,?,?,?,?,?,?)",[pid,id,RFQ.fromMinor(pay),method,reference,receivedOn,note,actorOf(req).id]);
    await conn.execute("UPDATE invoices SET paid_amount=?,status=? WHERE id=?",[newPaid,status,id]);
    await audit(conn,req,"payment.recorded","invoice",id,{status:inv.status,paid:inv.paid_amount},{status,paid:newPaid,amount:RFQ.fromMinor(pay),method,reference});
    await conn.commit();
    try{await sendBrandedMail(inv.email,"SupplyDesk | Payment received for "+inv.invoice_no,{preheader:"Payment received",title:"Payment received",intro:"Hello "+(inv.name||"Buyer")+", we received "+RFQ.fromMinor(pay)+" "+inv.currency+" against invoice "+inv.invoice_no+"."+(status==="paid"?" The invoice is now fully paid. Thank you.":" Outstanding: "+RFQ.fromMinor(RFQ.toMinor(inv.total)-RFQ.toMinor(newPaid))+" "+inv.currency+"."),bodyHtml:"",textLines:[inv.invoice_no+" payment received"],ctaText:"View invoice",ctaUrl:ORIGIN()+"/buyer-dashboard"});}catch(e){console.error("Payment mail failed:",e);}
    res.status(201).json({ok:true,paymentId:pid,status,paid:newPaid});
  }catch(error){await conn.rollback();console.error("Payment failed:",error);res.status(500).json({error:"Could not record the payment."});}
  finally{conn.release();}
});

app.patch("/api/admin/invoices/:id/void",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),note=clean(req.body?.note,500)||null;
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[inv]]=await conn.execute("SELECT id,invoice_no,status,paid_amount FROM invoices WHERE id=? FOR UPDATE",[id]);
    if(!inv){await conn.rollback();return res.status(404).json({error:"Invoice not found."});}
    if(inv.status==="void"){await conn.rollback();return res.status(409).json({error:"Already void."});}
    if(RFQ.toMinor(inv.paid_amount)>0){await conn.rollback();return res.status(409).json({error:"An invoice with recorded payments cannot be voided."});}
    await conn.execute("UPDATE invoices SET status='void',voided_at=NOW(),notes=COALESCE(?,notes) WHERE id=?",[note,id]);
    await audit(conn,req,"invoice.voided","invoice",id,{status:inv.status},{status:"void",note});
    await conn.commit();res.json({ok:true});
  }catch(error){await conn.rollback();console.error(error);res.status(500).json({error:"Could not void the invoice."});}
  finally{conn.release();}
});

app.get("/api/buyer-invoices",requireBuyerDashboard,async(req,res)=>{
  try{const [invoices]=await pool.execute("SELECT i.id,i.invoice_no,i.subtotal,i.gst_rate,i.gst_amount,i.total,i.currency,i.due_date,i.status,i.paid_amount,i.created_at,o.po_number,o.title FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.buyer_id=? AND i.status<>'void' ORDER BY i.created_at DESC LIMIT 100",[req.buyer.id]);
    const [payments]=invoices.length?await pool.query("SELECT invoice_id,amount,method,reference,received_on FROM payments WHERE invoice_id IN (?) ORDER BY received_on",[invoices.map(i=>i.id)]):[[]];
    res.json({invoices:invoices.map(i=>({...i,outstanding:RFQ.fromMinor(RFQ.toMinor(i.total)-RFQ.toMinor(i.paid_amount)),payments:payments.filter(p=>p.invoice_id===i.id)}))});}
  catch(error){console.error(error);res.status(500).json({error:"Could not load invoices."});}
});

// ---- Supplier purchase orders (Phase 3): SupplyDesk -> supplier. The supplier never sees buyer identity or buyer price. ----
const PO_LIVE_ORDER_STATES=["confirmed","in_production"];

app.post("/api/admin/orders/:id/supplier-po",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),b=req.body||{};
  const unitCost=Number(b.unitCost),currency=(clean(b.currency,10)||"INR").toUpperCase(),quantity=clean(b.quantity,60);
  const deliveryBy=clean(b.deliveryBy,10)||null,terms=clean(b.terms,2000)||null;
  const code=clean(b.capabilityCode,30).toUpperCase(),sid=clean(b.supplierId,80);
  if(!Number.isFinite(unitCost)||unitCost<=0)return res.status(400).json({error:"Enter a valid unit cost."});
  if(!quantity)return res.status(400).json({error:"Quantity is required."});
  if(deliveryBy&&(!/^\d{4}-\d{2}-\d{2}$/.test(deliveryBy)||new Date(deliveryBy)<new Date(new Date().toDateString())))return res.status(400).json({error:"Delivery date must be today or later."});
  if(!code&&!(sid&&isSuper(req)))return res.status(400).json({error:"Choose a capability (capability ID)."});
  const qty=RFQ.parseQuantity(quantity),total=qty?money(qty*unitCost):null;
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[o]]=await conn.execute("SELECT id,po_number,title,status FROM orders WHERE id=? FOR UPDATE",[id]);
    if(!o){await conn.rollback();return res.status(404).json({error:"Order not found."});}
    if(!PO_LIVE_ORDER_STATES.includes(o.status)){await conn.rollback();return res.status(409).json({error:"This order is "+RFQ.ORDER_STATES[o.status].label+"; no new supplier PO can be issued."});}
    let sup;
    if(code){[[sup]]=await conn.execute("SELECT s.id,s.business_email,p.id product_id FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id WHERE p.capability_code=? AND p.status='approved' AND s.verified=1 AND s.published=1 LIMIT 1",[code]);}
    else{[[sup]]=await conn.execute("SELECT id,business_email,NULL product_id FROM supplier_profiles WHERE id=? AND verified=1 AND published=1",[sid]);}
    if(!sup){await conn.rollback();return res.status(404).json({error:"No verified supplier found for that capability."});}
    const [[dup]]=await conn.execute("SELECT id FROM supplier_pos WHERE order_id=? AND supplier_id=? AND status NOT IN ('declined','cancelled') LIMIT 1",[id,sup.id]);
    if(dup){await conn.rollback();return res.status(409).json({error:"This supplier already has an active PO for this order."});}
    const pid=crypto.randomUUID();let po;
    for(let a=0;a<8;a++){po=RFQ.newSupplierPoNumber();try{
      await conn.execute("INSERT INTO supplier_pos (id,po_number,order_id,supplier_id,product_id,title,quantity,unit_cost,currency,total_cost,delivery_by,terms,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",[pid,po,id,sup.id,sup.product_id||null,o.title,quantity,unitCost,currency,total,deliveryBy,terms,actorOf(req).id]);break;}
      catch(e){if(e?.code!=="ER_DUP_ENTRY"||a===7)throw e;}}
    await audit(conn,req,"supplier_po.issued","supplier_po",pid,null,{poNumber:po,orderId:id,supplierRef:isSuper(req)?sup.id:supplierAlias(sup.id),quantity,unitCost,currency});
    await conn.commit();
    try{await sendBrandedMail(sup.business_email,"SupplyDesk | New purchase order "+po,{preheader:"New purchase order",title:"New purchase order",intro:"SupplyDesk has issued purchase order "+po+" for "+o.title+" ("+quantity+"). Please review and accept or decline it in your Supplier Dashboard.",bodyHtml:"",textLines:["PO "+po],ctaText:"Open Supplier Dashboard",ctaUrl:ORIGIN()+"/supplier-dashboard#purchase-orders"});}catch(e){console.error("Supplier PO mail failed:",e);}
    res.status(201).json({ok:true,poNumber:po,supplierPoId:pid});
  }catch(error){await conn.rollback();console.error("Supplier PO failed:",error);res.status(500).json({error:"Could not issue the purchase order."});}
  finally{conn.release();}
});

app.get("/api/admin/orders/:id/supplier-pos",requireAdmin,async(req,res)=>{
  try{const [rows]=await pool.execute("SELECT po.id,po.po_number,po.supplier_id,po.quantity,po.unit_cost,po.currency,po.total_cost,po.delivery_by,po.terms,po.status,po.supplier_note,po.status_changed_at,po.created_at,s.legal_name,s.trade_name,s.country,s.city FROM supplier_pos po JOIN supplier_profiles s ON s.id=po.supplier_id WHERE po.order_id=? ORDER BY po.created_at DESC",[clean(req.params.id,80)]);
    res.json({supplierPos:rows.map(r=>({...maskSupplierRow(req,r),statusLabel:RFQ.PO_STATES[r.status]?.label||r.status})),detailsRestricted:!isSuper(req)});}
  catch(error){console.error(error);res.status(500).json({error:"Could not load supplier purchase orders."});}
});

app.patch("/api/admin/supplier-pos/:id/cancel",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),note=clean(req.body?.note,500)||null;
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[po]]=await conn.execute("SELECT po.id,po.po_number,po.status,s.business_email FROM supplier_pos po JOIN supplier_profiles s ON s.id=po.supplier_id WHERE po.id=? FOR UPDATE",[id]);
    if(!po){await conn.rollback();return res.status(404).json({error:"Purchase order not found."});}
    if(!RFQ.canPoTransition(po.status,"cancelled")||po.status==="cancelled"){await conn.rollback();return res.status(409).json({error:"A "+RFQ.PO_STATES[po.status].label+" purchase order cannot be cancelled."});}
    await conn.execute("UPDATE supplier_pos SET status='cancelled',status_changed_at=NOW(),supplier_note=COALESCE(?,supplier_note) WHERE id=?",[note,id]);
    await audit(conn,req,"supplier_po.cancelled","supplier_po",id,{status:po.status},{status:"cancelled",note});
    const [[lk]]=await conn.execute("SELECT order_id FROM supplier_pos WHERE id=?",[id]);
    await syncOrderFromPos(conn,req,lk.order_id);
    await conn.commit();
    try{await sendBrandedMail(po.business_email,"SupplyDesk | Purchase order "+po.po_number+" cancelled",{preheader:"PO cancelled",title:"Purchase order cancelled",intro:"Purchase order "+po.po_number+" has been cancelled by SupplyDesk."+(note?" "+note:""),bodyHtml:"",textLines:[po.po_number+" cancelled"],ctaText:"Open Supplier Dashboard",ctaUrl:ORIGIN()+"/supplier-dashboard"});}catch(e){console.error(e);}
    res.json({ok:true});
  }catch(error){await conn.rollback();console.error(error);res.status(500).json({error:"Could not cancel the purchase order."});}
  finally{conn.release();}
});

// Supplier side: only the PO itself (no buyer, no buyer price).
app.get("/api/supplier-dashboard/purchase-orders",requireSupplierDashboard,async(req,res)=>{
  try{const [rows]=await pool.execute("SELECT id,po_number,title,quantity,unit_cost,currency,total_cost,delivery_by,terms,status,supplier_note,status_changed_at,created_at FROM supplier_pos WHERE supplier_id=? ORDER BY created_at DESC LIMIT 200",[req.supplier.id]);
    res.json({purchaseOrders:rows.map(r=>({...r,statusLabel:RFQ.PO_STATES[r.status]?.label||r.status,allowedNext:(RFQ.PO_TRANSITIONS[r.status]||[]).filter(n=>n!=="cancelled")}))});}
  catch(error){console.error(error);res.status(500).json({error:"Could not load purchase orders."});}
});

app.patch("/api/supplier-dashboard/purchase-orders/:id/status",requireSupplierDashboard,async(req,res)=>{
  const id=clean(req.params.id,80),to=clean(req.body?.status,20),note=clean(req.body?.note,500)||null;
  if(!["accepted","declined","in_production","dispatched","completed"].includes(to))return res.status(400).json({error:"Choose a valid status."});
  if(to==="declined"&&!note)return res.status(400).json({error:"Please add a reason for declining."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[po]]=await conn.execute("SELECT id,po_number,status FROM supplier_pos WHERE id=? AND supplier_id=? FOR UPDATE",[id,req.supplier.id]);
    if(!po){await conn.rollback();return res.status(404).json({error:"Purchase order not found."});}
    if(po.status===to){await conn.rollback();return res.json({ok:true,changed:false});}
    if(!RFQ.canPoTransition(po.status,to)){await conn.rollback();return res.status(409).json({error:"Cannot move this purchase order from "+RFQ.PO_STATES[po.status].label+" to "+RFQ.PO_STATES[to].label+"."});}
    await conn.execute("UPDATE supplier_pos SET status=?,status_changed_at=NOW(),supplier_note=COALESCE(?,supplier_note) WHERE id=?",[to,note,id]);
    await audit(conn,{supplier:req.supplier},"supplier_po.status_change","supplier_po",id,{status:po.status},{status:to,note});
    const [[link]]=await conn.execute("SELECT order_id FROM supplier_pos WHERE id=?",[id]);
    const synced=await syncOrderFromPos(conn,{supplier:req.supplier},link.order_id);
    await conn.commit();
    if(synced){try{const l=RFQ.ORDER_STATES[synced.to].buyerLabel;await sendBrandedMail(synced.order.email,"SupplyDesk | Order "+synced.order.po_number+": "+l,{preheader:l,title:"Order update",intro:"Hello "+(synced.order.name||"Buyer")+", your order "+synced.order.po_number+" ("+synced.order.title+") is now: "+l+".",bodyHtml:"",textLines:[synced.order.po_number+": "+l],ctaText:"View order",ctaUrl:ORIGIN()+"/buyer-dashboard"});}catch(e){console.error("Order sync mail failed:",e);}}
    res.json({ok:true,changed:true,status:to,orderStatus:synced?synced.to:undefined});
  }catch(error){await conn.rollback();console.error(error);res.status(500).json({error:"Could not update the purchase order."});}
  finally{conn.release();}
});

// ---- Commercial flow (Phase 2): SupplyDesk quote -> buyer decision -> order ----
const money=(v)=>Number.isFinite(v)?Math.round(v*100)/100:null;

// Admin sends the buyer ONE SupplyDesk price (no supplier identity, no supplier price).
app.post("/api/admin/requirements/:id/buyer-quote",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),b=req.body||{};
  const costUnit=b.costUnitPrice===""||b.costUnitPrice==null?null:Number(b.costUnitPrice);
  const markupPct=b.markupPct===""||b.markupPct==null?null:Number(b.markupPct);
  if(costUnit!=null&&(!Number.isFinite(costUnit)||costUnit<=0))return res.status(400).json({error:"Enter a valid supplier cost."});
  if(markupPct!=null){
    if(!isSuper(req))return res.status(403).json({error:"Only Super Admin can price by margin."});
    if(costUnit==null)return res.status(400).json({error:"Supplier cost is required to apply a margin."});
    if(!Number.isFinite(markupPct)||markupPct<0||markupPct>300)return res.status(400).json({error:"Margin must be between 0 and 300 percent."});
  }
  const unitPrice=markupPct!=null?RFQ.priceFromMarkup(costUnit,markupPct):Number(b.unitPrice),currency=(clean(b.currency,10)||"INR").toUpperCase(),quantity=clean(b.quantity,60);
  const leadTime=b.leadTimeDays===""||b.leadTimeDays==null?null:Number(b.leadTimeDays),validUntil=clean(b.validUntil,10)||null;
  const terms=clean(b.terms,2000)||null,note=clean(b.note,1000)||null;
  if(!Number.isFinite(unitPrice)||unitPrice<=0)return res.status(400).json({error:"Enter a valid unit price."});
  if(!quantity)return res.status(400).json({error:"Quantity is required."});
  if(leadTime!=null&&(!Number.isInteger(leadTime)||leadTime<0||leadTime>730))return res.status(400).json({error:"Lead time must be 0-730 days."});
  if(validUntil&&(!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)||new Date(validUntil)<new Date(new Date().toDateString())))return res.status(400).json({error:"Valid-until must be today or later."});
  const qty=RFQ.parseQuantity(quantity),total=qty?money(qty*unitPrice):null;
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[r]]=await conn.execute("SELECT r.id,r.title,r.rfq_code,r.rfq_state,r.status,b.email,b.name FROM buyer_requirements r JOIN buyers b ON b.id=r.buyer_id WHERE r.id=? FOR UPDATE",[id]);
    if(!r){await conn.rollback();return res.status(404).json({error:"Requirement not found."});}
    const st=r.rfq_state||RFQ.LEGACY_STATUS_TO_STATE[r.status]||"submitted";
    if(st!=="costing")await moveRfq(conn,req,id,"costing","preparing buyer quote");
    await conn.execute("UPDATE rfq_quotes SET status='superseded' WHERE rfq_id=? AND status='sent'",[id]);
    const qid=crypto.randomUUID();let quoteNo;
    for(let a=0;a<8;a++){quoteNo=RFQ.newQuoteNo();try{
      await conn.execute("INSERT INTO rfq_quotes (id,rfq_id,quote_no,unit_price,currency,quantity,total_price,lead_time_days,valid_until,terms,note,created_by,cost_unit_price,markup_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[qid,id,quoteNo,unitPrice,currency,quantity,total,leadTime,validUntil,terms,note,actorOf(req).id,costUnit,markupPct]);break;}
      catch(e){if(e?.code!=="ER_DUP_ENTRY"||a===7)throw e;}}
    await moveRfq(conn,req,id,"quote_sent","quote "+quoteNo);
    await audit(conn,req,"rfq.quote_sent","rfq",id,null,{quoteNo,unitPrice,currency,quantity,total});
    await conn.commit();
    try{await sendBrandedMail(r.email,"SupplyDesk | Your quotation "+quoteNo,{preheader:"Quotation ready",title:"Your quotation is ready",intro:"Hello "+(r.name||"Buyer")+", SupplyDesk has prepared a quotation for "+r.title+".",
      bodyHtml:'<p style="font-size:14px">Quote <b>'+escapeEmailHtml(quoteNo)+'</b>: '+escapeEmailHtml(String(unitPrice))+' '+escapeEmailHtml(currency)+' per unit for '+escapeEmailHtml(quantity)+'.</p>',textLines:["Quote "+quoteNo+": "+unitPrice+" "+currency+" per unit for "+quantity],ctaText:"Review quotation",ctaUrl:ORIGIN()+"/buyer-dashboard"});}catch(e){console.error("Buyer quote mail failed:",e);}
    res.status(201).json({ok:true,quoteNo,quoteId:qid,total});
  }catch(error){await conn.rollback();if(error instanceof RfqError)return res.status(error.status).json({error:error.message});console.error("Buyer quote failed:",error);res.status(500).json({error:"Could not send the quotation."});}
  finally{conn.release();}
});

// Buyer accepts or declines the SupplyDesk quote. Accepting creates the order (PO).
app.post("/api/buyer-requirements/:id/quote/respond",requireBuyerDashboard,async(req,res)=>{
  const id=clean(req.params.id,80),decision=clean(req.body?.decision,10),note=clean(req.body?.note,500)||null;
  if(!["accept","reject"].includes(decision))return res.status(400).json({error:"Choose accept or reject."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[r]]=await conn.execute("SELECT id,title FROM buyer_requirements WHERE id=? AND buyer_id=? FOR UPDATE",[id,req.buyer.id]);
    if(!r){await conn.rollback();return res.status(404).json({error:"Requirement not found."});}
    const [[q]]=await conn.execute("SELECT * FROM rfq_quotes WHERE rfq_id=? AND status='sent' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[id]);
    if(!q){await conn.rollback();return res.status(409).json({error:"There is no open quotation to respond to."});}
    if(q.valid_until&&new Date(q.valid_until)<new Date(new Date().toDateString())){await conn.rollback();return res.status(409).json({error:"This quotation has expired. Please ask SupplyDesk for a new one."});}
    const actor={buyer:req.buyer};
    if(decision==="reject"){
      await conn.execute("UPDATE rfq_quotes SET status='rejected',buyer_note=?,responded_at=NOW() WHERE id=?",[note,q.id]);
      await moveRfq(conn,actor,id,"lost",note||"buyer declined quote");
      await audit(conn,actor,"rfq.quote_rejected","rfq",id,null,{quoteNo:q.quote_no,note});
      await conn.commit();return res.json({ok:true,decision:"rejected"});
    }
    await conn.execute("UPDATE rfq_quotes SET status='accepted',buyer_note=?,responded_at=NOW() WHERE id=?",[note,q.id]);
    await moveRfq(conn,actor,id,"buyer_approved",note||"buyer accepted quote");
    const oid=crypto.randomUUID();let po;
    for(let a=0;a<8;a++){po=RFQ.newPoNumber();try{
      await conn.execute("INSERT INTO orders (id,po_number,rfq_id,rfq_quote_id,buyer_id,title,quantity,unit_price,currency,total_price) VALUES (?,?,?,?,?,?,?,?,?,?)",[oid,po,id,q.id,req.buyer.id,r.title,q.quantity,q.unit_price,q.currency,q.total_price]);break;}
      catch(e){if(e?.code!=="ER_DUP_ENTRY"||a===7)throw e;}}
    await moveRfq(conn,actor,id,"converted","order "+po);
    await audit(conn,actor,"order.created","order",oid,null,{poNumber:po,quoteNo:q.quote_no,quantity:q.quantity,unitPrice:q.unit_price,currency:q.currency});
    await conn.commit();
    try{await sendBrandedMail(req.buyer.email,"SupplyDesk | Order confirmed "+po,{preheader:"Order confirmed",title:"Order confirmed",intro:"Thank you. Your order "+po+" for "+r.title+" is confirmed. SupplyDesk will keep you updated.",bodyHtml:"",textLines:["Order "+po],ctaText:"View order",ctaUrl:ORIGIN()+"/buyer-dashboard"});}catch(e){console.error("Order mail failed:",e);}
    res.status(201).json({ok:true,decision:"accepted",poNumber:po,orderId:oid});
  }catch(error){await conn.rollback();if(error instanceof RfqError)return res.status(error.status).json({error:error.message});console.error("Quote response failed:",error);res.status(500).json({error:"Could not record your response."});}
  finally{conn.release();}
});

app.get("/api/buyer-orders",requireBuyerDashboard,async(req,res)=>{
  try{const [rows]=await pool.execute("SELECT id,po_number,rfq_id,title,quantity,unit_price,currency,total_price,status,status_changed_at,notes,created_at FROM orders WHERE buyer_id=? ORDER BY created_at DESC LIMIT 100",[req.buyer.id]);
    res.json({orders:rows.map(o=>({...o,statusLabel:(RFQ.ORDER_STATES[o.status]||{}).buyerLabel||o.status}))});}
  catch(error){console.error(error);res.status(500).json({error:"Could not load orders."});}
});

app.get("/api/admin/orders",requireAdmin,async(req,res)=>{
  try{const [rows]=await pool.execute("SELECT o.id,o.po_number,o.rfq_id,o.title,o.quantity,o.unit_price,o.currency,o.total_price,o.status,o.status_changed_at,o.notes,o.created_at,b.name buyer_name,b.company buyer_company,r.rfq_code FROM orders o JOIN buyers b ON b.id=o.buyer_id JOIN buyer_requirements r ON r.id=o.rfq_id ORDER BY o.created_at DESC LIMIT 300");
    res.json({orders:rows.map(o=>({...o,statusLabel:(RFQ.ORDER_STATES[o.status]||{}).label||o.status,allowedNext:RFQ.ORDER_TRANSITIONS[o.status]||[]})),states:Object.fromEntries(Object.entries(RFQ.ORDER_STATES).map(([k,v])=>[k,v.label]))});}
  catch(error){console.error(error);res.status(500).json({error:"Could not load orders."});}
});

app.patch("/api/admin/orders/:id/status",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),to=clean(req.body?.status,20),note=clean(req.body?.note,500)||null;
  if(!RFQ.isOrderState(to))return res.status(400).json({error:"Unknown order status."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[o]]=await conn.execute("SELECT o.id,o.po_number,o.status,o.title,b.email,b.name FROM orders o JOIN buyers b ON b.id=o.buyer_id WHERE o.id=? FOR UPDATE",[id]);
    if(!o){await conn.rollback();return res.status(404).json({error:"Order not found."});}
    if(o.status===to){await conn.rollback();return res.json({ok:true,changed:false});}
    if(!RFQ.canOrderTransition(o.status,to)){await conn.rollback();return res.status(409).json({error:"Cannot move this order from "+RFQ.ORDER_STATES[o.status].label+" to "+RFQ.ORDER_STATES[to].label+"."});}
    await conn.execute("UPDATE orders SET status=?,status_changed_at=NOW(),notes=COALESCE(?,notes) WHERE id=?",[to,note,id]);
    await audit(conn,req,"order.status_change","order",id,{status:o.status},{status:to,note});
    await conn.commit();
    try{await sendBrandedMail(o.email,"SupplyDesk | Order "+o.po_number+": "+RFQ.ORDER_STATES[to].buyerLabel,{preheader:RFQ.ORDER_STATES[to].buyerLabel,title:"Order update",intro:"Hello "+(o.name||"Buyer")+", your order "+o.po_number+" ("+o.title+") is now: "+RFQ.ORDER_STATES[to].buyerLabel+"."+(note?" "+note:""),bodyHtml:"",textLines:[o.po_number+": "+RFQ.ORDER_STATES[to].buyerLabel],ctaText:"View order",ctaUrl:ORIGIN()+"/buyer-dashboard"});}catch(e){console.error("Order update mail failed:",e);}
    res.json({ok:true,changed:true,status:to});
  }catch(error){await conn.rollback();console.error(error);res.status(500).json({error:"Could not update the order."});}
  finally{conn.release();}
});

// ---- Procurement (Phase 1B) ----
// Procurement queue: every open RFQ grouped by state, oldest/most urgent first.
app.get("/api/admin/procurement/queue",requireAdmin,async(req,res)=>{
  try{
    const [rows]=await pool.execute(
      `SELECT r.id,r.rfq_code,r.rfq_state,r.state_changed_at,r.created_at,r.title,r.category,r.subcategory,r.quantity,r.unit,r.required_by,r.delivery_country,r.status,
              b.name buyer_name,b.company buyer_company,
              (SELECT COUNT(*) FROM requirement_supplier_matches m WHERE m.requirement_id=r.id) shared_count,
              (SELECT COUNT(*) FROM supplier_quotes q WHERE q.requirement_id=r.id AND q.status='submitted') quote_count
       FROM buyer_requirements r JOIN buyers b ON b.id=r.buyer_id ORDER BY r.created_at DESC LIMIT 500`);
    const now=Date.now(),counts={};
    const items=rows.map(r=>{
      const state=r.rfq_state||RFQ.LEGACY_STATUS_TO_STATE[r.status]||"submitted";
      counts[state]=(counts[state]||0)+1;
      const waitingHours=Math.floor((now-new Date(r.state_changed_at||r.created_at).getTime())/3600000);
      const daysLeft=r.required_by?Math.floor((new Date(r.required_by).getTime()-now)/86400000):null;
      const terminal=RFQ.isTerminal(state);
      let flag="";
      if(!terminal){ if(daysLeft!=null&&daysLeft<0)flag="overdue"; else if(state==="submitted"&&waitingHours>24)flag="needs_review"; else if(daysLeft!=null&&daysLeft<=7)flag="urgent"; else if(["sourcing","quotes_received"].includes(state)&&waitingHours>72)flag="stalled"; }
      return {...r,rfq_state:state,stateLabel:RFQ.STATES[state].label,waitingHours,daysLeft,flag,allowedNext:RFQ.TRANSITIONS[state]};
    });
    res.json({counts,states:Object.fromEntries(Object.entries(RFQ.STATES).map(([k,v])=>[k,v.label])),items});
  }catch(error){console.error("Procurement queue failed:",error);res.status(500).json({error:"Could not load the procurement queue."});}
});

// Manual state change by procurement/admin (only moves the state machine allows).
app.post("/api/admin/requirements/:id/state",requireAdmin,async(req,res)=>{
  const to=clean(req.body?.state,30),note=clean(req.body?.note,500)||null,id=clean(req.params.id,80);
  if(!RFQ.isState(to))return res.status(400).json({error:"Unknown state."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const r=await moveRfq(conn,req,id,to,note);
    // keep the legacy buyer-facing status in step for terminal outcomes
    if(r.changed&&["closed","cancelled","rejected"].includes(to))await conn.execute("UPDATE buyer_requirements SET status=?,updated_at=NOW() WHERE id=?",[to,id]);
    await conn.commit();
    res.json({ok:true,...r});
  }catch(error){await conn.rollback();if(error instanceof RfqError)return res.status(error.status).json({error:error.message});console.error("RFQ state change failed:",error);res.status(500).json({error:"Could not change the state."});}
  finally{conn.release();}
});

// Rank approved capabilities for one RFQ (admin only: supplier identity stays internal).
app.get("/api/admin/requirements/:id/capability-matches",requireAdmin,async(req,res)=>{
  try{
    const id=clean(req.params.id,80);
    const [[r]]=await pool.execute("SELECT id,title,category,subcategory,quantity,unit,required_by,delivery_country,specification,rfq_code FROM buyer_requirements WHERE id=?",[id]);
    if(!r)return res.status(404).json({error:"Requirement not found."});
    const [caps]=await pool.execute(
      `SELECT p.id,p.product_name,p.description,p.category,p.subcategory,p.moq,p.unit,p.monthly_capacity,p.available_capacity,p.capacity_unit,p.lead_time_days,p.origin_region,p.capacity_updated_at,p.capability_code,
              s.id supplier_id,s.legal_name,s.trade_name,s.country,s.city
       FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id
       WHERE p.status='approved' AND s.verified=1 AND s.published=1 LIMIT 2000`);
    const matches=caps.map(c=>({c,sc:RFQ.scoreCapability(r,c)})).filter(x=>x.sc.eligible&&x.sc.score>0)
      .sort((a,b)=>b.sc.score-a.sc.score).slice(0,30)
      .map(({c,sc})=>({productId:c.id,capabilityCode:c.capability_code,productName:c.product_name,category:c.category,subcategory:c.subcategory,supplierId:isSuper(req)?c.supplier_id:null,supplierName:isSuper(req)?(c.trade_name||c.legal_name):supplierAlias(c.supplier_id),country:isSuper(req)?c.country:"",region:c.origin_region||"",
        monthlyCapacity:isSuper(req)?c.monthly_capacity:null,availableCapacity:isSuper(req)?c.available_capacity:null,capacityBand:capacityBand(c.available_capacity),capacityUnit:c.capacity_unit||c.unit||"",leadTimeDays:c.lead_time_days,moq:c.moq,score:sc.score,reasons:sc.reasons,coversFull:sc.coversFull,stale:sc.stale}));
    res.json({rfq:{id:r.id,rfqCode:r.rfq_code,title:r.title,quantity:r.quantity,requiredBy:r.required_by},totalCapabilities:caps.length,matches});
  }catch(error){console.error("Capability matching failed:",error);res.status(500).json({error:"Could not match capabilities."});}
});

// Audit trail for one entity (admin only).
app.get("/api/admin/audit",requireAdmin,async(req,res)=>{
  try{
    const entity=clean(req.query.entity,40),entityId=clean(req.query.id,80);
    const [rows]=entity&&entityId
      ?await pool.execute("SELECT id,actor,actor_role,action,entity,entity_id,old_value,new_value,created_at FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 200",[entity,entityId])
      :await pool.execute("SELECT id,actor,actor_role,action,entity,entity_id,old_value,new_value,created_at FROM audit_log ORDER BY id DESC LIMIT 200");
    res.json({entries:rows});
  }catch(error){console.error("Audit read failed:",error);res.status(500).json({error:"Could not load the audit trail."});}
});

// Suppliers that match a requirement (admin picks from this list before sharing).
app.get("/api/admin/requirements/:id/matches",requireAdmin,async(req,res)=>{
  try{
    const id=clean(req.params.id,80);
    const [[r]]=await pool.execute("SELECT id,category,subcategory FROM buyer_requirements WHERE id=?",[id]);
    if(!r)return res.status(404).json({error:"Requirement not found."});
    const level=["subcategory","category","all"].includes(req.query.level)?req.query.level:(r.subcategory?"subcategory":(r.category?"category":"all"));
    let sql="SELECT s.id,s.legal_name,s.trade_name,s.country,s.city,s.category,s.subcategory,(SELECT m.status FROM requirement_supplier_matches m WHERE m.requirement_id=? AND m.supplier_id=s.id) AS sent_status FROM supplier_profiles s WHERE s.verified=1 AND s.published=1";
    const params=[id];
    if(level!=="all"&&r.category){sql+=" AND s.category=?";params.push(r.category);}
    if(level==="subcategory"&&r.subcategory){sql+=" AND s.subcategory=?";params.push(r.subcategory);}
    sql+=" ORDER BY s.trade_name,s.legal_name LIMIT 500";
    const [suppliers]=await pool.execute(sql,params);
    res.json({level,category:r.category,subcategory:r.subcategory,suppliers:isSuper(req)?suppliers:suppliers.map(x=>({id:x.id,legal_name:supplierAlias(x.id),trade_name:supplierAlias(x.id),country:"",city:"",category:x.category,subcategory:x.subcategory,sent_status:x.sent_status})),detailsRestricted:!isSuper(req)});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load matching suppliers."});}
});

// Admin decision: share with suppliers / handle through SupplyDesk / reject.
app.post("/api/admin/requirements/:id/review",requireAdmin,async(req,res)=>{
  const id=clean(req.params.id,80),action=clean(req.body?.action,30),notes=clean(req.body?.adminNotes,4000)||null,buyerNote=clean(req.body?.buyerNote,2000)||null;
  if(!["share_suppliers","supplydesk","reject"].includes(action))return res.status(400).json({error:"Invalid action."});
  try{
    const [[r]]=await pool.execute("SELECT r.*,b.email buyer_email,b.name buyer_name FROM buyer_requirements r JOIN buyers b ON b.id=r.buyer_id WHERE r.id=?",[id]);
    if(!r)return res.status(404).json({error:"Requirement not found."});
    if(["closed","cancelled"].includes(r.status))return res.status(409).json({error:"This requirement is already "+r.status+"."});
    const admin=req.admin.admin_id;
    let targets=[];
    if(action==="share_suppliers"){
      const ids=[...new Set((Array.isArray(req.body?.supplierIds)?req.body.supplierIds:[]).map(x=>clean(x,80)).filter(Boolean))].slice(0,500);
      if(!ids.length)return res.status(400).json({error:"Select at least one supplier to share this requirement with."});
      const [rows]=await pool.query("SELECT id,legal_name,trade_name,business_email FROM supplier_profiles WHERE verified=1 AND published=1 AND id IN (?)",[ids]);
      targets=rows;
      if(!targets.length)return res.status(400).json({error:"None of the selected suppliers are verified and published."});
    }
    const conn=await pool.getConnection();
    let newlyShared=[];
    try{
      await conn.beginTransaction();
      if(action==="share_suppliers"){
        const [existing]=await conn.query("SELECT supplier_id FROM requirement_supplier_matches WHERE requirement_id=?",[id]);
        const have=new Set(existing.map(x=>x.supplier_id));
        newlyShared=targets.filter(t=>!have.has(t.id));
        for(const t of newlyShared)await conn.execute("INSERT INTO requirement_supplier_matches (id,requirement_id,supplier_id,status) VALUES (?,?,?,'available')",[crypto.randomUUID(),id,t.id]);
        await moveRfq(conn,req,id,"sourcing",notes);
        await conn.execute("UPDATE buyer_requirements SET status='open',fulfilment_mode='suppliers',admin_notes=?,buyer_note=?,reviewed_at=NOW(),reviewed_by=?,updated_at=NOW() WHERE id=?",[notes,buyerNote,admin,id]);
        await audit(conn,req,"rfq.shared_with_suppliers","rfq",id,null,{supplierCount:newlyShared.length});
      }else if(action==="supplydesk"){
        await moveRfq(conn,req,id,"costing",notes);
        await conn.execute("UPDATE buyer_requirements SET status='fulfilling',fulfilment_mode='supplydesk',admin_notes=?,buyer_note=?,reviewed_at=NOW(),reviewed_by=?,updated_at=NOW() WHERE id=?",[notes,buyerNote,admin,id]);
      }else{
        await moveRfq(conn,req,id,"rejected",notes);
        await conn.execute("UPDATE buyer_requirements SET status='rejected',admin_notes=?,buyer_note=?,reviewed_at=NOW(),reviewed_by=?,updated_at=NOW() WHERE id=?",[notes,buyerNote,admin,id]);
      }
      await conn.commit();
    }catch(e){await conn.rollback();if(e instanceof RfqError)return res.status(e.status).json({error:e.message});throw e;}finally{conn.release();}

    // Notifications are best-effort; the decision is already saved.
    const dash=ORIGIN()+"/buyer-dashboard.html";
    const status=action==="share_suppliers"?"open":action==="supplydesk"?"fulfilling":"rejected";
    const lead=action==="share_suppliers"?"Your requirement has been approved and shared with "+(newlyShared.length||targets.length)+" matching supplier(s). Quotations will appear in your Buyer Dashboard."
      :action==="supplydesk"?"The SupplyDesk team will handle this requirement directly and invoice you through SupplyDesk. We will contact you with the next steps."
      :"We were unable to take this requirement forward at this time.";
    await sendBrandedMail(r.buyer_email,"SupplyDesk | Requirement update",{
      preheader:"Update on your sourcing requirement",title:"Requirement update",intro:"Hello "+(r.buyer_name||"Buyer")+", "+lead,
      bodyHtml:'<div style="margin:20px 0;padding:16px;background:#f4f9fc;border:1px solid #dbe8ed;border-radius:12px"><div style="font-size:12px;color:#58717c;text-transform:uppercase;font-weight:700;letter-spacing:1px">'+escapeEmailHtml(REQ_STATUS_LABEL[status])+'</div><div style="font-size:16px;font-weight:700;margin-top:6px">'+escapeEmailHtml(r.title)+'</div>'+(buyerNote?'<p style="line-height:1.6;margin:10px 0 0">'+escapeEmailHtml(buyerNote)+'</p>':"")+'</div>',
      textLines:[REQ_STATUS_LABEL[status]+": "+r.title].concat(buyerNote?[buyerNote]:[]),ctaText:"Track in Buyer Dashboard",ctaUrl:dash});
    let mailed=0;
    for(const t of newlyShared){
      if(await sendBrandedMail(t.business_email,"SupplyDesk | New buyer requirement",{
        preheader:"A buyer requirement matches your category",title:"New buyer requirement",intro:"Hello "+(t.trade_name||t.legal_name||"Supplier")+", SupplyDesk has shared a buyer requirement that matches your business. Review it in your Supplier Dashboard and send your quotation.",
        bodyHtml:'<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px"><tr><td style="padding:8px 0;color:#58717c">Requirement</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(r.title)+'</td></tr><tr><td style="padding:8px 0;color:#58717c">Category</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml([r.category,r.subcategory].filter(Boolean).join(" / ")||"Custom")+'</td></tr>'+(r.quantity?'<tr><td style="padding:8px 0;color:#58717c">Quantity</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(r.quantity+(r.unit?" "+r.unit:""))+'</td></tr>':"")+(r.delivery_country?'<tr><td style="padding:8px 0;color:#58717c">Delivery</td><td style="padding:8px 0;font-weight:700">'+escapeEmailHtml(r.delivery_country)+'</td></tr>':"")+'</table><p style="color:#71838b;font-size:12px">The buyer\'s contact details stay private. Quotations are shared through SupplyDesk.</p>',
        textLines:["Requirement: "+r.title,"Category: "+([r.category,r.subcategory].filter(Boolean).join(" / ")||"Custom")],ctaText:"Open Supplier Dashboard",ctaUrl:ORIGIN()+"/supplier-dashboard"}))mailed++;
    }
    res.json({ok:true,status,sharedWith:newlyShared.length,alreadyShared:targets.length-newlyShared.length,supplierEmailsSent:mailed});
  }catch(error){console.error("Requirement review failed:",error);res.status(500).json({error:"Could not save the review decision."});}
});

app.get("/api/admin/requirements/:id/quotes",requireAdmin,async(req,res)=>{try{const [quotes]=await pool.execute("SELECT q.*,s.trade_name,s.legal_name,s.business_email,s.country,s.city FROM supplier_quotes q JOIN supplier_profiles s ON s.id=q.supplier_id WHERE q.requirement_id=? ORDER BY q.created_at DESC",[clean(req.params.id,80)]);res.json({quotes:quotes.map(q=>maskSupplierRow(req,q)),detailsRestricted:!isSuper(req)});}catch(error){res.status(500).json({error:"Could not load requirement quotations."});}});

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
  optimizeUploads(),
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


app.post("/api/supplier-dashboard/request-otp", supplierDashboardLimiter, async (req,res)=>{
  const email=clean(req.body?.email,255).trim().toLowerCase();
  const requestId=crypto.randomUUID();
  if(!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({error:"Please enter a valid business email address.",requestId});
  try{
    const [[supplier]]=await pool.execute(
      "SELECT id,business_email,verified,published FROM supplier_profiles WHERE LOWER(TRIM(business_email))=LOWER(TRIM(?)) LIMIT 1",
      [email]
    );
    if(!supplier) return res.status(404).json({error:"This email is not registered as a verified SupplyDesk supplier.",requestId});
    if(!supplier.verified||!supplier.published) return res.status(403).json({error:"This supplier account is not currently enabled for dashboard access.",requestId});
    if(!supplier.business_email) return res.status(400).json({error:"Supplier business email is missing.",requestId});

    if(String(process.env.E2E_TEST_MODE||"").toLowerCase()==="true"&&clean(process.env.E2E_TEST_KEY,256)&&safeEqual(clean(req.get("x-e2e-key"),256),clean(process.env.E2E_TEST_KEY,256))){
      const otp=String(crypto.randomInt(100000,1000000));
      await pool.execute("INSERT INTO supplier_dashboard_otps (id,supplier_id,otp_hash,expires_at,attempts) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE),0)",[crypto.randomUUID(),supplier.id,crypto.createHash("sha256").update(otp).digest("hex")]);
      return res.json({ok:true,message:"Test verification code created.",requestId,testOtp:otp});
    }
    console.log("Supplier dashboard OTP email starting:",{requestId,supplierId:supplier.id,to:supplier.business_email});
    const info=await sendSupplierDashboardOtp(supplier);
    console.log("Supplier dashboard OTP email sent:",{requestId,supplierId:supplier.id,to:supplier.business_email,messageId:info.messageId});
    res.json({
      ok:true,
      message:"OTP sent successfully. Check your email.",
      requestId,
      messageId:info.messageId,
      smtpAccepted: info.accepted || [],
      smtpRejected: info.rejected || [],
      smtpResponse: info.response || ""
    });
  }catch(error){
    console.error("Supplier dashboard OTP email failed:",{
      requestId,code:error?.code,responseCode:error?.responseCode,command:error?.command,response:error?.response,message:error?.message
    });
    res.status(502).json({error:"OTP email could not be sent. Please try again.",requestId});
  }
});

app.post("/api/supplier-dashboard/verify-otp", supplierDashboardLimiter, async (req,res)=>{
  const email=clean(req.body?.email,255).toLowerCase(), otp=clean(req.body?.otp,6);
  if(!/^\S+@\S+\.\S+$/.test(email)||!/^\d{6}$/.test(otp)) return res.status(400).json({error:"Enter the 6-digit OTP sent to your business email."});
  try{
    // Email delivery can take several seconds. If a newer OTP was requested
    // before an older email arrived, the mailbox may contain a still-valid
    // earlier code. Check the latest few active codes instead of only the
    // newest database row.
    const [rows]=await pool.execute(`SELECT o.id AS otp_id,o.otp_hash,o.expires_at,o.attempts,o.used_at,
             s.id,s.business_email,o.created_at
      FROM supplier_dashboard_otps o
      JOIN supplier_profiles s ON s.id=o.supplier_id
      WHERE LOWER(TRIM(s.business_email))=LOWER(TRIM(?))
        AND s.verified=1 AND s.published=1
        AND o.used_at IS NULL AND o.expires_at>NOW()
      ORDER BY o.created_at DESC LIMIT 5`,[email]);

    if(!rows.length)return res.status(401).json({error:"OTP expired or not found. Please request a new OTP."});

    const hash=crypto.createHash("sha256").update(otp).digest("hex");
    let match=null;
    for(const row of rows){
      if(Number(row.attempts)<5 && hash===row.otp_hash){match=row;break;}
    }

    if(!match){
      // Count an attempt against the newest active code so repeated wrong
      // guesses remain rate-limited without invalidating all active codes.
      const newest=rows[0];
      if(Number(newest.attempts)>=5)return res.status(429).json({error:"Too many incorrect attempts. Please request a new OTP."});
      await pool.execute("UPDATE supplier_dashboard_otps SET attempts=attempts+1 WHERE id=?",[newest.otp_id]);
      return res.status(401).json({error:"Incorrect OTP. Please use the latest OTP received in your email."});
    }

    await pool.execute("UPDATE supplier_dashboard_otps SET used_at=NOW() WHERE id=?",[match.otp_id]);
    const rawToken=crypto.randomBytes(32).toString("hex");
    await pool.execute(
      "INSERT INTO supplier_dashboard_tokens (id,supplier_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 24 HOUR))",
      [crypto.randomUUID(),match.id,dashboardTokenHash(rawToken)]
    );

    // Only this login attempt is consumed. Other active OTPs for the
    // same supplier remain valid for other users/devices.
    console.log("Supplier dashboard OTP verified:",{
      supplierId:match.id,
      email,
      loginAttemptId:match.otp_id,
      otpCreatedAt:match.created_at
    });
    res.json({
      ok:true,
      token:rawToken,
      loginAttemptId:match.otp_id,
      message:"OTP verified. Dashboard access granted."
    });
  }catch(error){
    console.error("Supplier dashboard OTP verification failed:",error);
    res.status(500).json({error:"Could not verify the OTP. Please try again."});
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
    const [connections]=HIDE_SUPPLIERS?[[]]:await pool.execute(
      "SELECT c.id,c.customer_name,c.customer_email,c.customer_phone,c.product_name,c.source_action,c.message,c.status,c.created_at,c.updated_at,c.enquiry_id,b.company AS customer_company,b.country AS customer_country,e.quantity FROM connect_requests c LEFT JOIN buyers b ON b.email=c.customer_email LEFT JOIN buyer_enquiries e ON e.id=c.enquiry_id WHERE c.supplier_id=? ORDER BY c.created_at DESC LIMIT 50",
      [supplierId]
    );
    // Profile update requests are optional for the dashboard. Older
    // SupplyDesk databases may not have the supplier_update_requests table
    // yet, so a missing table must not prevent the entire dashboard from
    // loading.
    let pendingUpdate = null;
    try {
      const [[pending]]=await pool.execute(
        "SELECT id,status,submitted_at,admin_notes FROM supplier_update_requests WHERE supplier_id=? AND status IN ('pending','query') ORDER BY submitted_at DESC LIMIT 1",
        [supplierId]
      );
      pendingUpdate = pending || null;
    } catch (e) {
      if (e?.code !== "ER_NO_SUCH_TABLE") throw e;
      console.warn("supplier_update_requests table not present; continuing without pending update.");
    }
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
    "SELECT id,product_name,category,subcategory,description,moq,unit,market_scope,status,admin_notes,created_at,updated_at,monthly_capacity,available_capacity,capacity_unit,lead_time_days,origin_region,capacity_updated_at,capability_code FROM supplier_products WHERE supplier_id=? AND status <> 'archived' ORDER BY updated_at DESC",
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
  const cap=parseCapacityInput(req.body);
  if(cap.error) return res.status(400).json({error:cap.error});
  const c=cap.values, hasCap=c.monthly_capacity!=null||c.available_capacity!=null||c.lead_time_days!=null;
  try{
    const id=crypto.randomUUID();
    let code=null;
    for(let attempt=0;attempt<8;attempt++){
      code=newCapabilityCode(category);
      try{
        await pool.execute(
          "INSERT INTO supplier_products (id,supplier_id,product_name,category,subcategory,description,moq,unit,market_scope,status,monthly_capacity,available_capacity,capacity_unit,lead_time_days,origin_region,capacity_updated_at,capability_code) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,"+(hasCap?"NOW()":"NULL")+",?)",
          [id,req.supplier.id,productName,category,subcategory,description,moq,unit,marketScope,c.monthly_capacity,c.available_capacity,c.capacity_unit,c.lead_time_days,c.origin_region,code]
        ); break;
      }catch(e){ if(e?.code!=="ER_DUP_ENTRY"||attempt===7) throw e; }
    }
    res.status(201).json({ok:true,id,capabilityCode:code,message:"Product submitted for SupplyDesk review."});
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

// Capacity and lead time change often, so updating them does not send the listing back for review.
app.patch("/api/supplier-dashboard/products/:id/capacity", requireSupplierDashboard, async (req,res) => {
  const id=clean(req.params.id,80);
  const cap=parseCapacityInput(req.body);
  if(cap.error) return res.status(400).json({error:cap.error});
  const c=cap.values;
  if(c.monthly_capacity==null&&c.available_capacity==null&&c.lead_time_days==null) return res.status(400).json({error:"Enter monthly capacity, available capacity or lead time."});
  try{
    const [[old]]=await pool.execute("SELECT monthly_capacity,available_capacity,capacity_unit,lead_time_days,origin_region FROM supplier_products WHERE id=? AND supplier_id=? AND status <> 'archived'",[id,req.supplier.id]);
    if(!old) return res.status(404).json({error:"Product not found."});
    const monthly=c.monthly_capacity??old.monthly_capacity, available=c.available_capacity??old.available_capacity;
    if(monthly!=null&&available!=null&&Number(available)>Number(monthly)) return res.status(400).json({error:"Available capacity cannot be more than monthly capacity."});
    await pool.execute("UPDATE supplier_products SET monthly_capacity=?,available_capacity=?,capacity_unit=?,lead_time_days=?,origin_region=?,capacity_updated_at=NOW() WHERE id=? AND supplier_id=?",
      [monthly,available,c.capacity_unit??old.capacity_unit,c.lead_time_days??old.lead_time_days,c.origin_region??old.origin_region,id,req.supplier.id]);
    await audit(pool,req,"capacity.updated","product",id,{monthly:old.monthly_capacity,available:old.available_capacity,leadTimeDays:old.lead_time_days},{monthly,available,leadTimeDays:c.lead_time_days??old.lead_time_days});
    res.json({ok:true,message:"Capacity updated."});
  }catch(error){console.error("Capacity update failed:",error);res.status(500).json({error:"Could not update capacity."});}
});

app.delete("/api/supplier-dashboard/products/:id", requireSupplierDashboard, async (req,res) => {
  const [result]=await pool.execute("UPDATE supplier_products SET status='archived' WHERE id=? AND supplier_id=?",[clean(req.params.id,80),req.supplier.id]);
  if(!result.affectedRows) return res.status(404).json({error:"Product not found."});
  res.json({ok:true});
});

app.post("/api/supplier-dashboard/products/:id/images", requireSupplierDashboard, (req,res,next)=>productImageUpload.array("productImages",6)(req,res,next), optimizeUploads({allowPdf:false}), async (req,res)=>{
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

async function getPublicSupplierByIdOrSlug(identifier){
  const key=clean(identifier,120);
  if(!key)return null;
  const [[byId]]=await pool.execute(
    `SELECT id,legal_name,trade_name,business_type,country,city,address,website,category,subcategory,verified,published,profile_details_json
     FROM supplier_profiles WHERE id=? AND verified=1 AND published=1 LIMIT 1`,
    [key]
  );
  if(byId)return byId;
  const [[bySlug]]=await pool.execute(
    `SELECT id,legal_name,trade_name,business_type,country,city,address,website,category,subcategory,verified,published,profile_details_json
     FROM supplier_profiles
     WHERE verified=1 AND published=1
       AND LOWER(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(NULLIF(trade_name,''),legal_name),' ','-'),'&','and'),'/','-'),'_','-'))=LOWER(?)
     LIMIT 1`,
    [key]
  );
  return bySlug||null;
}

app.post("/api/suppliers/:id/view", async (req,res) => {
  if (HIDE_SUPPLIERS) return res.status(404).json({error:"Supplier profiles are not public."});
  try{
    const supplier=await getPublicSupplierByIdOrSlug(req.params.id);
    if(!supplier)return res.status(404).json({error:"Supplier not found."});
    const visitorHash=crypto.createHash("sha256").update(String(process.env.ADMIN_TOKEN||"")+"|"+String(req.ip||"")+"|"+String(req.get("user-agent")||"")).digest("hex");
    await pool.execute("INSERT IGNORE INTO supplier_profile_views (id,supplier_id,visitor_hash,viewed_on) VALUES (?,?,?,CURRENT_DATE())",[crypto.randomUUID(),supplier.id,visitorHash]);
    res.json({ok:true,supplierId:supplier.id});
  }catch(error){console.error("Supplier view tracking failed:",error);res.status(500).json({error:"Could not record view."});}
});

app.get("/api/suppliers/:id/products", async (req,res) => {
  if (HIDE_SUPPLIERS) return res.status(404).json({error:"Supplier profiles are not public."});
  try{
    const supplier=await getPublicSupplierByIdOrSlug(req.params.id);
    if(!supplier)return res.status(404).json({error:"Supplier not found."});
    const [rows]=await pool.execute(
      "SELECT id,product_name,category,subcategory,description,moq,unit,market_scope FROM supplier_products WHERE supplier_id=? AND status='approved' ORDER BY updated_at DESC LIMIT 100",
      [supplier.id]
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
                   p.monthly_capacity,p.available_capacity,p.capacity_unit,p.lead_time_days,p.origin_region,p.capacity_updated_at,p.capability_code,
                   s.id AS supplier_id,s.legal_name,s.trade_name,s.business_type,s.country,s.city,
                   (SELECT f.id FROM supplier_product_files f WHERE f.product_id=p.id AND f.status='approved' ORDER BY f.created_at LIMIT 1) AS image_id
            FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id
            WHERE p.status='approved' AND s.verified=1 AND s.published=1`;
  if(category){sql+=" AND p.category=?";params.push(category);}
  if(country){sql+=" AND s.country=?";params.push(country);}
  if(q){
    const like="%"+q+"%";
    if(HIDE_SUPPLIERS){
      sql+=" AND (LOWER(p.product_name) LIKE ? OR LOWER(p.category) LIKE ? OR LOWER(p.subcategory) LIKE ? OR LOWER(COALESCE(p.description,'')) LIKE ? OR LOWER(COALESCE(p.capability_code,'')) LIKE ?)";
      params.push(like,like,like,like,like);
    }else{
      sql+=" AND (LOWER(p.product_name) LIKE ? OR LOWER(p.category) LIKE ? OR LOWER(p.subcategory) LIKE ? OR LOWER(COALESCE(p.description,'')) LIKE ? OR LOWER(s.legal_name) LIKE ? OR LOWER(COALESCE(s.trade_name,'')) LIKE ?)";
      params.push(like,like,like,like,like,like);
    }
  }
  sql+=" ORDER BY p.updated_at DESC LIMIT 200";
  try{
    const [rows]=await pool.execute(sql,params);
    res.json({products:rows.map(p=>{
      const base={
        id:p.id,name:p.product_name,type:"product",country:p.country,
        market:p.market_scope,desc:p.description||`${p.category} · ${p.subcategory}`,category:p.category,
        subcategories:[p.subcategory],verified:true,moq:p.moq||"",unit:p.unit||"",
        capabilityCode:p.capability_code||"",capacity:publicCapacity(p),
        imageUrl:p.image_id?"/api/products/"+encodeURIComponent(p.id)+"/images/"+encodeURIComponent(p.image_id):""
      };
      if(HIDE_SUPPLIERS) return {...base,city:"",region:p.origin_region||"",tags:[p.category,p.subcategory]};
      return {...base,city:p.city,tags:[p.category,p.subcategory,p.business_type],supplierId:p.supplier_id,supplierName:p.trade_name||p.legal_name};
    })});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load products."});}
});

app.get("/api/products/:id", async (req,res) => {
  try{
    const [[p]]=await pool.execute(
      `SELECT p.id,p.product_name,p.category,p.subcategory,p.description,p.moq,p.unit,p.market_scope,
              p.monthly_capacity,p.available_capacity,p.capacity_unit,p.lead_time_days,p.origin_region,p.capacity_updated_at,p.capability_code,
              s.id AS supplier_id,s.legal_name,s.trade_name,s.business_type,s.country,s.city,s.website
       FROM supplier_products p JOIN supplier_profiles s ON s.id=p.supplier_id
       WHERE p.id=? AND p.status='approved' AND s.verified=1 AND s.published=1`,
      [req.params.id]
    );
    if(!p) return res.status(404).json({error:"Product not found."});
    const [images]=await pool.execute("SELECT id,original_name FROM supplier_product_files WHERE product_id=? AND status='approved' ORDER BY created_at",[p.id]);
    const product={
      id:p.id,name:p.product_name,category:p.category,subcategory:p.subcategory,description:p.description,
      moq:p.moq,unit:p.unit,market_scope:p.market_scope,country:p.country,
      capabilityCode:p.capability_code||"",capacity:publicCapacity(p),
      images:images.map(x=>({id:x.id,name:x.original_name,url:"/api/products/"+encodeURIComponent(p.id)+"/images/"+encodeURIComponent(x.id)}))
    };
    if(HIDE_SUPPLIERS){ product.region=p.origin_region||""; }
    else Object.assign(product,{supplierId:p.supplier_id,supplierName:p.trade_name||p.legal_name,supplierType:p.business_type,city:p.city,website:p.website});
    res.json({product});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load product."});}
});

app.get("/api/suppliers/:id", async (req,res)=>{
  if (HIDE_SUPPLIERS) return res.status(404).json({error:"Supplier profiles are not public."});
  try{
    const row=await getPublicSupplierByIdOrSlug(req.params.id);
    if(!row)return res.status(404).json({error:"Supplier not found."});
    let profileDetails={};try{profileDetails=JSON.parse(row.profile_details_json||"{}")}catch{}
    res.json({supplier:{
      id:row.id,legal_name:row.legal_name,trade_name:row.trade_name,business_type:row.business_type,
      country:row.country,city:row.city,address:row.address,website:row.website,category:row.category,
      subcategory:row.subcategory,verified:row.verified,published:row.published,profileDetails
    }});
  }catch(error){console.error("Public supplier lookup failed:",error);res.status(500).json({error:"Could not load supplier."});}
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


app.get("/api/super-admin/suppliers", requireSuperAdmin, async (req,res)=>{
  try{
    const q=clean(req.query.q,80);const like="%"+q+"%";
    const [rows]=await pool.execute("SELECT id,legal_name,trade_name,business_type,country,city,website,business_email,business_phone,contact_person,category,subcategory,verified,published,created_at FROM supplier_profiles"+(q?" WHERE legal_name LIKE ? OR trade_name LIKE ? OR category LIKE ? OR country LIKE ? OR business_email LIKE ?":"")+" ORDER BY created_at DESC LIMIT 500",q?[like,like,like,like,like]:[]);
    res.json({suppliers:rows});
  }catch(error){console.error(error);res.status(500).json({error:"Could not load suppliers."});}
});
app.patch("/api/super-admin/suppliers/:id/email", requireSuperAdmin, async (req,res)=>{
  const id=clean(req.params.id,80),email=clean(req.body?.businessEmail,255).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Enter a valid business email."});
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [[s]]=await conn.execute("SELECT id,application_id,business_email FROM supplier_profiles WHERE id=? FOR UPDATE",[id]);
    if(!s){await conn.rollback();return res.status(404).json({error:"Supplier not found."});}
    const [[dup]]=await conn.execute("SELECT id FROM supplier_profiles WHERE business_email=? AND id<>? LIMIT 1",[email,id]);
    if(dup){await conn.rollback();return res.status(409).json({error:"Another supplier already uses this email."});}
    await conn.execute("UPDATE supplier_profiles SET business_email=? WHERE id=?",[email,id]);
    await conn.execute("UPDATE supplier_applications SET business_email=? WHERE id=?",[email,s.application_id]);
    await conn.execute("UPDATE supplier_dashboard_tokens SET revoked_at=NOW() WHERE supplier_id=? AND revoked_at IS NULL",[id]);
    await audit(conn,req,"supplier.email_changed","supplier",id,{email:s.business_email},{email});
    await conn.commit();
    res.json({ok:true,message:"Supplier business email updated."});
  }catch(error){await conn.rollback();console.error(error);res.status(500).json({error:"Could not update the email."});}
  finally{conn.release();}
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
    const requested=clean(req.query.status,30);
    const status=["pending","approved","rejected","archived"].includes(requested)?requested:"all";
    const q=clean(req.query.q,200).toLowerCase();
    let sql=`SELECT p.id,p.supplier_id,p.product_name,p.category,p.subcategory,p.description,p.moq,p.unit,p.market_scope,p.status,p.admin_notes,p.created_at,p.updated_at,
                     s.legal_name,s.trade_name,s.country,s.city,s.business_email,s.verified,s.published
              FROM supplier_products p
              LEFT JOIN supplier_profiles s ON s.id=p.supplier_id
              WHERE 1=1`;
    const params=[];
    if(status!=="all"){sql+=" AND p.status=?";params.push(status);}
    if(q){
      sql+=" AND (LOWER(p.product_name) LIKE ? OR LOWER(COALESCE(s.trade_name,'')) LIKE ? OR LOWER(COALESCE(s.legal_name,'')) LIKE ? OR LOWER(p.category) LIKE ? OR LOWER(p.subcategory) LIKE ?)";
      const like="%"+q+"%";params.push(like,like,like,like,like);
    }
    sql+=" ORDER BY p.created_at DESC LIMIT 300";
    const [rows]=await pool.execute(sql,params);
    res.json({products:rows.map(r=>maskSupplierRow(req,r)),filter:{status,q,count:rows.length},detailsRestricted:!isSuper(req)});
  }catch(error){
    console.error("Admin product queue load failed:",error);
    res.status(500).json({error:"Could not load products."});
  }
});

app.get("/api/admin/products/:id/images", requireAdmin, async (req,res)=>{
  try{const [images]=await pool.execute("SELECT id,product_id,original_name,mime_type,file_size,status,admin_notes,created_at FROM supplier_product_files WHERE product_id=? AND status <> 'archived' ORDER BY created_at",[clean(req.params.id,80)]);res.json({images});}
  catch(error){res.status(500).json({error:"Could not load product images."});}
});

app.patch("/api/admin/products/:id", requireAdmin, async (req,res)=>{
  const status=clean(req.body?.status,30), notes=clean(req.body?.adminNotes,4000);
  if(!["approved","rejected","pending"].includes(status)) return res.status(400).json({error:"Invalid product status."});
  try{
    const [result]=await pool.execute("UPDATE supplier_products SET status=?,admin_notes=?,reviewed_at=NOW(),reviewed_by=? WHERE id=?",[status,notes||null,req.admin.admin_id,clean(req.params.id,80)]);
    if(status==="approved") await pool.execute("UPDATE supplier_product_files SET status='approved',admin_notes=?,reviewed_at=NOW(),reviewed_by=? WHERE product_id=? AND status='pending'",[notes||null,req.admin.admin_id,clean(req.params.id,80)]);
    if(status==="rejected") await pool.execute("UPDATE supplier_product_files SET status='rejected',admin_notes=?,reviewed_at=NOW(),reviewed_by=? WHERE product_id=? AND status='pending'",[notes||null,req.admin.admin_id,clean(req.params.id,80)]);
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


app.patch("/api/admin/applications/:id/verification", requireAdmin, async (req,res)=>{
  const allowed=["registration_checked","documents_checked","photos_checked","address_checked"];
  const updates=[];
  const params=[];
  for(const key of allowed){
    if(Object.prototype.hasOwnProperty.call(req.body||{},key)){
      updates.push(key+"=?");
      params.push(req.body[key]?1:0);
    }
  }
  const notes=Object.prototype.hasOwnProperty.call(req.body||{},"verification_notes")?clean(req.body.verification_notes,4000):null;
  if(notes!==null){updates.push("verification_notes=?");params.push(notes||null);}
  if(!updates.length)return res.status(400).json({error:"No verification changes submitted."});
  try{
    const [[app]]=await pool.execute("SELECT id FROM supplier_applications WHERE id=?",[clean(req.params.id,80)]);
    if(!app)return res.status(404).json({error:"Application not found."});
    params.push(clean(req.params.id,80));
    await pool.execute("UPDATE supplier_verification SET "+updates.join(",")+",verified_at=NOW(),verified_by=? WHERE application_id=?",[...params.slice(0,-1), req.admin.admin_id, params[params.length-1]]);
    res.json({ok:true,message:"Verification checklist updated."});
  }catch(error){console.error("Verification checklist update failed:",error);res.status(500).json({error:"Could not update verification checklist."});}
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

    if (status === "approved") {
      const [[verification]] = await conn.execute(
        "SELECT registration_checked,documents_checked,photos_checked,address_checked FROM supplier_verification WHERE application_id=?",
        [req.params.id]
      );
      if (!verification || !verification.registration_checked || !verification.documents_checked || !verification.photos_checked || !verification.address_checked) {
        await conn.rollback();
        return res.status(400).json({ error: "Complete the verification checklist for registration, documents, photos and address before approving this supplier." });
      }
    }

    await conn.execute(
      "UPDATE supplier_applications SET status = ?, admin_notes = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ?",
      [status, notes || null, req.admin.admin_id, req.params.id]
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

app.get(["/supply-admin","/supplydesk-admin"], (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(ROOT, "admin.html"));
});

app.get(["/supplier-dashboard","/supplier-dashboard-login"], (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(ROOT, "supplier-dashboard.html"));
});

app.get(["/buyer-dashboard","/buyer-dashboard-login"],(req,res)=>{
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
  res.sendFile(path.join(ROOT,"buyer-dashboard.html"));
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

// Idempotent, safe to run on every boot against old or new databases.
async function ensurePotentialContactsMigration() {
  // 1) status must allow 'new' (imported, not yet invited).
  const [[col]] = await pool.query("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='potential_contacts' AND COLUMN_NAME='status'");
  if (col && !/'new'/.test(col.COLUMN_TYPE)) {
    await pool.query("ALTER TABLE potential_contacts MODIFY COLUMN status ENUM('new','invited','interested','registered','active','unsubscribed') NOT NULL DEFAULT 'invited'");
  }
  // 2) normalized mobile key column + index.
  try { await pool.query("ALTER TABLE potential_contacts ADD COLUMN mobile_key VARCHAR(20) NOT NULL DEFAULT ''"); }
  catch (e) { if (!["ER_DUP_FIELDNAME", "ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  try { await pool.query("ALTER TABLE potential_contacts ADD INDEX idx_potential_contact_mobile_key (mobile_key)"); }
  catch (e) { if (!["ER_DUP_KEYNAME"].includes(e?.code)) throw e; }
  // 3) backfill keys for rows that have a mobile but no key yet.
  const [rows] = await pool.query("SELECT id,mobile FROM potential_contacts WHERE mobile_key='' AND mobile IS NOT NULL AND mobile<>''");
  for (const r of rows) {
    const k = mobileKey(r.mobile);
    if (k) await pool.execute("UPDATE potential_contacts SET mobile_key=? WHERE id=?", [k, r.id]);
  }
}

async function ensureDashboardSchema() {
  // Keep the production dashboard self-healing when a deployment is pointed at
  // an existing database that predates the dashboard/product migrations.
  // All statements are idempotent and only create missing tables.
  const statements = [
    `CREATE TABLE IF NOT EXISTS potential_contacts (
      id CHAR(36) PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      mobile VARCHAR(40) NULL,
      location VARCHAR(255) NULL,
      contact_type ENUM('supplier','buyer') NOT NULL DEFAULT 'supplier',
      source VARCHAR(80) NOT NULL DEFAULT 'bulk_onboarding',
      status ENUM('new','invited','interested','registered','active','unsubscribed') NOT NULL DEFAULT 'invited',
      mobile_key VARCHAR(20) NOT NULL DEFAULT '',
      last_activity_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_potential_contact_email (email),
      INDEX idx_potential_contact_type (contact_type, status),
      INDEX idx_potential_contact_mobile (mobile),
      INDEX idx_potential_contact_mobile_key (mobile_key)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS admin_invitation_log (
      id CHAR(36) PRIMARY KEY,
      recipient_name VARCHAR(180) NULL,
      recipient_email VARCHAR(255) NOT NULL,
      invite_type ENUM('supplier','buyer') NOT NULL DEFAULT 'supplier',
      status ENUM('sent','failed') NOT NULL,
      message_id VARCHAR(255) NULL,
      sent_at DATETIME NULL,
      error_text VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_admin_invite_email (recipient_email, sent_at),
      INDEX idx_admin_invite_status (status, created_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_dashboard_tokens (
      id CHAR(36) PRIMARY KEY,
      supplier_id CHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      last_used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_dashboard_token_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
      INDEX idx_dashboard_token_supplier (supplier_id, created_at),
      INDEX idx_dashboard_token_expiry (expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_dashboard_otps (
      id CHAR(36) PRIMARY KEY,
      supplier_id CHAR(36) NOT NULL,
      otp_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_dashboard_otp_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
      INDEX idx_dashboard_otp_supplier (supplier_id, created_at),
      INDEX idx_dashboard_otp_expiry (expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_products (
      id CHAR(36) PRIMARY KEY,
      supplier_id CHAR(36) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      category VARCHAR(180) NOT NULL,
      subcategory VARCHAR(180) NOT NULL,
      description TEXT NULL,
      moq VARCHAR(120) NULL,
      unit VARCHAR(80) NULL,
      market_scope ENUM('Domestic','International','Both') NOT NULL DEFAULT 'Both',
      status ENUM('pending','approved','rejected','archived') NOT NULL DEFAULT 'pending',
      admin_notes TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      reviewed_by VARCHAR(120) NULL,
      CONSTRAINT fk_supplier_product_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
      INDEX idx_supplier_product_supplier (supplier_id, status, updated_at),
      INDEX idx_supplier_product_public (status, category, subcategory)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_product_files (
      id CHAR(36) PRIMARY KEY,
      product_id CHAR(36) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      relative_path VARCHAR(700) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      file_size BIGINT UNSIGNED NOT NULL,
      status ENUM('pending','approved','rejected','archived') NOT NULL DEFAULT 'pending',
      admin_notes TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      reviewed_by VARCHAR(120) NULL,
      CONSTRAINT fk_supplier_product_file_product FOREIGN KEY (product_id) REFERENCES supplier_products(id) ON DELETE CASCADE,
      INDEX idx_supplier_product_file_product (product_id, status, created_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_profile_views (
      id CHAR(36) PRIMARY KEY,
      supplier_id CHAR(36) NOT NULL,
      visitor_hash CHAR(64) NOT NULL,
      viewed_on DATE NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_supplier_view_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
      UNIQUE KEY uq_supplier_view_day (supplier_id, visitor_hash, viewed_on),
      INDEX idx_supplier_view_supplier (supplier_id, created_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_update_tokens (
      id CHAR(36) PRIMARY KEY,
      supplier_id CHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_update_token_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
      INDEX idx_update_token_supplier (supplier_id, created_at),
      INDEX idx_update_token_expiry (expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_update_requests (
      id CHAR(36) PRIMARY KEY,
      supplier_id CHAR(36) NOT NULL,
      status ENUM('pending','approved','query','rejected') NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      admin_notes TEXT NULL,
      submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      reviewed_by VARCHAR(120) NULL,
      CONSTRAINT fk_update_request_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE,
      INDEX idx_update_request_status (status, submitted_at),
      INDEX idx_update_request_supplier (supplier_id, submitted_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS supplier_update_files (
      id CHAR(36) PRIMARY KEY,
      update_id CHAR(36) NOT NULL,
      file_type ENUM('business_registration','tax_registration','licence_certificate','address_proof','business_photo') NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      relative_path VARCHAR(700) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      file_size BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_update_files_request FOREIGN KEY (update_id) REFERENCES supplier_update_requests(id) ON DELETE CASCADE,
      INDEX idx_update_files_request (update_id)
    ) ENGINE=InnoDB`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
  // Older databases may already have potential_contacts without location.
  // Run the migration only after the table exists, so a fresh CI database can boot.
  try {
    await pool.query("ALTER TABLE potential_contacts ADD COLUMN location VARCHAR(255) NULL");
  } catch (e) {
    if (!["ER_DUP_FIELDNAME", "ER_DUP_COLUMN"].includes(e?.code)) throw e;
  }

  await ensurePotentialContactsMigration();

  await ensureConnectRequestsTable();
  await ensureBuyerSchema();
  await ensureRequirementSchema();
  await ensureCapacitySchema();
  await ensureRfqSchema();
  await ensureAdminAuthSchema();
  await migrateLegacyCategories();

  // Bring older production databases up to the current launch schema.
  try { await pool.query("ALTER TABLE supplier_profiles ADD COLUMN profile_details_json TEXT NULL"); }
  catch (e) { if(!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }

  try {
    await pool.query("UPDATE connect_requests c LEFT JOIN buyer_enquiries e ON e.id=c.enquiry_id SET c.enquiry_id=NULL WHERE c.enquiry_id IS NOT NULL AND e.id IS NULL");
    await pool.query("ALTER TABLE connect_requests ADD CONSTRAINT fk_connect_enquiry FOREIGN KEY (enquiry_id) REFERENCES buyer_enquiries(id) ON DELETE SET NULL");
  } catch (e) {
    if(!["ER_DUP_CONSTRAINT","ER_FK_DUP_NAME","ER_CANT_CREATE_TABLE","ER_DUP_KEYNAME","ER_DUP_INDEX"].includes(e?.code)) throw e;
  }
}


// Moves data from the old category names to the current taxonomy (idempotent, cheap when nothing to move).
async function migrateLegacyCategories() {
  const oldNames = Object.keys(TAXONOMY.legacyCategoryFallback);
  const tables = ["supplier_applications","supplier_profiles","supplier_products","buyer_requirements"];
  for (const table of tables) {
    try {
      const [[hit]] = await pool.query("SELECT COUNT(*) AS n FROM `"+table+"` WHERE category IN (?)", [oldNames]);
      const [[chem]] = await pool.query("SELECT COUNT(*) AS n FROM `"+table+"` WHERE category='Chemicals' AND subcategory IS NOT NULL AND subcategory NOT IN (?)", [TAXONOMY.catalog["Chemicals"]]);
      if (!hit.n && !chem.n) continue;
      for (const [oc, os, nc, ns] of TAXONOMY.legacyMap) {
        if (oc === nc && os === ns) continue;
        await pool.query("UPDATE `"+table+"` SET category=?, subcategory=? WHERE category=? AND subcategory=?", [nc, ns, oc, os]);
      }
      for (const [oc, nc] of Object.entries(TAXONOMY.legacyCategoryFallback)) {
        await pool.query("UPDATE `"+table+"` SET category=?, subcategory='Other' WHERE category=?", [nc, oc]);
      }
      await pool.query("UPDATE `"+table+"` SET subcategory='Other' WHERE category='Chemicals' AND subcategory IS NOT NULL AND subcategory NOT IN (?)", [TAXONOMY.catalog["Chemicals"]]);
      console.log("Category taxonomy migrated:", table);
    } catch (e) {
      if (!["ER_NO_SUCH_TABLE","ER_BAD_FIELD_ERROR"].includes(e?.code)) throw e;
    }
  }
}

async function ensureAdminAuthSchema() {
  await pool.query("CREATE TABLE IF NOT EXISTS admin_sessions (id CHAR(36) PRIMARY KEY, token_hash CHAR(64) NOT NULL UNIQUE, role ENUM('admin','super_admin','tester') NOT NULL, admin_id VARCHAR(120) NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME NULL, INDEX idx_admin_session_expiry (expires_at), INDEX idx_admin_session_role (role)) ENGINE=InnoDB");
  await pool.query("ALTER TABLE admin_sessions MODIFY role ENUM('admin','super_admin','tester') NOT NULL");
  try { await pool.query("ALTER TABLE admin_sessions ADD INDEX idx_admin_session_admin (admin_id)"); }
  catch (e) { if(!["ER_DUP_KEYNAME"].includes(e?.code)) throw e; }
  await pool.query("CREATE TABLE IF NOT EXISTS admin_users (id CHAR(36) PRIMARY KEY, admin_id VARCHAR(120) NOT NULL, display_name VARCHAR(180) NULL, role ENUM('admin','tester') NOT NULL DEFAULT 'admin', password_salt CHAR(32) NOT NULL, password_hash CHAR(128) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, created_by VARCHAR(120) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at DATETIME NULL, password_changed_at DATETIME NULL, UNIQUE KEY uq_admin_user_id (admin_id)) ENGINE=InnoDB");
}

// ---- Audit log + RFQ state machine (Phase 1B) ----
function actorOf(req){
  if(req?.admin) return {id:req.admin.admin_id||"admin",role:req.admin.role||"admin"};
  if(req?.buyer) return {id:"buyer:"+(req.buyer.email||req.buyer.id),role:"buyer"};
  if(req?.supplier) return {id:"supplier:"+req.supplier.id,role:"supplier"};
  return {id:"system",role:"system"};
}
async function audit(db, req, action, entity, entityId, oldValue, newValue){
  const a=actorOf(req), j=(v)=>v==null?null:JSON.stringify(v).slice(0,8000);
  await db.execute("INSERT INTO audit_log (actor,actor_role,action,entity,entity_id,old_value,new_value,request_ip) VALUES (?,?,?,?,?,?,?,?)",
    [a.id,a.role,action,entity,entityId,j(oldValue),j(newValue),String(req?.ip||"").slice(0,64)||null]);
}
class RfqError extends Error{constructor(status,message){super(message);this.status=status;}}
// Move an RFQ through its state machine inside the caller's connection (row is locked for the check).
async function moveRfq(db, req, rfqId, to, note){
  if(!RFQ.isState(to)) throw new RfqError(400,"Unknown RFQ state.");
  const [[row]]=await db.execute("SELECT rfq_state,status FROM buyer_requirements WHERE id=? FOR UPDATE",[rfqId]);
  if(!row) throw new RfqError(404,"Requirement not found.");
  const from=row.rfq_state||RFQ.LEGACY_STATUS_TO_STATE[row.status]||"submitted";
  if(from===to) return {from,to,changed:false};
  if(!RFQ.canTransition(from,to)) throw new RfqError(409,"Cannot move this requirement from \""+RFQ.STATES[from].label+"\" to \""+RFQ.STATES[to].label+"\".");
  await db.execute("UPDATE buyer_requirements SET rfq_state=?,state_changed_at=NOW() WHERE id=?",[to,rfqId]);
  await audit(db,req,"rfq.state_change","rfq",rfqId,{state:from},{state:to,note:note||null});
  return {from,to,changed:true};
}

async function ensureCapacitySchema() {
  const add = async (table, ddl) => {
    try { await pool.query("ALTER TABLE "+table+" ADD COLUMN "+ddl); }
    catch (e) { if(!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  };
  await add("supplier_products","monthly_capacity BIGINT UNSIGNED NULL");
  await add("supplier_products","available_capacity BIGINT UNSIGNED NULL");
  await add("supplier_products","capacity_unit VARCHAR(40) NULL");
  await add("supplier_products","lead_time_days SMALLINT UNSIGNED NULL");
  await add("supplier_products","origin_region VARCHAR(150) NULL");
  await add("supplier_products","capacity_updated_at DATETIME NULL");
  await add("supplier_products","capability_code VARCHAR(24) NULL");
  try { await pool.query("ALTER TABLE supplier_products ADD UNIQUE INDEX uq_capability_code (capability_code)"); }
  catch (e) { if(!["ER_DUP_KEYNAME","ER_DUP_INDEX","ER_DUP_KEY"].includes(e?.code)) throw e; }
  // SupplyDesk decision on a buyer quote request (accept / partial / reject) with remarks.
  await add("buyer_enquiries","decision ENUM('pending','accepted','partial','rejected') NOT NULL DEFAULT 'pending'");
  await add("buyer_enquiries","approved_quantity VARCHAR(120) NULL");
  await add("buyer_enquiries","buyer_remark TEXT NULL");
  await add("buyer_enquiries","decided_at DATETIME NULL");
  await add("buyer_enquiries","decided_by VARCHAR(120) NULL");
  // Backfill capability IDs for listings created before Phase 1A.
  const [missing] = await pool.query("SELECT id,category FROM supplier_products WHERE capability_code IS NULL");
  for (const row of missing) {
    for (let attempt=0; attempt<8; attempt++) {
      try { await pool.execute("UPDATE supplier_products SET capability_code=? WHERE id=? AND capability_code IS NULL",[newCapabilityCode(row.category),row.id]); break; }
      catch (e) { if(e?.code!=="ER_DUP_ENTRY") throw e; }
    }
  }
}

async function ensureRfqSchema() {
  const add = async (ddl) => {
    try { await pool.query("ALTER TABLE buyer_requirements ADD COLUMN "+ddl); }
    catch (e) { if(!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  };
  await add("rfq_code VARCHAR(24) NULL");
  await add("rfq_state VARCHAR(30) NULL");
  await add("state_changed_at DATETIME NULL");
  await add("specification TEXT NULL");
  await add("quality_standards TEXT NULL");
  await add("certifications VARCHAR(255) NULL");
  await add("packaging TEXT NULL");
  await add("payment_terms VARCHAR(255) NULL");
  await add("incoterm VARCHAR(40) NULL");
  for (const ddl of ["ALTER TABLE buyer_requirements ADD UNIQUE INDEX uq_rfq_code (rfq_code)","ALTER TABLE buyer_requirements ADD INDEX idx_rfq_state (rfq_state, created_at)"]) {
    try { await pool.query(ddl); } catch (e) { if(!["ER_DUP_KEYNAME","ER_DUP_INDEX","ER_DUP_KEY"].includes(e?.code)) throw e; }
  }
  await pool.execute(`CREATE TABLE IF NOT EXISTS rfq_quotes (
    id CHAR(36) PRIMARY KEY,
    rfq_id CHAR(36) NOT NULL,
    quote_no VARCHAR(24) NOT NULL UNIQUE,
    unit_price DECIMAL(14,4) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    quantity VARCHAR(60) NOT NULL,
    total_price DECIMAL(16,2) NULL,
    lead_time_days INT NULL,
    valid_until DATE NULL,
    terms TEXT NULL,
    note TEXT NULL,
    status ENUM('sent','accepted','rejected','superseded') NOT NULL DEFAULT 'sent',
    buyer_note VARCHAR(500) NULL,
    created_by VARCHAR(190) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME NULL,
    INDEX idx_rfqq_rfq (rfq_id, status, created_at)
  ) ENGINE=InnoDB`);
  for (const ddl of ["cost_unit_price DECIMAL(14,4) NULL","markup_pct DECIMAL(6,2) NULL"]) {
    try { await pool.query("ALTER TABLE rfq_quotes ADD COLUMN "+ddl); }
    catch (e) { if(!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  }
  await pool.execute(`CREATE TABLE IF NOT EXISTS orders (
    id CHAR(36) PRIMARY KEY,
    po_number VARCHAR(24) NOT NULL UNIQUE,
    rfq_id CHAR(36) NOT NULL UNIQUE,
    rfq_quote_id CHAR(36) NOT NULL,
    buyer_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    quantity VARCHAR(60) NOT NULL,
    unit_price DECIMAL(14,4) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    total_price DECIMAL(16,2) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
    status_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_orders_buyer (buyer_id, created_at),
    INDEX idx_orders_status (status, created_at)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS supplier_pos (
    id CHAR(36) PRIMARY KEY,
    po_number VARCHAR(24) NOT NULL UNIQUE,
    order_id CHAR(36) NOT NULL,
    supplier_id CHAR(36) NOT NULL,
    product_id CHAR(36) NULL,
    title VARCHAR(255) NOT NULL,
    quantity VARCHAR(60) NOT NULL,
    unit_cost DECIMAL(14,4) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    total_cost DECIMAL(16,2) NULL,
    delivery_by DATE NULL,
    terms TEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'issued',
    supplier_note VARCHAR(500) NULL,
    status_changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(190) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_spo_supplier (supplier_id, status, created_at),
    INDEX idx_spo_order (order_id, status)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS invoices (
    id CHAR(36) PRIMARY KEY,
    invoice_no VARCHAR(24) NOT NULL UNIQUE,
    order_id CHAR(36) NOT NULL,
    buyer_id CHAR(36) NOT NULL,
    subtotal DECIMAL(16,2) NOT NULL,
    gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    gst_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    total DECIMAL(16,2) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    due_date DATE NULL,
    notes VARCHAR(1000) NULL,
    status ENUM('issued','partially_paid','paid','void') NOT NULL DEFAULT 'issued',
    paid_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
    created_by VARCHAR(190) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at DATETIME NULL,
    INDEX idx_inv_order (order_id, status),
    INDEX idx_inv_buyer (buyer_id, created_at)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS payments (
    id CHAR(36) PRIMARY KEY,
    invoice_id CHAR(36) NOT NULL,
    amount DECIMAL(16,2) NOT NULL,
    method VARCHAR(20) NOT NULL,
    reference VARCHAR(120) NULL,
    received_on DATE NOT NULL,
    note VARCHAR(500) NULL,
    recorded_by VARCHAR(190) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pay_invoice (invoice_id, received_on)
  ) ENGINE=InnoDB`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    actor VARCHAR(190) NOT NULL,
    actor_role VARCHAR(40) NOT NULL,
    action VARCHAR(80) NOT NULL,
    entity VARCHAR(40) NOT NULL,
    entity_id VARCHAR(80) NOT NULL,
    old_value TEXT NULL,
    new_value TEXT NULL,
    request_ip VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_entity (entity, entity_id, created_at),
    INDEX idx_audit_actor (actor, created_at)
  ) ENGINE=InnoDB`);
  // Backfill state + code for requirements created before Phase 1B.
  const [old] = await pool.query("SELECT id,status FROM buyer_requirements WHERE rfq_state IS NULL OR rfq_code IS NULL");
  for (const r of old) {
    for (let attempt=0; attempt<8; attempt++) {
      try { await pool.execute("UPDATE buyer_requirements SET rfq_state=COALESCE(rfq_state,?),rfq_code=COALESCE(rfq_code,?),state_changed_at=COALESCE(state_changed_at,NOW()) WHERE id=?",[RFQ.LEGACY_STATUS_TO_STATE[r.status]||"submitted",RFQ.newRfqCode(),r.id]); break; }
      catch (e) { if(e?.code!=="ER_DUP_ENTRY") throw e; }
    }
  }
}

async function ensureRequirementSchema() {
  await pool.execute("CREATE TABLE IF NOT EXISTS buyer_requirements (id CHAR(36) PRIMARY KEY, buyer_id CHAR(36) NOT NULL, requirement_type ENUM('product','raw_material','machinery','service','custom') NOT NULL DEFAULT 'product', title VARCHAR(255) NOT NULL, category VARCHAR(180) NULL, subcategory VARCHAR(180) NULL, description TEXT NOT NULL, quantity VARCHAR(120) NULL, unit VARCHAR(80) NULL, target_price DECIMAL(18,4) NULL, currency VARCHAR(10) NOT NULL DEFAULT 'USD', delivery_country VARCHAR(120) NULL, delivery_city VARCHAR(150) NULL, required_by DATE NULL, market_scope ENUM('Domestic','International','Both') NOT NULL DEFAULT 'Both', status ENUM('open','closed','cancelled') NOT NULL DEFAULT 'open', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL, CONSTRAINT fk_requirement_buyer FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE, INDEX idx_requirement_buyer (buyer_id, created_at), INDEX idx_requirement_match (status, category, subcategory, created_at)) ENGINE=InnoDB");
  await pool.execute("CREATE TABLE IF NOT EXISTS requirement_supplier_matches (id CHAR(36) PRIMARY KEY, requirement_id CHAR(36) NOT NULL, supplier_id CHAR(36) NOT NULL, status ENUM('available','viewed','quoted','declined') NOT NULL DEFAULT 'available', viewed_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_requirement_supplier (requirement_id, supplier_id), CONSTRAINT fk_req_match_requirement FOREIGN KEY (requirement_id) REFERENCES buyer_requirements(id) ON DELETE CASCADE, CONSTRAINT fk_req_match_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE, INDEX idx_req_match_supplier (supplier_id, status, created_at)) ENGINE=InnoDB");
  await pool.execute("CREATE TABLE IF NOT EXISTS supplier_quotes (id CHAR(36) PRIMARY KEY, requirement_id CHAR(36) NOT NULL, supplier_id CHAR(36) NOT NULL, unit_price DECIMAL(18,4) NOT NULL, currency VARCHAR(10) NOT NULL DEFAULT 'USD', quantity_available VARCHAR(120) NULL, moq VARCHAR(120) NULL, lead_time VARCHAR(120) NULL, payment_terms VARCHAR(255) NULL, incoterm VARCHAR(40) NULL, quote_valid_until DATE NULL, sample_available TINYINT(1) NOT NULL DEFAULT 0, notes TEXT NULL, status ENUM('submitted','withdrawn') NOT NULL DEFAULT 'submitted', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NULL, UNIQUE KEY uq_supplier_quote (requirement_id, supplier_id), CONSTRAINT fk_quote_requirement FOREIGN KEY (requirement_id) REFERENCES buyer_requirements(id) ON DELETE CASCADE, CONSTRAINT fk_quote_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_profiles(id) ON DELETE CASCADE, INDEX idx_quote_requirement (requirement_id, status, created_at), INDEX idx_quote_supplier (supplier_id, created_at)) ENGINE=InnoDB");
  // Admin-reviewed requirement workflow (idempotent upgrade of older databases).
  await pool.query("ALTER TABLE buyer_requirements MODIFY status ENUM('pending_review','open','fulfilling','rejected','closed','cancelled') NOT NULL DEFAULT 'pending_review'");
  let freshlyMigrated=false;
  for (const ddl of [
    "ALTER TABLE buyer_requirements ADD COLUMN fulfilment_mode ENUM('suppliers','supplydesk') NULL",
    "ALTER TABLE buyer_requirements ADD COLUMN admin_notes TEXT NULL",
    "ALTER TABLE buyer_requirements ADD COLUMN buyer_note TEXT NULL",
    "ALTER TABLE buyer_requirements ADD COLUMN reviewed_at DATETIME NULL",
    "ALTER TABLE buyer_requirements ADD COLUMN reviewed_by VARCHAR(120) NULL"
  ]) {
    try { await pool.query(ddl); freshlyMigrated=true; }
    catch (e) { if (!["ER_DUP_FIELDNAME","ER_DUP_COLUMN"].includes(e?.code)) throw e; }
  }
  // Requirements that were auto-published before review existed go back through admin review once.
  if (freshlyMigrated) await pool.query("UPDATE buyer_requirements SET status='pending_review' WHERE status='open' AND fulfilment_mode IS NULL");
}

async function start() {
  // The dashboard schema is idempotent. This repairs an older production DB
  // that is missing dashboard/product tables without requiring a manual
  // phpMyAdmin migration step.
  try {
    await pool.query("SELECT 1");
    await ensureDashboardSchema();
    console.log("SupplyDesk dashboard schema check completed.");
    app.listen(PORT, () => console.log(`SupplyDesk running on port ${PORT}`));
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}
start();
