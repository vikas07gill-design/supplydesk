"use strict";
/**
 * Single source of truth for SupplyDesk categories / sub-categories.
 * Used by the server (validation, /api/categories) and by every page via /assets/taxonomy.js.
 * To add or rename a category, edit ONLY this file (and add a LEGACY entry if old data must move).
 */
const PRODUCTS = {
  "Electrical & Electronics": ["Switchgear","Panels","Transformers","Motors","Electrical Components","Cables & Wires","Lighting","Other"],
  "Electronic Components": ["PCB","ICs","Sensors","Connectors","Displays","Modules","Passive Components","Other"],
  "Machinery & Industrial Equipment": ["CNC Machines","Lathe Machines","Milling Machines","Cutting Machines","Press Machines","SPM (Special Purpose Machines)","Injection Moulding Machines","Packaging Machines","Other"],
  "Automation & Robotics": ["PLC","HMI","SCADA","VFD","Servo Systems","Robots","Other"],
  "Automotive & Auto Components": ["Engine Parts","Brake Systems","Suspension","Steering","Filters","Auto Electrical","Accessories","Other"],
  "EV & Electric Mobility": ["EV Motors","Batteries","BMS","Chargers","Controllers","EV Parts","Other"],
  "Plastics & Polymers": ["Granules","Masterbatch","Sheets","Films","Containers","Moulded Parts","Other"],
  "Rubber Products": ["Seals","O-Rings","Gaskets","Hoses","Profiles","Rubber Components","Other"],
  "Chemicals": ["Industrial Chemicals","Specialty Chemicals","Solvents","Resins","Adhesives","Additives","Cleaning Chemicals","Other"],
  "Metals & Alloys": ["Steel","Stainless Steel","Aluminium","Copper","Brass","Sheets & Plates","Bars & Rods","Other"],
  "Fabrication & Sheet Metal": ["Laser Cutting","CNC Bending","Welding","Enclosures","Frames & Structures","Other"],
  "Moulds, Dies & Tooling": ["Injection Moulds","Dies","Jigs & Fixtures","CNC Tooling","Other"],
  "Packaging & Printing": ["Boxes & Cartons","Pouches","Bottles","Labels","Printing Services","Packaging Film","Other"],
  "Construction & Building Materials": ["Cement","Tiles","Marble","Granite","Plywood","Roofing","Other"],
  "Pipes, Tubes & Valves": ["PVC Pipes","HDPE Pipes","GI Pipes","SS Pipes","Fittings","Valves","Flanges","Other"],
  "Pumps, Hydraulics & Pneumatics": ["Pumps","Hydraulic Cylinders","Valves","Compressors","Hoses & Fittings","Other"],
  "Agriculture & Farm Equipment": ["Tractors","Tillers","Sprayers","Irrigation","Harvesters","Other"],
  "Food & Beverage": ["Grains","Spices","Oils","Snacks","Beverages","Food Ingredients","Other"],
  "Food Processing Machinery": ["Flour Milling","Spice Processing","Bakery Equipment","Dairy Equipment","Filling Machines","Processing Lines","Other"],
  "Textile & Apparel": ["Fabrics","Yarn","Garments","Technical Textiles","Textile Machinery","Home Textiles","Other"],
  "Home Appliances": ["Mixer Grinders","Choppers","Juicers","Fans","Kettles","Air Fryers","Other"],
  "Consumer Electronics": ["TVs","Speakers","Headphones","Cameras","Smart Devices","Other"],
  "Renewable Energy": ["Solar Panels","Wind Energy","Energy Storage","Solar Equipment","Other"],
  "Batteries & Power Solutions": ["Lead Acid Batteries","Lithium Batteries","UPS","Inverters","Chargers","Other"],
  "Medical & Healthcare": ["Hospital Equipment","Diagnostic Equipment","Surgical Instruments","Dental","Medical Electronics","Other"],
  "Laboratory & Testing": ["Testing Machines","Instruments","Calibration","Lab Equipment","Other"],
  "Safety & Security": ["PPE","Fire Safety","CCTV","Access Control","Security Systems","Other"],
  "Material Handling": ["Cranes","Hoists","Conveyors","Forklifts","Warehouse Equipment","Other"],
  "Tools & Industrial Supplies": ["Hand Tools","Power Tools","Bearings","Seals","Belts","Fasteners","Consumables","Other"],
  "IT, Telecom & Services": ["Computers","Networking","Telecom","Software","Manufacturing Services","Other"]
};

// Trade / business services (unchanged from the previous catalogue).
const SERVICES = {
  "Logistics & Freight": ["Sea Freight","Air Freight","Road Transport","Freight Forwarding"],
  "Warehousing & Fulfilment": ["Warehousing","Consolidation","Fulfilment"],
  "Customs & Trade": ["Customs Clearance","Trade Documentation","Import Export Support"],
  "Inspection & Verification": ["Factory Inspection","Pre-shipment Inspection","Quality Inspection"],
  "Insurance": ["Cargo Insurance","Transit Insurance","Trade Insurance"],
  "Trade Finance": ["Trade Finance","Letter of Credit","Working Capital"],
  "Sourcing Services": ["Product Sourcing","Supplier Discovery","Procurement Support"],
  "Professional Services": ["Consulting","Accounting & Tax","Legal Services"]
};

const catalog = Object.assign({}, PRODUCTS, SERVICES);
const groups = { Products: Object.keys(PRODUCTS), Services: Object.keys(SERVICES) };

/** Everyday words buyers type -> [category, optional sub-category]. Used by the Industries & Countries search. */
const aliases = {
  electrical:["Electrical & Electronics"], electric:["Electrical & Electronics"], switchgear:["Electrical & Electronics","Switchgear"], panel:["Electrical & Electronics","Panels"], panels:["Electrical & Electronics","Panels"],
  transformer:["Electrical & Electronics","Transformers"], transformers:["Electrical & Electronics","Transformers"], motor:["Electrical & Electronics","Motors"], motors:["Electrical & Electronics","Motors"], cable:["Electrical & Electronics","Cables & Wires"], cables:["Electrical & Electronics","Cables & Wires"], wire:["Electrical & Electronics","Cables & Wires"], wires:["Electrical & Electronics","Cables & Wires"], lighting:["Electrical & Electronics","Lighting"], led:["Electrical & Electronics","Lighting"],
  electronics:["Electronic Components"], electronic:["Electronic Components"], pcb:["Electronic Components","PCB"], ic:["Electronic Components","ICs"], ics:["Electronic Components","ICs"], semiconductor:["Electronic Components","ICs"], sensor:["Electronic Components","Sensors"], sensors:["Electronic Components","Sensors"], connector:["Electronic Components","Connectors"], connectors:["Electronic Components","Connectors"], display:["Electronic Components","Displays"], displays:["Electronic Components","Displays"], module:["Electronic Components","Modules"], modules:["Electronic Components","Modules"],
  machine:["Machinery & Industrial Equipment"], machines:["Machinery & Industrial Equipment"], machinery:["Machinery & Industrial Equipment"], equipment:["Machinery & Industrial Equipment"], cnc:["Machinery & Industrial Equipment","CNC Machines"], lathe:["Machinery & Industrial Equipment","Lathe Machines"], milling:["Machinery & Industrial Equipment","Milling Machines"], press:["Machinery & Industrial Equipment","Press Machines"], spm:["Machinery & Industrial Equipment","SPM (Special Purpose Machines)"], moulding:["Machinery & Industrial Equipment","Injection Moulding Machines"], molding:["Machinery & Industrial Equipment","Injection Moulding Machines"],
  automation:["Automation & Robotics"], robot:["Automation & Robotics","Robots"], robots:["Automation & Robotics","Robots"], robotics:["Automation & Robotics"], plc:["Automation & Robotics","PLC"], hmi:["Automation & Robotics","HMI"], scada:["Automation & Robotics","SCADA"], vfd:["Automation & Robotics","VFD"], servo:["Automation & Robotics","Servo Systems"],
  automotive:["Automotive & Auto Components"], auto:["Automotive & Auto Components"], car:["Automotive & Auto Components"], cars:["Automotive & Auto Components"], automobile:["Automotive & Auto Components"], spare:["Automotive & Auto Components"], brake:["Automotive & Auto Components","Brake Systems"], brakes:["Automotive & Auto Components","Brake Systems"], suspension:["Automotive & Auto Components","Suspension"], steering:["Automotive & Auto Components","Steering"], filter:["Automotive & Auto Components","Filters"], filters:["Automotive & Auto Components","Filters"],
  ev:["EV & Electric Mobility"], "electric vehicle":["EV & Electric Mobility"], "electric vehicles":["EV & Electric Mobility"], bms:["EV & Electric Mobility","BMS"], mobility:["EV & Electric Mobility"],
  plastic:["Plastics & Polymers"], plastics:["Plastics & Polymers"], polymer:["Plastics & Polymers"], polymers:["Plastics & Polymers"], granules:["Plastics & Polymers","Granules"], masterbatch:["Plastics & Polymers","Masterbatch"], container:["Plastics & Polymers","Containers"], containers:["Plastics & Polymers","Containers"],
  rubber:["Rubber Products"], seal:["Rubber Products","Seals"], seals:["Rubber Products","Seals"], oring:["Rubber Products","O-Rings"], orings:["Rubber Products","O-Rings"], gasket:["Rubber Products","Gaskets"], gaskets:["Rubber Products","Gaskets"], hose:["Rubber Products","Hoses"], hoses:["Rubber Products","Hoses"],
  chemical:["Chemicals"], chemicals:["Chemicals"], solvent:["Chemicals","Solvents"], solvents:["Chemicals","Solvents"], resin:["Chemicals","Resins"], resins:["Chemicals","Resins"], adhesive:["Chemicals","Adhesives"], adhesives:["Chemicals","Adhesives"], additive:["Chemicals","Additives"], additives:["Chemicals","Additives"],
  metal:["Metals & Alloys"], metals:["Metals & Alloys"], alloy:["Metals & Alloys"], alloys:["Metals & Alloys"], steel:["Metals & Alloys","Steel"], "stainless steel":["Metals & Alloys","Stainless Steel"], ss:["Metals & Alloys","Stainless Steel"], aluminium:["Metals & Alloys","Aluminium"], aluminum:["Metals & Alloys","Aluminium"], copper:["Metals & Alloys","Copper"], brass:["Metals & Alloys","Brass"],
  fabrication:["Fabrication & Sheet Metal"], "sheet metal":["Fabrication & Sheet Metal"], welding:["Fabrication & Sheet Metal","Welding"], laser:["Fabrication & Sheet Metal","Laser Cutting"], enclosure:["Fabrication & Sheet Metal","Enclosures"], enclosures:["Fabrication & Sheet Metal","Enclosures"],
  mould:["Moulds, Dies & Tooling"], moulds:["Moulds, Dies & Tooling"], mold:["Moulds, Dies & Tooling"], molds:["Moulds, Dies & Tooling"], die:["Moulds, Dies & Tooling","Dies"], dies:["Moulds, Dies & Tooling","Dies"], tooling:["Moulds, Dies & Tooling"], jig:["Moulds, Dies & Tooling","Jigs & Fixtures"], jigs:["Moulds, Dies & Tooling","Jigs & Fixtures"], fixture:["Moulds, Dies & Tooling","Jigs & Fixtures"], fixtures:["Moulds, Dies & Tooling","Jigs & Fixtures"],
  packaging:["Packaging & Printing"], packing:["Packaging & Printing"], printing:["Packaging & Printing","Printing Services"], label:["Packaging & Printing","Labels"], labels:["Packaging & Printing","Labels"], box:["Packaging & Printing","Boxes & Cartons"], boxes:["Packaging & Printing","Boxes & Cartons"], carton:["Packaging & Printing","Boxes & Cartons"], pouch:["Packaging & Printing","Pouches"], pouches:["Packaging & Printing","Pouches"], bottle:["Packaging & Printing","Bottles"], bottles:["Packaging & Printing","Bottles"],
  construction:["Construction & Building Materials"], building:["Construction & Building Materials"], cement:["Construction & Building Materials","Cement"], tiles:["Construction & Building Materials","Tiles"], tile:["Construction & Building Materials","Tiles"], marble:["Construction & Building Materials","Marble"], granite:["Construction & Building Materials","Granite"], plywood:["Construction & Building Materials","Plywood"], roofing:["Construction & Building Materials","Roofing"],
  pipe:["Pipes, Tubes & Valves"], pipes:["Pipes, Tubes & Valves"], tube:["Pipes, Tubes & Valves"], tubes:["Pipes, Tubes & Valves"], pvc:["Pipes, Tubes & Valves","PVC Pipes"], hdpe:["Pipes, Tubes & Valves","HDPE Pipes"], valve:["Pipes, Tubes & Valves","Valves"], valves:["Pipes, Tubes & Valves","Valves"], flange:["Pipes, Tubes & Valves","Flanges"], flanges:["Pipes, Tubes & Valves","Flanges"], fittings:["Pipes, Tubes & Valves","Fittings"], plumbing:["Pipes, Tubes & Valves","Fittings"],
  pump:["Pumps, Hydraulics & Pneumatics","Pumps"], pumps:["Pumps, Hydraulics & Pneumatics","Pumps"], hydraulic:["Pumps, Hydraulics & Pneumatics"], hydraulics:["Pumps, Hydraulics & Pneumatics"], pneumatic:["Pumps, Hydraulics & Pneumatics"], pneumatics:["Pumps, Hydraulics & Pneumatics"], compressor:["Pumps, Hydraulics & Pneumatics","Compressors"], compressors:["Pumps, Hydraulics & Pneumatics","Compressors"],
  agriculture:["Agriculture & Farm Equipment"], farm:["Agriculture & Farm Equipment"], farming:["Agriculture & Farm Equipment"], tractor:["Agriculture & Farm Equipment","Tractors"], tractors:["Agriculture & Farm Equipment","Tractors"], sprayer:["Agriculture & Farm Equipment","Sprayers"], sprayers:["Agriculture & Farm Equipment","Sprayers"], irrigation:["Agriculture & Farm Equipment","Irrigation"], harvester:["Agriculture & Farm Equipment","Harvesters"], harvesters:["Agriculture & Farm Equipment","Harvesters"],
  food:["Food & Beverage"], beverage:["Food & Beverage","Beverages"], beverages:["Food & Beverage","Beverages"], grains:["Food & Beverage","Grains"], rice:["Food & Beverage","Grains"], wheat:["Food & Beverage","Grains"], spices:["Food & Beverage","Spices"], spice:["Food & Beverage","Spices"], oil:["Food & Beverage","Oils"], oils:["Food & Beverage","Oils"], snacks:["Food & Beverage","Snacks"],
  "food processing":["Food Processing Machinery"], bakery:["Food Processing Machinery","Bakery Equipment"], dairy:["Food Processing Machinery","Dairy Equipment"], flour:["Food Processing Machinery","Flour Milling"], filling:["Food Processing Machinery","Filling Machines"],
  textile:["Textile & Apparel"], textiles:["Textile & Apparel"], apparel:["Textile & Apparel"], garment:["Textile & Apparel","Garments"], garments:["Textile & Apparel","Garments"], clothing:["Textile & Apparel","Garments"], fabric:["Textile & Apparel","Fabrics"], fabrics:["Textile & Apparel","Fabrics"], yarn:["Textile & Apparel","Yarn"],
  appliance:["Home Appliances"], appliances:["Home Appliances"], mixer:["Home Appliances","Mixer Grinders"], grinder:["Home Appliances","Mixer Grinders"], juicer:["Home Appliances","Juicers"], fan:["Home Appliances","Fans"], fans:["Home Appliances","Fans"], kettle:["Home Appliances","Kettles"], "air fryer":["Home Appliances","Air Fryers"], household:["Home Appliances"], kitchen:["Home Appliances"],
  tv:["Consumer Electronics","TVs"], tvs:["Consumer Electronics","TVs"], speaker:["Consumer Electronics","Speakers"], speakers:["Consumer Electronics","Speakers"], headphone:["Consumer Electronics","Headphones"], headphones:["Consumer Electronics","Headphones"], camera:["Consumer Electronics","Cameras"], cameras:["Consumer Electronics","Cameras"],
  solar:["Renewable Energy"], wind:["Renewable Energy","Wind Energy"], renewable:["Renewable Energy"], "energy storage":["Renewable Energy","Energy Storage"],
  battery:["Batteries & Power Solutions"], batteries:["Batteries & Power Solutions"], lithium:["Batteries & Power Solutions","Lithium Batteries"], ups:["Batteries & Power Solutions","UPS"], inverter:["Batteries & Power Solutions","Inverters"], inverters:["Batteries & Power Solutions","Inverters"],
  medical:["Medical & Healthcare"], healthcare:["Medical & Healthcare"], hospital:["Medical & Healthcare","Hospital Equipment"], diagnostic:["Medical & Healthcare","Diagnostic Equipment"], surgical:["Medical & Healthcare","Surgical Instruments"], dental:["Medical & Healthcare","Dental"],
  laboratory:["Laboratory & Testing"], lab:["Laboratory & Testing"], testing:["Laboratory & Testing"], calibration:["Laboratory & Testing","Calibration"], instruments:["Laboratory & Testing","Instruments"],
  safety:["Safety & Security"], security:["Safety & Security"], ppe:["Safety & Security","PPE"], cctv:["Safety & Security","CCTV"], fire:["Safety & Security","Fire Safety"],
  crane:["Material Handling","Cranes"], cranes:["Material Handling","Cranes"], hoist:["Material Handling","Hoists"], hoists:["Material Handling","Hoists"], conveyor:["Material Handling","Conveyors"], conveyors:["Material Handling","Conveyors"], forklift:["Material Handling","Forklifts"], forklifts:["Material Handling","Forklifts"], "material handling":["Material Handling"],
  tools:["Tools & Industrial Supplies"], hardware:["Tools & Industrial Supplies"], bearing:["Tools & Industrial Supplies","Bearings"], bearings:["Tools & Industrial Supplies","Bearings"], belt:["Tools & Industrial Supplies","Belts"], belts:["Tools & Industrial Supplies","Belts"], fasteners:["Tools & Industrial Supplies","Fasteners"], fastener:["Tools & Industrial Supplies","Fasteners"], bolts:["Tools & Industrial Supplies","Fasteners"], consumables:["Tools & Industrial Supplies","Consumables"],
  computer:["IT, Telecom & Services","Computers"], computers:["IT, Telecom & Services","Computers"], networking:["IT, Telecom & Services","Networking"], telecom:["IT, Telecom & Services","Telecom"], software:["IT, Telecom & Services","Software"], it:["IT, Telecom & Services"], contract:["IT, Telecom & Services","Manufacturing Services"], oem:["IT, Telecom & Services","Manufacturing Services"],
  shipping:["Logistics & Freight"], freight:["Logistics & Freight"], cargo:["Logistics & Freight"], logistics:["Logistics & Freight"], forwarder:["Logistics & Freight","Freight Forwarding"], transport:["Logistics & Freight","Road Transport"],
  warehouse:["Warehousing & Fulfilment","Warehousing"], warehousing:["Warehousing & Fulfilment","Warehousing"],
  customs:["Customs & Trade","Customs Clearance"], clearance:["Customs & Trade","Customs Clearance"], inspection:["Inspection & Verification"], qc:["Inspection & Verification","Quality Inspection"],
  insurance:["Insurance"], finance:["Trade Finance"], lc:["Trade Finance","Letter of Credit"], sourcing:["Sourcing Services"], procurement:["Sourcing Services","Procurement Support"],
  consulting:["Professional Services","Consulting"], legal:["Professional Services","Legal Services"], tax:["Professional Services","Accounting & Tax"]
};

/**
 * Plain-language descriptions used by the smart search (buyers rarely type our category names).
 * Key = "Category" or "Category/Sub-category"; value = words and phrases a buyer might use for it.
 */
const keywords = {
  "Electrical & Electronics": "electrical power distribution wiring electricity voltage control panel breaker mcb mccb relay contactor",
  "Electrical & Electronics/Switchgear": "switch breaker mcb mccb isolator fuse distribution board circuit protection",
  "Electrical & Electronics/Panels": "control panel distribution board mcc pcc electrical cabinet",
  "Electrical & Electronics/Transformers": "transformer step up step down voltage power supply stabilizer",
  "Electrical & Electronics/Motors": "motor induction motor ac dc motor gear motor rotate drive fan pump motor",
  "Electrical & Electronics/Cables & Wires": "cable wire wiring copper cable power cable flexible wire",
  "Electrical & Electronics/Lighting": "light lamp bulb led tube street light flood light lighting fixture",
  "Electronic Components": "electronic parts circuit components chip semiconductor board",
  "Electronic Components/PCB": "pcb printed circuit board circuit board assembly smt",
  "Electronic Components/Sensors": "sensor detect proximity temperature pressure level flow measure",
  "Electronic Components/Displays": "display screen lcd led oled touch screen monitor panel",
  "Electronic Components/Connectors": "connector plug socket terminal header jack",
  "Machinery & Industrial Equipment": "machine machinery equipment manufacturing plant factory production industrial",
  "Machinery & Industrial Equipment/CNC Machines": "cnc machining center vmc hmc turning milling precision machining metal parts",
  "Machinery & Industrial Equipment/Cutting Machines": "cut cutting machine cutter laser plasma shearing sheet metal cut steel cut",
  "Machinery & Industrial Equipment/Press Machines": "press hydraulic press power press punching stamping forming",
  "Machinery & Industrial Equipment/Lathe Machines": "lathe turning machine metal turning",
  "Machinery & Industrial Equipment/Milling Machines": "milling machine mill vertical milling",
  "Machinery & Industrial Equipment/Injection Moulding Machines": "injection moulding machine plastic moulding make plastic parts",
  "Machinery & Industrial Equipment/Packaging Machines": "packaging machine packing pouch filling sealing wrapping carton",
  "Automation & Robotics": "automation automatic control programmable controller robot industrial automation",
  "Automotive & Auto Components": "vehicle car truck bike two wheeler spare parts auto parts automobile",
  "Automotive & Auto Components/Filters": "air filter oil filter fuel filter cabin filter",
  "EV & Electric Mobility": "electric vehicle ev scooter e rickshaw charging battery pack bike",
  "Plastics & Polymers": "plastic polymer pvc pp pe hdpe ldpe abs pet nylon resin material",
  "Plastics & Polymers/Containers": "plastic container box jar bucket tub storage bin",
  "Plastics & Polymers/Moulded Parts": "plastic moulded part injection moulded component custom plastic part",
  "Rubber Products": "rubber natural rubber silicone epdm nitrile neoprene",
  "Rubber Products/Seals": "seal oil seal gasket sealing ring leak",
  "Chemicals": "chemical industrial chemical raw chemical acid alkali solvent lab chemical",
  "Chemicals/Adhesives": "glue adhesive bonding sealant epoxy",
  "Metals & Alloys": "metal steel iron raw metal bar rod sheet plate coil ingot scrap",
  "Metals & Alloys/Steel": "ms steel mild steel carbon steel tmt rebar iron",
  "Metals & Alloys/Sheets & Plates": "metal sheet plate coil gi sheet cr sheet hr sheet",
  "Fabrication & Sheet Metal": "fabrication sheet metal job work custom metal work cutting bending welding",
  "Fabrication & Sheet Metal/Laser Cutting": "laser cutting cut sheet metal profile cutting job work",
  "Fabrication & Sheet Metal/Welding": "weld welding fabrication structure",
  "Moulds, Dies & Tooling": "mould mold die tool tooling make mould custom tool",
  "Packaging & Printing": "packaging packing box carton pouch bag label print printed",
  "Packaging & Printing/Bottles": "bottle pet bottle glass bottle jar water bottle",
  "Packaging & Printing/Boxes & Cartons": "box carton corrugated shipping box gift box",
  "Construction & Building Materials": "construction building house civil flooring wall roof",
  "Construction & Building Materials/Tiles": "tile floor tile wall tile ceramic vitrified",
  "Pipes, Tubes & Valves": "pipe tube piping plumbing water pipe fluid flow valve fittings",
  "Pumps, Hydraulics & Pneumatics": "pump water pump motor pump hydraulic air compressor pneumatic fluid",
  "Pumps, Hydraulics & Pneumatics/Pumps": "water pump submersible centrifugal pump pumping water lift",
  "Agriculture & Farm Equipment": "farm farmer farming agriculture crop field tractor irrigation",
  "Food & Beverage": "food edible eat drink grocery ingredient snack",
  "Food & Beverage/Spices": "spice masala turmeric chilli pepper cumin",
  "Food & Beverage/Grains": "rice wheat grain pulses dal cereal flour",
  "Food Processing Machinery": "food machine processing plant bakery dairy flour mill spice grinder filling",
  "Textile & Apparel": "cloth clothing garment fabric textile yarn apparel dress shirt wear",
  "Textile & Apparel/Garments": "garment clothing shirt t shirt dress kurta innerwear lingerie intimates underwear women men kids apparel wear",
  "Textile & Apparel/Fabrics": "fabric cloth cotton silk polyester denim woven knitted",
  "Home Appliances": "home kitchen appliance household domestic mixer fan cooking",
  "Home Appliances/Mixer Grinders": "mixer grinder blender juicer grind",
  "Consumer Electronics": "consumer gadget tv audio speaker headphone camera smart device",
  "Renewable Energy": "solar wind green energy renewable power plant rooftop",
  "Renewable Energy/Solar Panels": "solar panel photovoltaic pv module solar power",
  "Batteries & Power Solutions": "battery power backup inverter ups charger storage lithium lead acid",
  "Medical & Healthcare": "medical health hospital clinic patient surgical diagnostic doctor",
  "Laboratory & Testing": "lab laboratory testing test measure calibrate quality instrument",
  "Safety & Security": "safety security protect ppe helmet gloves fire cctv camera surveillance guard",
  "Material Handling": "lift carry move load warehouse crane hoist conveyor forklift trolley pallet",
  "Tools & Industrial Supplies": "tool hardware industrial supplies bearing belt fastener bolt nut screw consumable mro",
  "IT, Telecom & Services": "it computer laptop software network telecom internet server app website services outsourcing",
  "Logistics & Freight": "ship shipping freight cargo courier transport delivery forwarder import export logistics",
  "Warehousing & Fulfilment": "warehouse storage godown fulfilment 3pl",
  "Customs & Trade": "customs duty clearance import export documentation iec licence",
  "Inspection & Verification": "inspect inspection audit quality check pre shipment verify factory audit",
  "Insurance": "insurance cover cargo insurance risk",
  "Trade Finance": "finance loan credit letter of credit lc working capital payment",
  "Sourcing Services": "sourcing procurement find supplier buying agent",
  "Professional Services": "consulting consultant legal lawyer tax accounting audit advisory"
};

/**
 * Old catalogue -> new catalogue. Applied once at start-up (idempotent) so existing suppliers,
 * products and requirements keep matching after the rename. [oldCategory, oldSub] -> [newCategory, newSub].
 */
const legacyMap = [
  ["Raw Materials","Metals","Metals & Alloys","Other"],["Raw Materials","Minerals","Chemicals","Other"],["Raw Materials","Polymers","Plastics & Polymers","Granules"],["Raw Materials","Industrial Raw Materials","Chemicals","Other"],
  ["Plastics & Packaging","Plastic Containers","Plastics & Polymers","Containers"],["Plastics & Packaging","Plastic Bottles","Packaging & Printing","Bottles"],["Plastics & Packaging","Packaging Films","Packaging & Printing","Packaging Film"],["Plastics & Packaging","Plastic Components","Plastics & Polymers","Moulded Parts"],
  ["Machinery","Injection Moulding Machines","Machinery & Industrial Equipment","Injection Moulding Machines"],["Machinery","CNC Machines","Machinery & Industrial Equipment","CNC Machines"],["Machinery","Packaging Machines","Machinery & Industrial Equipment","Packaging Machines"],["Machinery","Industrial Machinery","Machinery & Industrial Equipment","Other"],
  ["Electronics & Components","Electronic Components","Electronic Components","Other"],["Electronics & Components","PCB","Electronic Components","PCB"],["Electronics & Components","Power Supplies","Electronic Components","Modules"],["Electronics & Components","Sensors","Electronic Components","Sensors"],
  ["Automotive","Auto Components","Automotive & Auto Components","Other"],["Automotive","Accessories","Automotive & Auto Components","Accessories"],["Automotive","Aftermarket Parts","Automotive & Auto Components","Other"],
  ["Textiles & Apparel","Fabrics","Textile & Apparel","Fabrics"],["Textiles & Apparel","Garments","Textile & Apparel","Garments"],["Textiles & Apparel","Home Textiles","Textile & Apparel","Home Textiles"],
  ["Food & Agriculture","Food Ingredients","Food & Beverage","Food Ingredients"],["Food & Agriculture","Agri Products","Food & Beverage","Other"],["Food & Agriculture","Processed Food","Food & Beverage","Other"],
  ["Chemicals","Industrial Chemicals","Chemicals","Industrial Chemicals"],["Chemicals","Specialty Chemicals","Chemicals","Specialty Chemicals"],["Chemicals","Cleaning Chemicals","Chemicals","Cleaning Chemicals"],
  ["Consumer Products","Household Products","Home Appliances","Other"],["Consumer Products","Kitchenware","Home Appliances","Other"],["Consumer Products","Personal Care","Home Appliances","Other"],
  ["Construction Materials","Building Materials","Construction & Building Materials","Other"],["Construction Materials","Tiles & Surfaces","Construction & Building Materials","Tiles"],["Construction Materials","Plumbing Products","Pipes, Tubes & Valves","Fittings"],
  ["Industrial Equipment","Process Equipment","Machinery & Industrial Equipment","Other"],["Industrial Equipment","Material Handling","Material Handling","Other"],["Industrial Equipment","Plant Equipment","Machinery & Industrial Equipment","Other"],
  ["Electrical Equipment","Electrical Components","Electrical & Electronics","Electrical Components"],["Electrical Equipment","Switchgear","Electrical & Electronics","Switchgear"],["Electrical Equipment","Industrial Controls","Automation & Robotics","Other"],
  ["Tools & Hardware","Hand Tools","Tools & Industrial Supplies","Hand Tools"],["Tools & Hardware","Power Tools","Tools & Industrial Supplies","Power Tools"],["Tools & Hardware","Hardware","Tools & Industrial Supplies","Other"],
  ["Metal Products","Steel Products","Metals & Alloys","Steel"],["Metal Products","Aluminium Products","Metals & Alloys","Aluminium"],["Metal Products","Fabricated Parts","Fabrication & Sheet Metal","Other"],
  ["Industrial Components","Bearings","Tools & Industrial Supplies","Bearings"],["Industrial Components","Fasteners","Tools & Industrial Supplies","Fasteners"],["Industrial Components","Seals","Rubber Products","Seals"],
  ["Manufacturing Services","Contract Manufacturing","IT, Telecom & Services","Manufacturing Services"],["Manufacturing Services","Assembly","IT, Telecom & Services","Manufacturing Services"],["Manufacturing Services","Fabrication","Fabrication & Sheet Metal","Other"]
];
// Old category names that no longer exist: any leftover row (unknown sub) goes to this category / "Other".
const legacyCategoryFallback = {
  "Raw Materials":"Metals & Alloys","Plastics & Packaging":"Plastics & Polymers","Machinery":"Machinery & Industrial Equipment","Electronics & Components":"Electronic Components",
  "Automotive":"Automotive & Auto Components","Textiles & Apparel":"Textile & Apparel","Food & Agriculture":"Food & Beverage","Consumer Products":"Home Appliances",
  "Construction Materials":"Construction & Building Materials","Industrial Equipment":"Machinery & Industrial Equipment","Electrical Equipment":"Electrical & Electronics",
  "Tools & Hardware":"Tools & Industrial Supplies","Metal Products":"Metals & Alloys","Industrial Components":"Tools & Industrial Supplies","Manufacturing Services":"IT, Telecom & Services"
};

module.exports = { catalog, groups, aliases, keywords, legacyMap, legacyCategoryFallback };
