/* SupplyDesk Admin workflow screens.
   Flow: Request -> Review (accept full / partial / reject) -> SupplyDesk order -> Sourcing plan -> Supplier PO -> Production -> QC -> Logistics -> Delivery -> Close.
   Loaded before the main admin script; uses its globals (api, esc, role, setTab, rqFact, rqSec ...) at call time only. */
const CUR={screen:"",phase:"",sd:[],srcFilter:"plan",ex:[],net:[],q:""};
const fnum=n=>n==null||n===""?"-":Number(n).toLocaleString("en-IN");
const flowMsg=t=>{const m=document.getElementById("message");if(m)m.textContent=t||""};
const flowErr=e=>flowMsg(e&&e.message?e.message:String(e));
const needSignIn=()=>{if(role())return false;flowMsg("Sign in to continue.");return true};
const ACT_LABEL={"rfq.accepted_full":"Accepted in full","rfq.accepted_partial":"Accepted partially","rfq.quote_sent":"Quotation sent to buyer","rfq.shared_with_suppliers":"Shared with suppliers","rfq.quote_rejected":"Buyer declined the quotation","order.created":"Order created","order.reviewed":"Order reviewed","sd_order.created":"SupplyDesk order created","sd_order.plan_confirmed":"Sourcing plan confirmed","sd_order.plan_saved":"Sourcing plan saved"};
const actText=a=>ACT_LABEL[a]||String(a||"").replace(/[._]/g," ").replace(/^./,c=>c.toUpperCase());
const tlHtml=(rows)=>'<div class="tl">'+(rows.map(r=>'<div class="tl-i"><b>'+esc(r.t)+'</b>'+(r.d?'<div class="muted">'+esc(r.d)+'</div>':'')+'<small>'+esc(r.at)+(r.by?' · '+esc(r.by):'')+'</small></div>').join("")||'<div class="muted">No activity yet.</div>')+'</div>';
const dt=s=>{try{return new Date(s).toLocaleString([],{dateStyle:"medium",timeStyle:"short"})}catch{return""}};
function setExBadge(n){const b=document.getElementById("exCount");if(b)b.textContent=n?String(n):""}

function goScreen(s){
  const map={requests:()=>loadBuyerRequirements(),sourcing:()=>loadSourcing(),orders:()=>loadOrders(),production:()=>loadPhase("production"),qc:()=>loadPhase("qc"),logistics:()=>loadPhase("logistics"),finance:()=>loadPhase("finance"),capacity:()=>loadNetwork("capacity"),exceptions:()=>loadExceptions()};
  return (map[s]||loadOverview)();
}

// ---------- Overview: pipeline ----------

// ---- Work assignment (Management / Super Admin) ----
function canAssign(){return ["super_admin","management"].includes(role())}
function assignBox(type,id){
  if(!canAssign())return "";
  setTimeout(()=>hydrateAssign(type,id),0);
  return '<div class="as-box" id="asBox" data-t="'+esc(type)+'" data-i="'+esc(id)+'"><span class="muted">Loading assignment...</span></div>';
}
async function hydrateAssign(type,id){
  const box=document.getElementById("asBox");if(!box||box.dataset.i!==id)return;
  try{
    const [a,t]=await Promise.all([api("/api/admin/assignments?entityType="+type+"&entityId="+encodeURIComponent(id)),api("/api/admin/assignees")]);
    const cur=d=>((a.assignments||[]).find(x=>x.desk===d)||{}).admin_id||"";
    const sel=(desk,label,r)=>{
      const users=(t.users||[]).filter(u=>u.role===r);
      return '<label>'+label+'<select data-desk="'+desk+'" onchange="saveAssign(\''+type+'\',\''+esc(id)+'\',\''+desk+'\',this)"><option value="">Unassigned</option>'+users.map(u=>'<option value="'+esc(u.admin_id)+'"'+(u.admin_id===cur(desk)?' selected':'')+'>'+esc(u.display_name||u.admin_id)+'</option>').join("")+'</select></label>';
    };
    box.innerHTML=(type==="requirement"?sel("buyer","Buyer Desk","buyer_desk"):"")+sel("procurement","Sourcing Desk","procurement");
  }catch(e){box.innerHTML='<span class="muted">'+esc(e.message)+'</span>'}
}
async function saveAssign(type,id,desk,el){
  try{await api("/api/admin/assignments",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({entityType:type,entityId:id,desk,adminId:el.value||null})});flowMsg("Assignment saved.")}
  catch(e){flowMsg(e.message);hydrateAssign(type,id)}
}


// ---- Disclosure approvals + My Desk ----
const DESK_KIND={buyer_desk:["supplier_identity","supplier details"],procurement:["buyer_contact","buyer contact details"]};
function discBox(type,id){
  const k=DESK_KIND[role()];if(!k||(role()==="buyer_desk"&&type!=="requirement"))return "";
  setTimeout(()=>hydrateDisc(type,id),0);
  return '<div class="as-box" id="dcBox" data-i="'+esc(id)+'"><span class="muted">Loading...</span></div>';
}
async function hydrateDisc(type,id){
  const box=document.getElementById("dcBox");if(!box||box.dataset.i!==id)return;
  const k=DESK_KIND[role()];
  try{
    const d=await api("/api/admin/disclosure-requests?entityId="+encodeURIComponent(id));
    const rows=(d.requests||[]).filter(r=>r.kind===k[0]);
    const act=rows.find(r=>r.status==="approved"&&!r.expired),pend=rows.find(r=>r.status==="pending"),last=rows[0];
    box.innerHTML='<div><b>'+esc(k[1])+'</b><div class="muted">Shown only with Management approval.</div></div>'
      +(act?'<button onclick="revealDisc(\''+esc(act.id)+'\')">View (approved until '+esc(String(act.expires_at).replace("T"," ").slice(0,16))+')</button>'
        :pend?'<span class="pill">Request pending</span>'
        :'<button onclick="requestDisc(\''+type+'\',\''+esc(id)+'\')">Request '+esc(k[1])+'</button>'+(last&&last.status==="rejected"?' <span class="muted">Last request rejected'+(last.decision_note?': '+esc(last.decision_note):'')+'</span>':''))
      +'<div id="dcOut"></div>';
  }catch(e){box.innerHTML='<span class="muted">'+esc(e.message)+'</span>'}
}
async function requestDisc(type,id){
  const reason=prompt("Why do you need these details? (Management will see this)");if(!reason)return;
  try{await api("/api/admin/disclosure-requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({entityType:type,entityId:id,reason})});flowMsg("Request sent to Management.");hydrateDisc(type,id)}
  catch(e){flowMsg(e.message)}
}
async function revealDisc(rid){
  try{
    const d=await api("/api/admin/disclosure-requests/"+rid+"/reveal");
    const rows=(d.buyers||d.suppliers||[]).map(x=>'<div class="muted" style="margin-top:4px">'+Object.values(x).filter(Boolean).map(esc).join(" · ")+'</div>').join("")||'<div class="muted">Nothing on file.</div>';
    document.getElementById("dcOut").innerHTML=rows;
  }catch(e){flowMsg(e.message)}
}
async function loadApprovals(){
  setTab("approvals");CUR.screen="approvals";
  if(needSignIn())return;
  try{
    const d=await api("/api/admin/disclosure-requests?status=pending");
    const rows=d.requests||[];
    document.getElementById("detail").innerHTML='<h2>Disclosure approvals</h2><div class="muted">A desk is asking to see the other side. Approve only what the work needs; access expires automatically.</div>'
      +(rows.length?rows.map(r=>'<div class="pl-card" style="margin-top:12px"><h3>'+esc(r.requested_by)+' <small class="muted">('+esc(r.requester_role)+')</small> wants '+(r.kind==="buyer_contact"?"buyer contact details":"supplier identity")+'</h3><div class="muted">'+esc(r.sd_ref||r.req_ref||"")+'</div><p>'+esc(r.reason)+'</p><div class="actions"><select id="dh'+esc(r.id)+'"><option value="4">4 hours</option><option value="24" selected>24 hours</option><option value="72">3 days</option></select><button class="approve" onclick="decideDisc(\''+esc(r.id)+'\',\'approve\')">Approve</button><button class="reject" onclick="decideDisc(\''+esc(r.id)+'\',\'reject\')">Reject</button></div></div>').join(""):'<div class="pl-card" style="margin-top:12px">No pending requests.</div>');
    flowMsg("");
  }catch(err){flowErr(err)}
}
async function decideDisc(id,decision){
  const note=decision==="reject"?prompt("Reason (optional)")||"":"";
  try{await api("/api/admin/disclosure-requests/"+id+"/decision",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({decision,note,hours:Number((document.getElementById("dh"+id)||{}).value)||24})});await loadApprovals();flowMsg(decision==="approve"?"Approved.":"Rejected.")}
  catch(e){flowMsg(e.message)}
}
async function loadMyDesk(){
  setTab("overview");CUR.screen="overview";
  try{
    const d=await api("/api/admin/my-desk"),buyer=d.desk==="buyer";
    const open=it=>buyer?"openBuyerRequirementAdmin('"+esc(it.id)+"')":"openSourcingPlan('"+esc(it.id)+"')";
    const tiles=buyer?[["To review",(d.counts.submitted||0)],["Total assigned",d.items.length]]:[["To plan",d.counts.to_plan||0],["Planned",d.counts.planned||0],["Declined POs",d.counts.declined||0]];
    document.getElementById("detail").innerHTML='<h2>My desk</h2><div class="muted">'+(buyer?"Buyer requirements assigned to you.":"SupplyDesk orders assigned to you for sourcing.")+'</div>'
      +'<div class="sp-sum">'+tiles.map(t=>'<div><small>'+t[0]+'</small><b>'+t[1]+'</b></div>').join("")+'</div>'
      +(d.items.length?'<div class="pl-card">'+d.items.map(it=>'<div class="pl-ex" onclick="'+open(it)+'"><span>'+(it.needsAction?'<b>● </b>':'')+esc(it.title||"")+' <small>· '+esc(buyer?(it.rfq_code||""):(it.sd_number||""))+'</small></span><small>'+(buyer?esc(it.stateLabel):fnum(it.allocated)+' / '+fnum(it.needed))+'</small></div>').join("")+'</div>':'<div class="pl-card">Nothing is assigned to you yet. Management assigns work to your desk.</div>');
  }catch(err){flowErr(err)}
}

async function loadOverview(){
  if(DESK_KIND[role()]&&role()!=="finance")return loadMyDesk();
  setTab("overview");CUR.screen="overview";
  if(needSignIn())return;
  try{
    const [p,e]=await Promise.all([api("/api/admin/pipeline"),api("/api/admin/exceptions").catch(()=>({exceptions:[]}))]);
    CUR.ex=e.exceptions||[];setExBadge(CUR.ex.length);
    const hot=new Set(["new_requests","review","sourcing"]);
    const flow=p.stages.map(s=>'<button class="pl-stage'+(s.count?"":" zero")+(s.count&&hot.has(s.key)?" hot":"")+'" data-stage="'+esc(s.key)+'" onclick="goScreen(\''+esc(s.screen)+'\')"><b>'+s.count+'</b><span>'+esc(s.label)+'</span></button>').join("");
    const by=k=>(p.stages.find(s=>s.key===k)||{count:0}).count;
    const todo=[];
    if(by("new_requests"))todo.push(['requests',by("new_requests")+' new request(s) waiting for your decision']);
    if(by("review"))todo.push(['orders',by("review")+' buyer order(s) waiting for review']);
    if(by("sourcing"))todo.push(['sourcing',by("sourcing")+' SupplyDesk order(s) need a sourcing plan']);
    if(by("qc"))todo.push(['qc',by("qc")+' PO(s) waiting for QC']);
    const todoHtml=todo.length?todo.map(t=>'<div class="pl-ex" onclick="goScreen(\''+t[0]+'\')"><span>'+esc(t[1])+'</span><small>Open ›</small></div>').join(""):'<div class="muted">Nothing is waiting on you right now.</div>';
    const exHtml=CUR.ex.length?CUR.ex.slice(0,6).map((x,i)=>'<div class="pl-ex" onclick="goException('+i+')"><span><b>'+esc(x.label)+'</b><br><small>'+esc(x.title||"")+(x.ref?' · '+esc(x.ref):'')+'</small></span><small>'+esc(x.ageHours==null?"":x.ageHours<48?x.ageHours+"h":Math.floor(x.ageHours/24)+"d")+'</small></div>').join(""):'<div class="muted">No exceptions.</div>';
    document.getElementById("detail").innerHTML='<h2>Overview</h2><div class="muted">New Requests → Review → Accepted → Sourcing → Supplier PO → Production → QC → Transit → Delivery. Click a stage to open it.</div><div class="pl-flow">'+flow+'</div>'
      +'<div class="pl-cols"><div class="pl-card"><h3>Needs your action</h3>'+todoHtml+'</div><div class="pl-card"><h3>Exceptions ('+CUR.ex.length+')</h3>'+exHtml+(CUR.ex.length>6?'<div class="pl-ex" onclick="loadExceptions()"><span>View all</span><small>›</small></div>':'')+'</div></div>';
    flowMsg("");
  }catch(e){flowErr(e)}
}
function goException(i){
  const x=CUR.ex[i];if(!x)return;
  if(x.screen==="requests")return loadBuyerRequirements().then(()=>openBuyerRequirementAdmin(x.id));
  if(x.screen==="sourcing")return loadSourcing().then(()=>openSourcingPlan(x.id));
  if(x.screen==="orders")return loadOrders().then(()=>openOrderAdmin(x.id));
  return goScreen(x.screen);
}
async function loadExceptions(){
  setTab("exceptions");CUR.screen="exceptions";
  if(needSignIn())return;
  try{
    const e=await api("/api/admin/exceptions");CUR.ex=e.exceptions||[];setExBadge(CUR.ex.length);
    const groups={};CUR.ex.forEach((x,i)=>{(groups[x.label]=groups[x.label]||[]).push([x,i])});
    document.getElementById("detail").innerHTML='<h2>Exceptions</h2><div class="muted">Anything late, stuck or declined. Each row opens the place where you can fix it.</div>'
      +(Object.keys(groups).map(g=>'<div class="pl-card" style="margin-top:12px"><h3>'+esc(g)+' ('+groups[g].length+')</h3>'+groups[g].map(([x,i])=>'<div class="pl-ex" onclick="goException('+i+')"><span>'+esc(x.title||"")+(x.ref?' <small>· '+esc(x.ref)+'</small>':'')+'</span><small>'+esc(x.ageHours==null?"":x.ageHours<48?x.ageHours+"h":Math.floor(x.ageHours/24)+"d")+'</small></div>').join("")+'</div>').join("")||'<div class="pl-card" style="margin-top:12px"><div class="muted">No exceptions. Everything is moving.</div></div>');
    flowMsg("");
  }catch(err){flowErr(err)}
}

// ---------- Requests: initial review ----------
function reqTimeline(r,au){
  const rows=[{t:"Requirement received",at:dt(r.created_at),by:""}];
  (au.entries||[]).slice().reverse().filter(e=>e.action!=="rfq.created").forEach(e=>{
    let d="";try{const n=e.new_value?JSON.parse(e.new_value):null;if(n&&n.acceptedQuantity)d="Accepted quantity "+n.acceptedQuantity+(n.requested?" of "+n.requested:"");}catch{}
    rows.push({t:actText(e.action),d,at:dt(e.created_at),by:/^buyer:/.test(e.actor||"")?"Buyer":(e.actor||"")});
  });
  return rows;
}
function decisionCard(id,r){
  const total=((r.quantity||"")+" "+(r.unit||"")).trim();
  return '<div class="rq-next" id="reqDecision"><div class="rq-next-h">Decision</div><div class="muted">Does SupplyDesk take this requirement? Sourcing from suppliers happens afterwards, internally.</div>'
   +'<div class="dec-row"><button class="approve" id="decFull" onclick="reviewRequirement(\''+esc(id)+'\',\'accept_full\')">Accept in full</button><button id="decPartial" onclick="togglePartial()">Accept partially</button><button class="danger" id="decReject" onclick="reviewRequirement(\''+esc(id)+'\',\'reject\')">Reject</button></div>'
   +'<div class="dec-partial" id="partialBox"><label>Quantity SupplyDesk will supply <small>(requested: '+esc(total||"n/a")+')</small><input id="reqAccQty" type="number" min="1" step="1" placeholder="e.g. 60000"></label><div class="actions"><button class="primary" onclick="acceptPartial(\''+esc(id)+'\')">Confirm partial acceptance</button></div></div>'
   +'<div class="rq-grid2"><label>Internal notes <small>(not shown to buyer)</small><textarea id="reqAdminNotes" style="min-height:52px">'+esc(r.admin_notes||"")+'</textarea></label><label>Message to buyer <small>(email + dashboard)</small><textarea id="reqBuyerNote" style="min-height:52px">'+esc(r.buyer_note||"")+'</textarea></label></div></div>';
}
function togglePartial(){const b=document.getElementById("partialBox");if(b)b.style.display=b.style.display==="block"?"none":"block";const i=document.getElementById("reqAccQty");if(i&&b.style.display==="block")i.focus()}
function acceptPartial(id){const q=(document.getElementById("reqAccQty")||{}).value;if(!q||Number(q)<=0){flowMsg("Enter the quantity SupplyDesk will supply.");return}return reviewRequirement(id,"accept_partial",q)}

async function openBuyerRequirementAdmin(id,openSec){
  try{
    const enc=encodeURIComponent(id);
    const [all,q,au,ms]=await Promise.all([api("/api/admin/requirements"),api("/api/admin/procurement/queue"),api("/api/admin/audit?entity=rfq&id="+enc),api("/api/admin/requirements/"+enc+"/messages").catch(()=>({messages:[]}))]);
    reqCache=all.requirements||[];
    const r=reqCache.find(x=>x.id===id);if(!r)throw Error("Requirement not found.");
    const it=(q.items||[]).find(x=>x.id===id)||{rfq_state:r.rfq_state||"submitted",allowedNext:[]},st=it.rfq_state;
    const su=role()==="super_admin",priv=su?"":"Super Admin only",stLabel=q.states[st]||st;
    const day=v=>v?String(v).slice(0,10):"";
    const live=["pending_review","open","fulfilling"].includes(r.status);
    const reviewing=["submitted","matching"].includes(st)&&live;
    const facts=rqFact("Buyer",esc(r.buyer_name||""))+rqFact("Company",esc(r.buyer_company||priv))+rqFact("Contact",esc([r.buyer_email,r.buyer_phone].filter(Boolean).join(" · ")||priv))
      +rqFact("Category",esc([r.category,r.subcategory].filter(Boolean).join(" › ")||"Custom"))+rqFact("Quantity",esc(((r.quantity||"")+" "+(r.unit||"")).trim()))
      +rqFact("Target price",r.target_price!=null&&r.target_price!==""?esc(Number(r.target_price).toLocaleString("en-IN")+" "+(r.currency||"")):"")
      +rqFact("Delivery",esc([r.delivery_city,r.delivery_country].filter(Boolean).join(", ")))+rqFact("Required by",esc(day(r.required_by)))
      +(r.quality_standards?rqFact("Quality",esc(r.quality_standards)):"")+(r.certifications?rqFact("Certifications",esc(r.certifications)):"")+(r.packaging?rqFact("Packaging",esc(r.packaging)):"")
      +(r.payment_terms?rqFact("Payment terms",esc(r.payment_terms)):"")+(r.incoterm?rqFact("Delivery terms",esc(r.incoterm)):"");
    const head='<div class="rq-head"><div><h2>'+esc(r.title)+'</h2><div class="muted">'+(r.rfq_code?'RFQ '+esc(r.rfq_code)+' · ':"")+'Received '+esc(new Date(r.created_at).toLocaleDateString())+'</div></div><span class="pill rq-pill">'+esc(reviewing?"Needs review":stLabel)+'</span></div>'+assignBox("requirement",id)+discBox("requirement",id);
    const summary='<div class="rq-facts">'+facts+'</div>'+(r.description?'<div class="rq-desc">'+esc(r.description)+'</div>':"");
    const timeline=reqTimeline(r,au);
    if(reviewing){
      // Initial review shows ONLY: summary, decision, notes, timeline. No supplier selection at this stage.
      document.getElementById("detail").innerHTML=head+rqStepper(st)+'<h3 style="margin:14px 0 6px;font-size:14px">Requirement summary</h3>'+summary+decisionCard(id,r)+'<h3 style="margin:18px 0 4px;font-size:14px">Activity timeline</h3>'+tlHtml(timeline);
      return;
    }
    const accepted=r.accept_decision==="full"||r.accept_decision==="partial";
    const banner=accepted?'<div class="rq-next done"><div class="rq-next-h">'+(r.accept_decision==="partial"?"Accepted partially: "+esc(r.accepted_quantity)+" of "+esc(r.quantity):"Accepted in full")+'</div><div class="muted">SupplyDesk is the supplier for this requirement. Suppliers are chosen later in the Sourcing plan.</div></div>':"";
    let next="";
    if(st==="costing"){
      next='<div class="rq-next"><div class="rq-next-h">Next step · Send the quotation to the buyer</div>'+rqQuoteForm(id,Object.assign({},r,r.accept_decision==="partial"?{quantity:r.accepted_quantity}:{}))+'</div>';
    }else if(st==="quote_sent"){
      next='<div class="rq-next"><div class="rq-next-h">Quotation sent · waiting for the buyer</div><div class="muted">When the buyer accepts, the order and its SupplyDesk order are created automatically.</div><div class="actions">'+((it.allowedNext||[]).includes("costing")?'<button onclick="setRfqState(\''+esc(id)+'\',\'costing\')">Revise quotation</button>':"")+((it.allowedNext||[]).includes("lost")?'<button class="danger" onclick="setRfqState(\''+esc(id)+'\',\'lost\')">Mark as lost</button>':"")+'</div></div>';
    }else if(["sourcing","quotes_received"].includes(st)){
      const qd=await api("/api/admin/requirements/"+enc+"/quotes").catch(()=>({quotes:[]}));
      next='<div class="rq-next"><div class="rq-next-h">Supplier quotes ('+esc((qd.quotes||[]).length)+') · prepare the buyer quotation</div><div class="muted">This requirement was shared with suppliers before the new flow.</div><div class="actions"><button class="approve" onclick="setRfqState(\''+esc(id)+'\',\'costing\')">Prepare buyer quotation</button></div></div>';
    }else if(["buyer_approved","converted"].includes(st)){
      let sd=null;try{const o=await api("/api/admin/orders");sd=(o.orders||[]).find(x=>x.rfq_id===id)}catch{}
      next='<div class="rq-next done"><div class="rq-next-h">Order created</div><div class="muted">'+(sd&&sd.sd_order_id?'SupplyDesk order '+esc(sd.sd_number||"")+' is ready for sourcing.':'Review the buyer order under Orders.')+'</div><div class="actions">'+(sd&&sd.sd_order_id?'<button class="approve" onclick="loadSourcing().then(()=>openSourcingPlan(\''+esc(sd.sd_order_id)+'\'))">Open sourcing plan</button>':'<button class="approve" onclick="loadOrders()">Open Orders</button>')+'</div></div>';
    }else{
      next='<div class="rq-next done"><div class="rq-next-h">'+esc(stLabel)+'</div><div class="muted">No further action is needed on this requirement.</div></div>';
    }
    const thread=(ms.messages||[]).map(x=>'<div class="rq-msg"><b>'+esc(x.subject)+'</b>'+(x.body?'<div>'+esc(x.body)+'</div>':"")+'<small>'+esc(new Date(x.created_at).toLocaleString())+' · '+esc(x.created_by||"")+'</small></div>').join("");
    const msgHtml='<div class="muted" style="margin-bottom:6px">Sent by email and shown in the buyer dashboard.</div><input id="bmSubject" placeholder="Subject (optional)"><textarea id="bmText" placeholder="Write to the buyer..." style="min-height:60px;margin-top:6px"></textarea><div class="actions"><button class="primary" onclick="sendBuyerMessage(\''+esc(id)+'\')">Send message</button></div><div id="bmThread">'+(thread||'<div class="muted" style="margin-top:8px">No messages yet.</div>')+'</div>';
    const manual=(it.allowedNext||[]).length?'<div class="muted" style="margin-bottom:6px">Only use this to correct a status.</div><div class="actions">'+(it.allowedNext||[]).map(n=>'<button onclick="setRfqState(\''+esc(id)+'\',\''+esc(n)+'\')">'+esc(q.states[n]||n)+'</button>').join(" ")+'</div>':'<div class="muted">This is a final status.</div>';
    document.getElementById("detail").innerHTML=head+rqStepper(st)+banner+next+summary
      +rqSec("Messages with buyer",msgHtml,openSec==="messages",(ms.messages||[]).length)
      +rqSec("Activity timeline",tlHtml(timeline),false)
      +(it.allowedNext&&it.allowedNext.length?rqSec("Change status manually",manual,false):"");
  }catch(e){flowErr(e)}
}

// ---------- Sourcing: internal capacity allocation -> supplier POs ----------
async function ensureOrders(){if(!(ordData.orders||[]).length){const [d,s]=await Promise.all([api("/api/admin/orders"),api("/api/admin/sd-orders")]);ordData=d;sdList=s.sdOrders||[]}}
async function reloadOrders(){
  const [d,s]=await Promise.all([api("/api/admin/orders"),api("/api/admin/sd-orders")]);ordData=d;sdList=s.sdOrders||[];CUR.sd=sdList;
  if(CUR.screen==="orders")renderOrderList();else if(CUR.phase&&["production","qc","logistics","finance"].includes(CUR.screen))renderPhaseList();
}
const sdState=s=>s.needed>0&&s.allocated>=s.needed?"Planned":s.allocated>0?"Partly planned":"To plan";
function renderSourcingList(){
  const items=CUR.sd||[],f=CUR.srcFilter,needle=(CUR.q||"").trim().toLowerCase();
  const grp={plan:s=>s.needed>s.allocated,done:s=>!(s.needed>s.allocated),all:()=>true};
  const tabs=[["plan","To plan"],["done","Planned"],["all","All"]].map(([k,l])=>'<button class="rq-tab'+(f===k?" on":"")+'" onclick="CUR.srcFilter=\''+k+'\';renderSourcingList()">'+l+' <em>'+items.filter(grp[k]).length+'</em></button>').join("");
  const rows=items.filter(s=>grp[f](s)&&(!needle||(s.sd_number+" "+s.title).toLowerCase().includes(needle))).map(s=>'<div class="rq-row" onclick="openSourcingPlan(\''+esc(s.id)+'\')"><div class="rq-row-main"><div class="rq-row-t">'+esc(s.title)+'</div><div class="muted">'+esc(s.sd_number)+' · '+esc(s.buyer_orders)+' buyer order(s) · need '+fnum(s.needed)+' · allocated '+fnum(s.allocated)+'</div></div><div class="rq-row-s"><span class="rq-st rq-st-'+(s.needed>s.allocated?"action":"orders")+'">'+esc(sdState(s))+'</span><div class="muted">'+esc(s.live_pos)+' supplier PO(s)</div></div></div>').join("")||'<div class="muted" style="padding:14px 4px">Nothing here.</div>';
  document.getElementById("list").innerHTML='<div class="rq-listhead"><b>Sourcing plans</b></div><input class="rq-search" placeholder="Search SD number or product..." value="'+esc(CUR.q||"")+'" oninput="CUR.q=this.value;renderSourcingList()"><div class="rq-tabs">'+tabs+'</div>'+rows;
}
async function loadSourcing(){
  setTab("sourcing");CUR.screen="sourcing";
  if(needSignIn())return;
  try{const s=await api("/api/admin/sd-orders");CUR.sd=s.sdOrders||[];sdList=CUR.sd;
    if(CUR.srcFilter==="plan"&&!CUR.sd.some(x=>x.needed>x.allocated)&&CUR.sd.length)CUR.srcFilter="done";
    flowMsg("");renderSourcingList();
  }catch(e){flowErr(e)}
}
function openSdOrder(id){return loadSourcing().then(()=>openSourcingPlan(id))}
function spTotals(){
  const q=[...document.querySelectorAll(".sp-q")];let sum=0,bad=false;const reg={};
  q.forEach(i=>{const v=Number(i.value)||0,free=Number(i.dataset.free)||0;sum+=v;if(v>free||v<0)bad=true;reg[i.dataset.region]=(reg[i.dataset.region]||0)+v});
  document.querySelectorAll("[data-regtot]").forEach(e=>{e.textContent=fnum(reg[e.dataset.regtot]||0)});
  const un=Number((document.getElementById("spUn")||{}).dataset?.un||0),box=document.getElementById("spTot");if(!box)return;
  const over=sum>un;box.className="sp-tot "+(bad||over?"bad":sum===un&&un>0?"ok":"");
  const parts=Object.keys(reg).filter(k=>reg[k]).map(k=>esc(k)+' <b>'+fnum(reg[k])+'</b>').join(" · ");
  box.innerHTML='<span>'+(parts||'<span class="muted">Nothing allocated yet</span>')+'</span><span><b>Total = '+fnum(sum)+'</b> of '+fnum(un)+' needed'+(sum<un?' · short by '+fnum(un-sum):'')+(over?' · over by '+fnum(sum-un):'')+(bad?' · a line exceeds free capacity':'')+'</span>';
}
function spApply(lines){
  document.querySelectorAll(".sp-q").forEach(i=>{i.value=""});
  (lines||[]).forEach(l=>{const i=document.querySelector('.sp-q[data-code="'+l.capabilityCode+'"]');if(i&&!i.disabled)i.value=l.quantity;const c=document.querySelector('.sp-c[data-code="'+l.capabilityCode+'"]');if(c&&l.unitCost!=null)c.value=l.unitCost});
  spTotals();
}
function spCollect(){
  return [...document.querySelectorAll(".sp-q")].filter(i=>Number(i.value)>0).map(i=>{const c=document.querySelector('.sp-c[data-code="'+i.dataset.code+'"]');return {capabilityCode:i.dataset.code,quantity:Number(i.value),unitCost:c&&c.value!==""?Number(c.value):null}});
}
async function spSaveDraft(id){
  const lines=spCollect();
  try{const d=await api("/api/admin/sd-orders/"+encodeURIComponent(id)+"/sourcing-plan",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({lines})});flowMsg("Draft saved ("+fnum(d.allocated)+" allocated). No supplier has been contacted.")}
  catch(e){flowErr(e)}
}
async function spConfirm(id,allowShortfall){
  const lines=spCollect();
  if(!lines.length){flowMsg("Allocate quantity to at least one supplier first.");return}
  if(lines.some(l=>l.unitCost==null||!(l.unitCost>0))){flowMsg("Enter the unit cost for every allocated supplier.");return}
  if(!allowShortfall&&!confirm("Confirm this allocation and issue "+lines.length+" supplier PO(s)? Suppliers will be emailed. The customer on each PO is SUPPLYDESK; no buyer details are sent."))return;
  const g=x=>(document.getElementById(x)||{value:""}).value.trim();
  try{
    await api("/api/admin/sd-orders/"+encodeURIComponent(id)+"/sourcing-plan/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lines,currency:g("spCur")||"INR",deliveryBy:g("spDate"),terms:g("spTerms"),allowShortfall:!!allowShortfall})});
    await loadSourcing();await openSourcingPlan(id);flowMsg("Allocation confirmed. Supplier PO(s) issued to suppliers with SupplyDesk as the customer.");
  }catch(e){
    if(/covers .* of/.test(e.message||"")&&!allowShortfall){if(confirm(e.message+"\n\nIssue the POs for the quantity allocated so far?"))return spConfirm(id,true);return}
    flowErr(e);
  }
}
async function spCancelPo(poId,sdId){
  const note=prompt("Reason (shown to supplier, optional):","");if(note===null)return;
  try{await api("/api/admin/supplier-pos/"+encodeURIComponent(poId)+"/cancel",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({note})});await loadSourcing();await openSourcingPlan(sdId);flowMsg("Supplier PO cancelled. Its quantity is back in the plan.")}catch(e){flowErr(e)}
}
async function spAddOrder(sdId){
  const v=(document.getElementById("sdAddSel")||{}).value;if(!v)return;
  try{await api("/api/admin/sd-orders/"+encodeURIComponent(sdId)+"/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({buyerOrderIds:[v]})});await loadSourcing();await openSourcingPlan(sdId)}catch(e){flowErr(e)}
}
async function openSourcingPlan(id){
  try{
    if(CUR.screen!=="sourcing")await loadSourcing();
    const enc=encodeURIComponent(id);
    const [plan,sd,al,ords]=await Promise.all([api("/api/admin/sd-orders/"+enc+"/sourcing-plan"),api("/api/admin/sd-orders/"+enc),api("/api/admin/sd-orders/"+enc+"/allocation"),api("/api/admin/orders")]);
    ordData=ords;
    const o=plan.sdOrder,un=plan.unallocated,pct=plan.totalRequirement?Math.min(100,Math.round(plan.allocated/plan.totalRequirement*100)):0;
    const head='<div class="rq-head"><div><h2>'+esc(o.title)+'</h2><div class="muted">'+esc(o.sdNumber)+' · SupplyDesk order · '+plan.orders.length+' buyer order(s)</div></div><span class="rq-pill">'+esc(un>0?(plan.allocated>0?"Partly planned":"To plan"):"Planned")+'</span></div>'+assignBox("sd_order",id)+discBox("sd_order",id);
    const sum='<div class="sp-sum"><div><small>Total requirement</small><b>'+fnum(plan.totalRequirement)+'</b></div><div><small>On supplier POs</small><b>'+fnum(plan.allocated)+'</b></div><div><small>Still to allocate</small><b>'+fnum(un)+'</b></div></div><div class="sp-bar"><i style="width:'+pct+'%"></i></div>';
    const bo='<div class="nt-wrap"><table class="nt-t"><tr><th>Buyer PO</th><th class="n">Needed</th><th class="n">Allocated</th><th class="n">Remaining</th><th>Stage</th></tr>'+plan.orders.map(i=>'<tr><td><a href="#" onclick="openOrderAdmin(\''+esc(i.buyerOrderId)+'\');return false"><b>'+esc(i.poNumber)+'</b></a>'+(i.partial?' <span class="muted">(partial)</span>':'')+'</td><td class="n">'+fnum(i.needed)+'</td><td class="n">'+fnum(i.allocated)+'</td><td class="n">'+fnum(i.remaining)+'</td><td>'+esc(i.stageLabel)+'</td></tr>').join("")+'</table></div>';
    let editor="";
    if(un>0){
      const draftBy=new Map((plan.draft||[]).map(l=>[l.capabilityCode,l]));
      const start=plan.draft&&plan.draft.length?plan.draft:plan.recommended;
      const regions=[];const byR={};
      plan.candidates.forEach(c=>{if(!byR[c.region]){byR[c.region]=[];regions.push(c.region)}byR[c.region].push(c)});
      const body=regions.map(rg=>'<div class="sp-reg"><div class="sp-reg-h"><span>'+esc(rg)+'</span><span data-regtot="'+esc(rg)+'">0</span></div>'
        +byR[rg].map(c=>'<div class="sp-row"><div><b>'+esc(c.supplier)+'</b><div class="sp-why">'+esc(c.productName)+' · '+esc(c.capabilityCode)+(c.reasons&&c.reasons[0]?' · '+esc(c.reasons.slice(0,2).join("; ")):'')+'</div></div><div data-l="Free capacity">'+fnum(c.freeCapacity)+' <span class="muted">'+esc(c.unit||"")+'</span></div><div data-l="Lead time">'+(c.leadTimeDays==null?"-":esc(c.leadTimeDays)+"d")+'</div><div data-l="Allocate"><input class="sp-q" type="number" min="0" step="1" max="'+esc(c.freeCapacity)+'" data-code="'+esc(c.capabilityCode)+'" data-region="'+esc(rg)+'" data-free="'+esc(c.freeCapacity)+'" oninput="spTotals()"'+(c.hasLivePo?' disabled title="This supplier already has a PO on this order"':'')+'></div><div data-l="Unit cost"><input class="sp-c" type="number" min="0" step="0.0001" data-code="'+esc(c.capabilityCode)+'" placeholder="per unit"'+(c.hasLivePo?' disabled':'')+'></div></div>').join("")+'</div>').join("");
      editor='<h3 style="margin:18px 0 4px;font-size:15px">Internal capacity allocation</h3><div class="sp-note">Eligible capacity only: approved supplier, approved product, verified capacity updated in the last 45 days. Free capacity = available − allocated − committed.'+(plan.detailsRestricted?' Supplier names are hidden for your role.':'')+'</div>'
        +(plan.candidates.length?'<div id="spUn" data-un="'+esc(un)+'"></div>'+body+'<div class="sp-tot" id="spTot"></div>'
          +'<div class="actions"><button onclick="spApply(window.__recommended)">Use recommended allocation</button><button onclick="spApply([])">Clear</button><button onclick="spSaveDraft(\''+esc(id)+'\')">Save draft</button></div>'
          +(plan.recommendedShortfall>0?'<div class="sp-note nt-warn">Eligible capacity is '+fnum(plan.recommendedShortfall)+' short of the requirement.</div>':'')
          +'<details style="margin:10px 0"><summary class="sp-note" style="cursor:pointer;font-weight:800">PO terms (optional)</summary><div class="rq-grid"><label>Currency<select id="spCur"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option><option>AED</option></select></label><label>Deliver by<input id="spDate" type="date"></label></div><label class="rq-wide">Terms (payment, packing, delivery)<textarea id="spTerms" style="min-height:48px"></textarea></label></details>'
          +'<div class="actions"><button class="primary" id="spConfirmBtn" onclick="spConfirm(\''+esc(id)+'\')">Confirm allocation &amp; issue Supplier POs</button></div><div class="sp-note"><span class="sp-lock">Customer = SUPPLYDESK</span> Suppliers never receive the buyer name, buyer PO, contact, target price or internal notes.</div>'
          :'<div class="rq-next"><div class="rq-next-h">No eligible capacity found</div><div class="muted">No verified, fresh capacity matches this requirement. Check Supplier network › Capacity, or ask suppliers to update their capacity.</div></div>');
      window.__recommended=plan.recommended;window.__start=start;window.__draftBy=draftBy;
    }
    const pos=(sd.supplierPos||[]).map(p=>'<div class="rq-q"><b>'+esc(p.po_number)+'</b> · '+esc(p.trade_name||p.legal_name||"")+' · '+esc(p.quantity)+' @ '+esc(p.unit_cost)+' '+esc(p.currency)+' · '+esc(p.statusLabel||p.status)+(p.accepted_quantity?' ('+esc(p.accepted_quantity)+' accepted)':'')+'<div class="muted">Customer on PO: SUPPLYDESK · covers '+p.lines.map(l=>esc(l.buyerPo)+' × '+fnum(l.quantity)).join(" · ")+'</div>'+(["issued","accepted","partially_accepted","in_production","ready_for_qc","ready_for_dispatch"].includes(p.status)?'<div class="actions"><button onclick="spCancelPo(\''+esc(p.id)+'\',\''+esc(id)+'\')">Cancel this PO</button></div>':'')+'</div>').join("");
    const regHtml=al.regions.length?al.regions.map(r=>'<div class="rq-q"><b>'+esc(r.region)+'</b> <span class="muted">'+fnum(r.total)+'</span>'+r.suppliers.map(s=>'<div>'+esc(s.supplier)+': '+fnum(s.quantity)+' <span class="muted">'+esc(s.poNumber)+' · '+esc(s.statusLabel)+'</span></div>').join("")+'</div>').join("")+'<div><b>Total = '+fnum(al.allocated)+'</b> of '+fnum(al.totalRequirement)+'</div>':"";
    const spare=(ords.orders||[]).filter(x=>["accepted","partially_accepted"].includes(x.review_status)&&x.status!=="cancelled"&&!x.sd_order_id);
    const merge=spare.length?'<div class="rq-grid"><label>Add another accepted buyer order<select id="sdAddSel"><option value="">Choose…</option>'+spare.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.po_number+" · "+x.title+" · "+x.quantity)+'</option>').join("")+'</select></label></div><div class="actions"><button onclick="spAddOrder(\''+esc(id)+'\')">Add to this SupplyDesk order</button></div>':"";
    document.getElementById("detail").innerHTML=head+sum+bo+editor
      +(pos?rqSec("Supplier POs",pos,true,sd.supplierPos.length)+rqSec("Allocation by region (SupplyDesk only)",regHtml,false,null):"")
      +(merge?rqSec("Combine with another buyer order",merge,false,null):"");
    if(un>0&&plan.candidates.length){spApply(window.__start||[]);}
    document.getElementById("detail").scrollIntoView({behavior:"smooth",block:"start"});
  }catch(e){flowErr(e)}
}

// ---------- Production / QC / Logistics / Finance: the same orders, filtered by what needs doing ----------
const PHASES={
  production:{title:"Production",help:"Orders with supplier POs. Production progress comes from the supplier and moves the buyer timeline by itself.",stages:["supplydesk_accepted","production_confirmed","in_production"],needAlloc:true},
  qc:{title:"QC",help:"Production is complete. Record the QC result to release the order to transport.",stages:["production_completed"]},
  logistics:{title:"Logistics",help:"Transport, insurance, transit and delivery. Each step tells the buyer.",stages:["qc_completed","ready_for_transport","transport_booked","insurance_completed","in_transit","out_for_delivery","delivered"]},
  finance:{title:"Finance",help:"Invoices and payments for accepted orders.",stages:null}
};
const phaseRows=(name)=>{const ph=PHASES[name];return (ordData.orders||[]).filter(o=>["accepted","partially_accepted"].includes(o.review_status)&&o.status!=="cancelled"&&(!ph.stages||ph.stages.includes(o.stage||"supplydesk_accepted"))&&(!ph.needAlloc||Number(o.allocated)>0))};
function renderPhaseList(){
  const name=CUR.phase,ph=PHASES[name],needle=(CUR.q||"").trim().toLowerCase();
  const rows=phaseRows(name).filter(o=>!needle||(o.po_number+" "+o.title+" "+(o.sd_number||"")).toLowerCase().includes(needle));
  const su=role()==="super_admin";
  const html=rows.map(o=>{
    const nx=name==="finance"?(o.total_price?fnum(o.total_price)+" "+esc(o.currency):"-"):(o.nextBlocked?'<span class="muted">Waiting</span>':o.nextStageLabel?'Next: '+esc(o.nextStageLabel):'<span class="muted">Complete</span>');
    return '<div class="rq-row" onclick="'+(name==="finance"?"openInvoice":"openOrderAdmin")+'(\''+esc(o.id)+'\')"><div class="rq-row-main"><div class="rq-row-t">'+esc(o.po_number)+' · '+esc(o.title)+'</div><div class="muted">'+esc(o.buyer_name||"")+' · '+esc(o.quantity)+(o.sd_number?' · '+esc(o.sd_number):'')+'</div></div><div class="rq-row-s"><span class="rq-st rq-st-waiting">'+esc(o.stageLabel)+'</span><div class="muted">'+nx+'</div></div></div>';
  }).join("")||'<div class="muted" style="padding:14px 4px">Nothing in '+esc(ph.title)+' right now.</div>';
  document.getElementById("list").innerHTML='<div class="rq-listhead"><b>'+esc(ph.title)+' ('+rows.length+')</b>'+(name==="finance"&&su?'<button onclick="loadMarginReport()">Margin report</button>':'')+'</div><input class="rq-search" placeholder="Search PO, SD no or product..." value="'+esc(CUR.q||"")+'" oninput="CUR.q=this.value;renderPhaseList()">'+html;
}
async function loadPhase(name){
  setTab(name);CUR.screen=name;CUR.phase=name;CUR.q="";
  if(needSignIn())return;
  try{const [d,s]=await Promise.all([api("/api/admin/orders"),api("/api/admin/sd-orders")]);ordData=d;sdList=s.sdOrders||[];
    document.getElementById("detail").innerHTML="<h2>"+esc(PHASES[name].title)+"</h2><div class='muted'>"+esc(PHASES[name].help)+"</div>";
    flowMsg("");renderPhaseList();
  }catch(e){flowErr(e)}
}

// ---------- Supplier network: capabilities, capacity, agreements ----------
async function loadNetwork(kind){
  setTab(kind);CUR.screen=kind;
  if(needSignIn())return;
  try{
    if(kind==="agreements"){
      const d=await api("/api/admin/agreements");
      document.getElementById("detail").innerHTML='<h2>Agreements</h2><div class="muted">A supplier is eligible for live orders only after the SupplyDesk agreement is signed and every verification step is complete. Sign-off happens in Verification.</div><div class="nt-wrap" style="margin-top:12px"><table class="nt-t"><tr><th>Supplier</th><th>Verification state</th><th>Agreement</th><th>Live orders</th></tr>'+d.items.map(i=>'<tr><td><b>'+esc(i.supplier)+'</b></td><td>'+esc((typeof ONB_LABEL!=="undefined"?ONB_LABEL:{})[i.onboardingStatus]||i.onboardingStatus)+'</td><td>'+(i.agreementSignedAt?'<span class="nt-ok">Signed '+esc(String(i.agreementSignedAt).slice(0,10))+'</span>':'<span class="nt-warn">Not signed</span>')+'</td><td>'+(i.eligible?'<span class="nt-ok">Eligible</span>':'<span class="muted">Not eligible</span>')+'</td></tr>').join("")+'</table></div><div class="actions"><button onclick="loadApps()">Open Verification</button></div>';
      return flowMsg("");
    }
    const d=await api("/api/admin/capacity");CUR.net=d.items||[];renderNetwork(kind);flowMsg("");
  }catch(e){flowErr(e)}
}
function renderNetwork(kind){
  const items=CUR.net;
  if(kind==="capabilities"){
    const by={};items.forEach(i=>{const k=(i.category||"Other")+(i.subcategory?" › "+i.subcategory:"");(by[k]=by[k]||[]).push(i)});
    document.getElementById("detail").innerHTML='<h2>Capabilities</h2><div class="muted">What the supplier network can make. Buyers never see this view; the public site shows only combined SupplyDesk capability.</div>'
      +Object.keys(by).sort().map(k=>{const eligible=by[k].filter(i=>i.eligible&&i.productVerified&&i.capacityVerified&&!i.stale);return '<div class="pl-card" style="margin-top:12px"><h3>'+esc(k)+' <small class="muted">· '+eligible.length+' of '+by[k].length+' eligible · free '+fnum(eligible.reduce((t,i)=>t+i.free,0))+'</small></h3><div class="nt-wrap"><table class="nt-t"><tr><th>Capability ID</th><th>Product</th><th>Supplier</th><th>Region</th><th>Product</th><th>Capacity</th><th>Live orders</th></tr>'+by[k].map(i=>'<tr><td><b>'+esc(i.capabilityCode||"-")+'</b></td><td>'+esc(i.product)+'</td><td>'+esc(i.supplier)+'</td><td>'+esc(i.region)+'</td><td>'+(i.productVerified?'<span class="nt-ok">✓</span>':'<span class="nt-warn">Pending</span>')+'</td><td>'+(i.capacityVerified?(i.stale?'<span class="nt-warn">Stale</span>':'<span class="nt-ok">✓</span>'):'<span class="nt-warn">Unverified</span>')+'</td><td>'+(i.eligible?'<span class="nt-ok">Eligible</span>':'<span class="muted">No</span>')+'</td></tr>').join("")+'</table></div></div>'}).join("")||'<div class="pl-card" style="margin-top:12px"><div class="muted">No capabilities yet.</div></div>';
    return;
  }
  document.getElementById("detail").innerHTML='<h2>Capacity</h2><div class="muted">Installed, available, allocated (PO issued), committed (supplier accepted) and free capacity. Only verified capacity updated in the last 45 days is used for sourcing and public totals.</div><div class="nt-wrap" style="margin-top:12px"><table class="nt-t"><tr><th>Capability</th><th>Supplier</th><th>Region</th><th class="n">Installed</th><th class="n">Available</th><th class="n">Allocated</th><th class="n">Committed</th><th class="n">Free</th><th>Updated</th><th>Verification</th></tr>'
    +items.map(i=>'<tr><td><b>'+esc(i.capabilityCode||"-")+'</b><div class="muted">'+esc(i.product)+'</div></td><td>'+esc(i.supplier)+(i.eligible?'':' <span class="muted">(not eligible)</span>')+'</td><td>'+esc(i.region)+'</td><td class="n">'+fnum(i.installed)+'</td><td class="n">'+fnum(i.available)+'</td><td class="n">'+fnum(i.allocated)+'</td><td class="n">'+fnum(i.committed)+'</td><td class="n"><b>'+fnum(i.free)+'</b></td><td>'+(i.updatedAt?esc(String(i.updatedAt).slice(0,10)):'-')+(i.stale?' <span class="nt-warn">stale</span>':'')+'</td><td>'+(!i.productVerified?'<span class="muted">Approve product first</span>':i.capacityVerified?'<span class="nt-ok">✓ Verified</span> <button onclick="verifyCapacity(\''+esc(i.id)+'\',false)">Revoke</button>':'<button class="approve" onclick="verifyCapacity(\''+esc(i.id)+'\',true)">Verify capacity</button>')+'</td></tr>').join("")
    +'</table></div>';
}
