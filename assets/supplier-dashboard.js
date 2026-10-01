
const dashboardKey="supplydesk_supplier_dashboard_token";
const dashboardStorage=sessionStorage;
const catalog={
"Raw Materials":["Metals","Minerals","Polymers","Industrial Raw Materials"],
"Plastics & Packaging":["Plastic Containers","Plastic Bottles","Packaging Films","Plastic Components"],
"Machinery":["Injection Moulding Machines","CNC Machines","Packaging Machines","Industrial Machinery"],
"Electronics & Components":["Electronic Components","PCB","Power Supplies","Sensors"],
"Automotive":["Auto Components","Accessories","Aftermarket Parts"],
"Textiles & Apparel":["Fabrics","Garments","Home Textiles"],
"Food & Agriculture":["Food Ingredients","Agri Products","Processed Food"],
"Chemicals":["Industrial Chemicals","Specialty Chemicals","Cleaning Chemicals"],
"Consumer Products":["Household Products","Kitchenware","Personal Care"],
"Construction Materials":["Building Materials","Tiles & Surfaces","Plumbing Products"],
"Logistics & Freight":["Sea Freight","Air Freight","Road Transport","Freight Forwarding"],
"Warehousing & Fulfilment":["Warehousing","Consolidation","Fulfilment"],
"Customs & Trade":["Customs Clearance","Trade Documentation","Import Export Support"],
"Inspection & Verification":["Factory Inspection","Pre-shipment Inspection","Quality Inspection"],
"Insurance":["Cargo Insurance","Transit Insurance","Trade Insurance"],
"Trade Finance":["Trade Finance","Letter of Credit","Working Capital"],
"Sourcing Services":["Product Sourcing","Supplier Discovery","Procurement Support"],
"Professional Services":["Consulting","Accounting & Tax","Legal Services"],
"Industrial Equipment":["Process Equipment","Material Handling","Plant Equipment"],
"Electrical Equipment":["Electrical Components","Switchgear","Industrial Controls"],
"Tools & Hardware":["Hand Tools","Power Tools","Hardware"],
"Metal Products":["Steel Products","Aluminium Products","Fabricated Parts"],
"Industrial Components":["Bearings","Fasteners","Seals"],
"Manufacturing Services":["Contract Manufacturing","Assembly","Fabrication"]
};
let dashboardData=null;

/* CSP-safe click/change delegation: data-onclick="fn('a',1,event)" */
(function(){
  function parseArgs(str,el,ev){
    const out=[];const re=/\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)|(true|false|null|event|this))\s*(,|$)/y;
    let m;re.lastIndex=0;
    while(re.lastIndex<str.length&&(m=re.exec(str))){
      if(m[1]!==undefined)out.push(m[1].replace(/\\(.)/g,"$1"));
      else if(m[2]!==undefined)out.push(m[2].replace(/\\(.)/g,"$1"));
      else if(m[3]!==undefined)out.push(Number(m[3]));
      else out.push(({true:true,false:false,null:null,event:{currentTarget:el,target:ev.target,preventDefault(){ev.preventDefault()}},this:el})[m[4]]);
      if(!m[5])break;
    }
    return out;
  }
  function run(attr){return function(ev){
    const el=ev.target.closest("["+attr+"]");if(!el)return;
    const code=el.getAttribute(attr).trim();
    const m=/^([A-Za-z_$][\w$]*)\((.*)\)$/s.exec(code);if(!m)return;
    const fn=window[m[1]];if(typeof fn!=="function")return;
    if(el.tagName==="A")ev.preventDefault();
    fn.apply(el,parseArgs(m[2],el,ev));
  }}
  document.addEventListener("click",run("data-onclick"));
  document.addEventListener("change",run("data-onchange"));
})();


function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function token(){return dashboardStorage.getItem(dashboardKey)||new URLSearchParams(location.search).get("token")||""}
async function api(url,options={}){
  const headers=Object.assign({"x-supplier-dashboard-token":token()},options.headers||{});
  const controller=new AbortController();
  const timeoutMs=Number(options.timeoutMs||15000);
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const fetchOptions=Object.assign({},options,{headers,signal:controller.signal});
    delete fetchOptions.timeoutMs;
    const r=await fetch(url,fetchOptions);
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
    return d;
  }catch(e){
    if(e.name==="AbortError")throw new Error("Dashboard request timed out after "+Math.round(timeoutMs/1000)+" seconds. Please try again.");
    throw e;
  }finally{clearTimeout(timer);}
}
function showLogin(message=""){
  document.getElementById("loginView").classList.remove("hidden");document.getElementById("dashboardView").classList.add("hidden");document.getElementById("navActions").classList.add("hidden");
  if(message){const s=document.getElementById("loginStatus");s.textContent=message;s.classList.remove("hidden");}
}
function showDashboard(){document.getElementById("loginView").classList.add("hidden");document.getElementById("dashboardView").classList.remove("hidden");document.getElementById("navActions").classList.remove("hidden");switchTab(location.hash&&document.getElementById("tab-"+location.hash.slice(1))?location.hash.slice(1):"overview");}
async function loadDashboard(){
  try{
    const d=await api("/api/supplier-dashboard");
    dashboardData=d;
    showDashboard();
    history.replaceState({},document.title,"supplier-dashboard.html");
    const s=d.supplier;
    fillBusinessDetails(d.supplier.profileDetails);
    document.getElementById("welcome").textContent="Welcome, "+(s.trade_name||s.legal_name);
    document.getElementById("views").textContent=d.metrics.profile_views_30d;
    document.getElementById("unique").textContent=d.metrics.unique_visitors_30d;
    document.getElementById("connectionsCount").textContent=d.metrics.connections_30d;
    document.getElementById("approvedProducts").textContent=d.metrics.approved_products;
    fillProfile(s);
    renderProducts(d.products||[]);
    renderConnections(d.connections||[]);
    renderProfileSummary(s);
    if(d.pendingUpdate){
      document.getElementById("dashboardStatus").innerHTML='<div class="notice">A profile update is currently <strong>'+esc(d.pendingUpdate.status)+'</strong>. Your public profile stays unchanged until SupplyDesk reviews it.</div>';
    } else {
      document.getElementById("dashboardStatus").innerHTML="";
    }
  }catch(e){
    const message=e?.message||"Could not load the supplier dashboard.";
    // Only clear the token when the API explicitly says it is unauthorized.
    // Server errors must not turn into the misleading "expired link" message.
    if(/unauthorized|invalid|expired/i.test(message)){
      dashboardStorage.removeItem(dashboardKey);
    }
    const s=document.getElementById("loginStatus");
    if(s){
      s.textContent="Dashboard could not open: "+message;
      s.className="notice error";
      s.classList.remove("hidden");
    }
    showLogin();
  }
}
function fillProfile(s){
  const map={pLegal:"legal_name",pTrade:"trade_name",pType:"business_type",pCountry:"country",pCity:"city",pEmail:"business_email",pPhone:"business_phone",pContact:"contact_person",pDesignation:"designation",pWebsite:"website",pAddress:"address"};
  Object.entries(map).forEach(([id,key])=>{const el=document.getElementById(id);if(el)el.value=s[key]||"";});
  renderCompanySummary(s);
  renderBusinessSummary(s,dashboardData?.supplier?.profileDetails||{});
}
function renderProfileSummary(s){return renderCompanySummary(s);}
function renderCompanySummary(s){
  const el=document.getElementById("companySummary");if(!el)return;
  el.innerHTML='<div class="summary-list">'+
    '<div class="summary-row"><span>Legal business name</span><strong>'+esc(s.legal_name)+'</strong></div>'+
    '<div class="summary-row"><span>Trade / brand</span><strong>'+esc(s.trade_name||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Business type</span><strong>'+esc(s.business_type||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Location</span><strong>'+esc([s.city,s.country].filter(Boolean).join(", "))+'</strong></div>'+
    '<div class="summary-row"><span>Category</span><strong>'+esc([s.category,s.subcategory].filter(Boolean).join(" → "))+'</strong></div>'+
    '<div class="summary-row"><span>Business email</span><strong>'+esc(s.business_email)+'</strong></div>'+
    '<div class="summary-row"><span>Business phone</span><strong>'+esc(s.business_phone||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Contact person</span><strong>'+esc([s.contact_person,s.designation].filter(Boolean).join(" · "))+'</strong></div>'+
    '<div class="summary-row"><span>Website</span><strong>'+esc(s.website||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Address</span><strong>'+esc(s.address||"Not added")+'</strong></div>'+
    '</div>';
}
function renderBusinessSummary(s,d){
  const el=document.getElementById("businessSummary");if(!el)return;
  const has=Object.values(d||{}).some(v=>String(v||"").trim());
  el.innerHTML='<div class="summary-list">'+
    '<div class="summary-row"><span>About</span><strong>'+esc(d.about||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Capabilities</span><strong>'+esc(d.capabilities||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Industries served</span><strong>'+esc(d.industries||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Markets served</span><strong>'+esc(d.markets||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Monthly capacity</span><strong>'+esc(d.monthlyCapacity||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Typical lead time</span><strong>'+esc(d.leadTime||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Payment terms</span><strong>'+esc(d.paymentTerms||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Incoterms</span><strong>'+esc(d.incoterms||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Shipping modes</span><strong>'+esc(d.shippingModes||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Certifications</span><strong>'+esc(d.certifications||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>OEM available</span><strong>'+esc(d.oem||"Not added")+'</strong></div>'+
    '<div class="summary-row"><span>Custom manufacturing</span><strong>'+esc(d.customManufacturing||"Not added")+'</strong></div>'+
    '</div>';
  const ov=document.getElementById("overviewBusiness");
  if(ov)ov.innerHTML='<div class="summary-list">'+
    '<div class="summary-row"><span>Business</span><strong>'+esc(s.trade_name||s.legal_name)+'</strong></div>'+
    '<div class="summary-row"><span>Location</span><strong>'+esc([s.city,s.country].filter(Boolean).join(", "))+'</strong></div>'+
    '<div class="summary-row"><span>Category</span><strong>'+esc([s.category,s.subcategory].filter(Boolean).join(" → "))+'</strong></div>'+
    '<div class="summary-row"><span>Products</span><strong>'+String(dashboardData?.metrics?.approved_products||0)+' approved</strong></div>'+
    '<div class="summary-row"><span>Profile status</span><strong>✓ Verified</strong></div>'+
    '</div>';
}
function renderProfileSummary(s){renderCompanySummary(s);}
function fillBusinessDetails(d){
  d=d||{}; const map={detailAbout:"about",detailCapabilities:"capabilities",detailIndustries:"industries",detailMarkets:"markets",detailCapacity:"monthlyCapacity",detailLeadTime:"leadTime",detailPayment:"paymentTerms",detailIncoterms:"incoterms",detailShipping:"shippingModes",detailCertifications:"certifications",detailOem:"oem",detailCustom:"customManufacturing"};
  Object.entries(map).forEach(([id,k])=>{const el=document.getElementById(id);if(el)el.value=d[k]||""});
  renderBusinessSummary(dashboardData?.supplier||{},d);
}
async function submitBusinessProfile(ev){
  ev=ev||window.event;
  const s=document.getElementById("profileDetailStatus"),btn=ev?.currentTarget||document.querySelector("#businessEditForm .primary");
  const profileDetails={about:document.getElementById("detailAbout").value.trim(),capabilities:document.getElementById("detailCapabilities").value.trim(),industries:document.getElementById("detailIndustries").value.trim(),markets:document.getElementById("detailMarkets").value.trim(),monthlyCapacity:document.getElementById("detailCapacity").value.trim(),leadTime:document.getElementById("detailLeadTime").value.trim(),paymentTerms:document.getElementById("detailPayment").value.trim(),incoterms:document.getElementById("detailIncoterms").value.trim(),shippingModes:document.getElementById("detailShipping").value.trim(),certifications:document.getElementById("detailCertifications").value.trim(),oem:document.getElementById("detailOem").value,customManufacturing:document.getElementById("detailCustom").value};
  btn.disabled=true;try{const d=await api("/api/supplier-dashboard/profile-update",{method:"POST",body:JSON.stringify({profileDetails}),headers:{"Content-Type":"application/json"}});s.textContent=d.message;s.className="notice success";s.classList.remove("hidden");renderBusinessSummary(dashboardData.supplier,profileDetails);setTimeout(()=>toggleBusinessEditor(false),700)}catch(e){s.textContent=e.message;s.className="notice error";s.classList.remove("hidden")}finally{btn.disabled=false}
}
function renderProducts(items){
  const el=document.getElementById("products");
  if(!items.length){el.innerHTML='<div class="empty">No products yet. Add your first product listing.</div>';return}
  el.innerHTML=items.map(p=>{
    const imgs=(p.images||[]).filter(x=>x.status!=="archived").map(x=>'<img data-product-image="'+esc(x.id)+'" data-product-id="'+esc(p.id)+'" alt="'+esc(p.product_name)+'">').join("");
    return '<div class="product"><div class="product-head"><div><div class="product-title">'+esc(p.product_name)+'</div><div class="product-meta">'+esc(p.category)+' → '+esc(p.subcategory)+' · '+esc(p.market_scope)+'</div></div><span class="badge '+esc(p.status)+'">'+esc(p.status)+'</span></div><div class="product-meta">'+esc(p.description||"No description added.")+(p.moq?' · MOQ: '+esc(p.moq):"")+(p.unit?' · Unit: '+esc(p.unit):"")+'</div>'+(imgs?'<div class="product-images">'+imgs+'</div>':"")+(p.admin_notes?'<div class="notice">'+esc(p.admin_notes)+'</div>':"")+'<div class="product-actions"><button class="btn" data-onclick="editProduct(\''+p.id+'\')">Edit</button><button class="btn" data-onclick="copyProduct(\''+p.id+'\')">Copy</button><button class="btn danger" data-onclick="archiveProduct(\''+p.id+'\')">Remove</button></div></div>';
  }).join("");
  hydrateDashboardImages();
}
async function hydrateDashboardImages(){
  const nodes=document.querySelectorAll("[data-product-image]");
  for(const img of nodes){
    try{
      const r=await fetch("/api/supplier-dashboard/products/"+encodeURIComponent(img.dataset.productId)+"/images/"+encodeURIComponent(img.dataset.productImage),{headers:{"x-supplier-dashboard-token":token()}});
      if(r.ok){const b=await r.blob();img.src=URL.createObjectURL(b);}
    }catch{}
  }
}
function connectionStatusLabel(v){return ({new:"New",contacted:"Contacted",in_discussion:"In Discussion",closed:"Closed"})[v]||v}
async function updateConnectionStatus(id,status){
  try{
    await api("/api/supplier-dashboard/connections/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status})});
    await loadDashboard();
  }catch(e){alert(e.message)}
}
function renderConnections(items){
  const el=document.getElementById("connections");
  if(!items.length){el.innerHTML='<div class="empty">No connection requests yet.</div>';return}
  el.innerHTML=items.map(c=>`
    <div class="connection">
      <div class="rowtop">
        <b>${esc(c.customer_name)}</b><span class="badge">${esc(connectionStatusLabel(c.status||"new"))}</span>
      </div>
      <small><a href="mailto:${esc(c.customer_email)}">${esc(c.customer_email)}</a>${c.customer_phone?' · '+esc(c.customer_phone):''}</small>
      <small>${c.customer_company?'Company: '+esc(c.customer_company)+' · ':''}${c.customer_country?'Country: '+esc(c.customer_country)+' · ':''}${c.product_name?'Requirement: '+esc(c.product_name):'General supplier enquiry'}${c.quantity?' · Qty: '+esc(c.quantity):''} · ${new Date(c.created_at).toLocaleString()}</small>
      ${c.message?'<small>'+esc(c.message)+'</small>':''}
      <div class="product-actions">
        <button class="btn" data-onclick="updateConnectionStatus('${esc(c.id)}','contacted')">Contacted</button>
        <button class="btn" data-onclick="updateConnectionStatus('${esc(c.id)}','in_discussion')">In Discussion</button>
        <button class="btn" data-onclick="updateConnectionStatus('${esc(c.id)}','closed')">Closed</button>
      </div>
    </div>`).join("");
}
function switchTab(tab){
  document.querySelectorAll(".tab-btn").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  document.querySelectorAll(".tab-panel").forEach(p=>p.classList.toggle("active",p.id==="tab-"+tab));
  if(history.replaceState)history.replaceState({},document.title,"supplier-dashboard.html#"+tab);
  if(tab==="requirements")loadRequirements();
  window.scrollTo({top:0,behavior:"smooth"});
}
let requirementCache=[];
async function loadRequirements(){
  const el=document.getElementById("requirementsList"); if(!el)return;
  el.innerHTML='<div class="empty">Loading buyer requirements...</div>';
  try{
    const d=await api("/api/supplier-dashboard/requirements"); requirementCache=d.requirements||[];
    if(!requirementCache.length){el.innerHTML='<div class="empty">No matching buyer requirements are available right now.</div>';return;}
    el.innerHTML=requirementCache.map(r=>'<div class="connection"><div class="rowtop"><div><b>'+esc(r.title)+'</b><small>'+esc(r.requirement_type||"product")+' · '+esc(r.category||"Open category")+(r.subcategory?" · "+esc(r.subcategory):"")+'</small></div><span class="badge">'+(r.quote_id?"Quoted":"Open")+'</span></div><small>Quantity: '+esc(r.quantity||"Not specified")+(r.unit?" "+esc(r.unit):"")+' · Delivery: '+esc((r.delivery_city||"")+" "+(r.delivery_country||""))+'</small><small>'+esc(r.description)+'</small><small>'+((r.target_price!==null&&r.target_price!=="")?"Target price: "+esc(r.target_price)+" "+esc(r.currency):"Target price: Not specified")+(r.required_by?" · Required by: "+esc(new Date(r.required_by).toLocaleDateString()):"")+'</small><div class="product-actions"><button class="btn primary" data-onclick="openRequirementQuote(\''+esc(r.id)+'\')">'+(r.quote_id?"Update Quotation":"Send Quotation")+' →</button></div></div>').join("");
  }catch(e){el.innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
function closeQuote(){document.getElementById("requirementQuoteModal")?.remove()}
function openRequirementQuote(id){
  const r=requirementCache.find(x=>x.id===id); if(!r)return;
  const old=document.getElementById("requirementQuoteModal"); if(old)old.remove();
  const modal=document.createElement("div");modal.id="requirementQuoteModal";modal.className="modal show";
  modal.innerHTML='<div class="mcard wide"><div><div><div class="kicker">Quotation</div><h2>'+esc(r.title)+'</h2><small>'+esc(r.quantity||"Quantity not specified")+' '+esc(r.unit||"")+' · '+esc(r.delivery_city||"")+' '+esc(r.delivery_country||"")+'</small></div><button class="mclose" type="button" aria-label="Close" data-onclick="closeQuote()">×</button></div><div class="profile-grid qgrid"><label>Unit price *<input id="qPrice" type="number" min="0" step="0.0001" value="'+esc(r.quote_unit_price||"")+'"></label><label>Currency<select id="qCurrency"><option>USD</option><option>EUR</option><option>GBP</option><option>INR</option><option>AED</option><option>CNY</option></select></label><label>Quantity available<input id="qAvailable" placeholder="e.g. 20,000"></label><label>MOQ<input id="qMoq" placeholder="e.g. 5,000"></label><label>Lead time<input id="qLead" placeholder="e.g. 15 days"></label><label>Payment terms<input id="qPayment" placeholder="30/70, LC, etc."></label><label>Incoterm<input id="qIncoterm" placeholder="FOB / CIF / EXW"></label><label>Quote valid until<input id="qValid" type="date"></label><label class="chk"><input id="qSample" type="checkbox"> Sample available</label><label class="full">Notes<textarea id="qNotes" placeholder="Quality, customization, certifications, packing or other commercial terms"></textarea></label></div><div id="qStatus" class="notice hidden"></div><div class="actions end"><button class="btn primary" data-onclick="submitRequirementQuote(\''+esc(r.id)+'\')">Send Quotation to Buyer →</button></div></div>';
  document.body.appendChild(modal);
}
async function submitRequirementQuote(id){
  const s=document.getElementById("qStatus"); try{
    const d=await api("/api/supplier-dashboard/requirements/"+encodeURIComponent(id)+"/quote",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({unitPrice:document.getElementById("qPrice").value,currency:document.getElementById("qCurrency").value,quantityAvailable:document.getElementById("qAvailable").value,moq:document.getElementById("qMoq").value,leadTime:document.getElementById("qLead").value,paymentTerms:document.getElementById("qPayment").value,incoterm:document.getElementById("qIncoterm").value,quoteValidUntil:document.getElementById("qValid").value,sampleAvailable:document.getElementById("qSample").checked,notes:document.getElementById("qNotes").value})});
    s.textContent=d.message;s.className="notice success";s.classList.remove("hidden");setTimeout(()=>{closeQuote();loadRequirements()},800);
  }catch(e){s.textContent=e.message;s.className="notice error";s.classList.remove("hidden");}
}
function toggleBusinessEditor(force){
  const form=document.getElementById("businessEditForm"),btn=document.getElementById("businessEditBtn");
  const open=typeof force==="boolean"?force:!form.classList.contains("open");
  form.classList.toggle("open",open);
  btn.textContent=open?"Close Editor":"Edit Profile";
  if(open)document.getElementById("detailAbout")?.focus();
}
function openBusinessEditor(){switchTab("business");toggleBusinessEditor(true);}
function toggleCompanyEditor(force){
  const form=document.getElementById("profileForm"),btn=document.getElementById("companyEditBtn");
  const open=typeof force==="boolean"?force:!form.classList.contains("open");
  form.classList.toggle("open",open);
  btn.textContent=open?"Close Editor":"Request Changes";
  if(open)document.getElementById("pLegal")?.focus();
}

function fillCategorySelect(){
  const cat=document.getElementById("productCategory"),sub=document.getElementById("productSubcategory");
  cat.innerHTML=Object.keys(catalog).map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("");
  function fill(){sub.innerHTML=(catalog[cat.value]||[]).map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("")}
  cat.onchange=fill;fill();
}
let productFormMode="add";
function openProduct(product,mode){
  productFormMode=mode|| (product?"edit":"add");
  fillCategorySelect();document.getElementById("productModal").classList.add("show");
  document.getElementById("productTitle").textContent=productFormMode==="copy"?"Copy Product":product?"Edit Product":"Add Product";
  document.getElementById("productId").value=product?.id||"";
  document.getElementById("productName").value=product?.product_name||"";
  document.getElementById("productCategory").value=product?.category||dashboardData.supplier.category;
  document.getElementById("productCategory").dispatchEvent(new Event("change"));
  document.getElementById("productSubcategory").value=product?.subcategory||dashboardData.supplier.subcategory;
  document.getElementById("productMoq").value=product?.moq||"";
  document.getElementById("productUnit").value=product?.unit||"";
  document.getElementById("productMarket").value=product?.market_scope||"Both";
  document.getElementById("productDescription").value=product?.description||"";
  document.getElementById("productImages").value="";
  document.getElementById("imagePreview").innerHTML=(product?.images||[]).filter(x=>x.status!=="archived").map(x=>'<img data-modal-image="'+esc(x.id)+'" data-product-id="'+esc(product.id)+'" alt="">').join("");
  hydrateModalImages(product?.id);
  document.getElementById("productStatus").classList.add("hidden");
}
async function hydrateModalImages(productId){
  document.querySelectorAll("[data-modal-image]").forEach(async img=>{
    try{const r=await fetch("/api/supplier-dashboard/products/"+encodeURIComponent(productId)+"/images/"+encodeURIComponent(img.dataset.modalImage),{headers:{"x-supplier-dashboard-token":token()}});if(r.ok){const b=await r.blob();img.src=URL.createObjectURL(b);}}catch{}
  });
}
function closeProduct(){document.getElementById("productModal").classList.remove("show")}
function findProduct(id){return (dashboardData.products||[]).find(x=>x.id===id)}
function editProduct(id){const p=findProduct(id);if(p)openProduct(p,"edit")}
function copyProduct(id){
  const p=findProduct(id);
  if(!p)return;
  openProduct({...p,id:"",product_name:p.product_name},"copy");
}
async function archiveProduct(id){if(!confirm("Remove this product from your public listings?"))return;try{await api("/api/supplier-dashboard/products/"+id,{method:"DELETE"});await loadDashboard()}catch(e){alert(e.message)}}

let otpRequestGeneration=0;
let otpRequestReady=false;
let otpRequestedEmail="";

function invalidateOtpRequest(){
  otpRequestGeneration++;
  otpRequestReady=false;
  otpRequestedEmail="";
  const otp=document.getElementById("loginOtp");
  if(otp)otp.value="";
}

document.getElementById("loginEmail").addEventListener("input",invalidateOtpRequest);

async function requestOtp(){
  const requestGeneration=++otpRequestGeneration;
  otpRequestReady=false;
  otpRequestedEmail="";
  const btn=document.getElementById("loginBtn"),s=document.getElementById("loginStatus"),email=document.getElementById("loginEmail").value.trim(),otpStep=document.getElementById("otpStep");
  if(!email){s.textContent="❌ Please enter your registered business email.";s.className="notice error";s.classList.remove("hidden");return}
  otpStep.classList.add("show");
  s.textContent="⏳ Sending OTP request to SupplyDesk...";s.className="notice";s.classList.remove("hidden");
  btn.disabled=true;btn.textContent="Sending OTP...";
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),300000);
  try{
    const r=await fetch("/api/supplier-dashboard/request-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email}),signal:controller.signal});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error((data.error||("Server returned HTTP "+r.status))+(data.requestId?" | Request ID: "+data.requestId:""));
    const accepted = Array.isArray(data.smtpAccepted) ? data.smtpAccepted.length : 0;
    const rejected = Array.isArray(data.smtpRejected) ? data.smtpRejected.length : 0;
    s.textContent=accepted
      ? "✅ SMTP accepted the OTP for "+email+". Check Inbox and Junk/Spam. "+(data.smtpResponse||"")+(data.requestId?" Request ID: "+data.requestId:"")
      : "⚠️ The request reached SupplyDesk, but the mail server did not accept the recipient."+(rejected?" Rejected: "+data.smtpRejected.join(", "):"")+(data.requestId?" Request ID: "+data.requestId:"");
    if(requestGeneration!==otpRequestGeneration)return;
    otpRequestReady=true;
    otpRequestedEmail=email.toLowerCase();
    s.className="notice success";s.classList.remove("hidden");
    document.getElementById("loginOtp").focus();
  }catch(e){
    if(requestGeneration!==otpRequestGeneration)return;
    otpRequestReady=false;
    otpRequestedEmail="";
    document.getElementById("loginOtp").value="";
    s.textContent=e.name==="AbortError"
      ?"❌ OTP request timed out after 5 minutes. Any OTP from that delayed request will not be accepted here. Please click Resend 6-Digit OTP and use the OTP from the new request."
      :"❌ "+(e.message||"Could not send OTP.");
    s.className="notice error";s.classList.remove("hidden");
  }finally{
    clearTimeout(timer);btn.disabled=false;btn.textContent="Resend 6-Digit OTP";
  }
}
document.getElementById("resendOtpBtn").onclick=requestOtp;
document.getElementById("loginBtn").onclick=requestOtp;
document.getElementById("verifyOtpBtn").onclick=async()=>{
  const btn=document.getElementById("verifyOtpBtn"),s=document.getElementById("loginStatus"),email=document.getElementById("loginEmail").value.trim().toLowerCase(),otp=document.getElementById("loginOtp").value.trim();
  if(!otpRequestReady || otpRequestedEmail!==email){
    s.textContent="❌ This OTP request is no longer valid. Please click Resend 6-Digit OTP and use the OTP from the new request.";
    s.className="notice error";s.classList.remove("hidden");
    document.getElementById("loginOtp").value="";
    return;
  }
  btn.disabled=true;btn.textContent="Verifying...";
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch("/api/supplier-dashboard/verify-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,otp}),signal:controller.signal});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||("OTP verification failed (HTTP "+r.status+")."));
    if(!data.token)throw new Error("OTP verified but the server did not return a dashboard token.");
    dashboardStorage.setItem(dashboardKey,data.token);
    await loadDashboard();
  }catch(e){
    s.textContent=e.name==="AbortError"
      ?"OTP verification is taking too long. The server did not respond within 15 seconds. Please try again."
      :(e.message||"Could not verify OTP.");
    s.className="notice error";s.classList.remove("hidden");
  }finally{
    clearTimeout(timer);btn.disabled=false;btn.textContent="Verify OTP →";
  }
};

document.getElementById("productForm").onsubmit=async e=>{
  e.preventDefault();const id=document.getElementById("productId").value;const btn=document.getElementById("productBtn"),s=document.getElementById("productStatus");btn.disabled=true;btn.textContent="Saving...";
  const body={product_name:document.getElementById("productName").value.trim(),category:document.getElementById("productCategory").value,subcategory:document.getElementById("productSubcategory").value,moq:document.getElementById("productMoq").value.trim(),unit:document.getElementById("productUnit").value.trim(),market_scope:document.getElementById("productMarket").value,description:document.getElementById("productDescription").value.trim()};
  try{
    const d=await api(id?"/api/supplier-dashboard/products/"+id:"/api/supplier-dashboard/products",{method:id?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const productId=id||d.id;
    const files=document.getElementById("productImages").files;
    if(files.length){
      const fd=new FormData();for(const f of files)fd.append("productImages",f);
      const imgResult=await api("/api/supplier-dashboard/products/"+encodeURIComponent(productId)+"/images",{method:"POST",body:fd});
      s.textContent=imgResult.message;
    }else s.textContent=d.message;
    s.className="notice success";s.classList.remove("hidden");setTimeout(async()=>{closeProduct();await loadDashboard()},900)
  }catch(e){s.textContent=e.message;s.className="notice error";s.classList.remove("hidden")}finally{btn.disabled=false;btn.textContent=id?"Submit Changes for Review":"Submit for Review"}
};

document.getElementById("profileForm").onsubmit=async e=>{
  e.preventDefault();const btn=document.getElementById("profileBtn");btn.disabled=true;btn.textContent="Submitting...";
  const body={};new FormData(e.currentTarget).forEach((v,k)=>body[k]=String(v).trim());
  try{
    const d=await api("/api/supplier-dashboard/profile-update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    document.getElementById("dashboardStatus").innerHTML="<div class=\"notice success\">"+esc(d.message)+"</div>";
    toggleCompanyEditor(false);
  }catch(err){
    document.getElementById("dashboardStatus").innerHTML="<div class=\"notice error\">"+esc(err.message)+"</div>";
  }finally{
    btn.disabled=false;
    btn.textContent="Submit Changes for Review";
  }
};

async function logout(){try{await api("/api/supplier-dashboard/logout",{method:"POST"})}catch{}dashboardStorage.removeItem(dashboardKey);showLogin("You have signed out.");}
document.getElementById("productImages").addEventListener("change",e=>{
  document.getElementById("imagePreview").innerHTML=Array.from(e.target.files).slice(0,6).map(f=>'<div><img src="'+URL.createObjectURL(f)+'" alt=""><div class="image-note">'+esc(f.name)+'</div></div>').join("");
});
fillCategorySelect();

document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeQuote();closeProduct();}});
const initialTab=location.hash?location.hash.slice(1):"overview";
if(token())loadDashboard();else showLogin();
