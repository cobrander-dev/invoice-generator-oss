'use strict';

const fs=require('fs');
const path=require('path');
global.window=global;
global.document={createElement:()=>({click(){}}),body:{append(){}}};
global.jspdf=require('jspdf');
require('jspdf-autotable');
global.JSZip=require('jszip');
const C=require('../js/core.js');
require('../js/pdf.js');

const OUTPUT=path.join(__dirname,'..','output','pdf');
fs.mkdirSync(OUTPUT,{recursive:true});

const COMPANY_NAME='Aurora Homeware Export Co., Ltd.';
const company={
  id:'test-company',documentMode:'Test',testMode:true,englishName:COMPANY_NAME,address:'No. 88 Innovation Road, Foshan, Guangdong, China',
  telephone:'+86 757 0000 0000',email:'export@example.com',website:'www.example-export.com',taxId:'91440000DEMO00000X',
  authorizedSignatoryName:'Morgan Lee',authorizedSignatoryTitle:'Export Director',logo:'',signature:'',stamp:'',
  accounts:[{id:'test-usd',label:'Example Test USD Account',currency:'USD',beneficiaryName:COMPANY_NAME,bankName:'Example Test Bank',bankAddress:'1 Test Bank Road, Test City, Testland',accountNumber:'000000000000',swift:'TESTBANKXXX',paymentReference:'Use the test document number.'}]
};
const customer={id:'test-buyer',buyerType:'Company',buyerName:'Northstar Trading',companyName:'Northstar Trading Ltd.',address:'12 Market Street',country:'Canada',contactPerson:'Alex Morgan',telephone:'+1 000 000 0000',email:'purchasing@northstar.example',consigneeName:'Northstar Warehouse',consigneeAddress:'80 Logistics Avenue',consigneeCountry:'Canada',consigneeTelephone:'+1 000 000 0001'};
const ctx={company,customers:[customer],orders:[],documentMode:'Test',testMode:true};
const item=(id,description='Thermostatic Shower System')=>({id,description,modelSku:'TS100 / EX-TS100',material:'Brass / Stainless Steel',hsCode:'84818090',countryOfOrigin:'China',quantity:10,ciQuantity:10,packingQuantity:10,unit:'SETS',unitPrice:128.5,netWeight:4.8,grossWeight:5.5,cartonQty:2,quantityPerCarton:5,cartonNumber:'',cartonLength:78,cartonWidth:42,cartonHeight:18});
const baseFields={testMode:true,customerId:customer.id,paymentAccountId:'test-usd',currency:'USD',createdDate:'2026-07-19',validUntil:'2026-08-18',incotermCode:'FOB',tradeTerm:'FOB',namedPlace:'Yantian Port, Shenzhen, China',namedPlaceConfirmed:true,incotermVersion:'Incoterms® 2020',paymentTerm:'30% Deposit, 70% Before Shipment',paymentTermPreset:'30% Deposit, 70% Before Shipment',depositPercentage:30,plannedTransportMethod:'Sea Freight',actualShipmentDate:'2026-07-20',shipmentDate:'2026-07-20',actualTransportMethod:'Sea Freight',actualTransportConfirmed:true,carrier:'Test Ocean Carrier',transportDocumentType:'Bill of Lading',transportDocumentNumber:'TEST-BL-001',portOfLoading:'Yantian Port, Shenzhen, China',portOfDischarge:'Vancouver Port, Canada',purposeOfShipment:'Commercial Sale',declaration:'We hereby certify that the information on this invoice is true and correct.',countryOfOrigin:'China',freight:120,insurance:0,discount:0,otherCharges:0,items:[item('line-1')]};

// Test A: a genuinely independent CI. It is not created by createCIDocument and has no PI/order relationship.
const standaloneCI=C.calculateOrder({...C.newOrder([]),...baseFields,id:'ci-standalone-object',standalone:true,orderNumber:'',piNumber:'',relatedPiNumber:'',relatedPiRevision:'',ciNumber:'CI-STANDALONE-TEST',ciVersion:'Draft',piHistory:[],piDocument:null,ciDocument:null});

// Test B: a separate object that is finalized as PI first, then converted through createCIDocument.
const piSource=C.calculateOrder({...C.newOrder([]),...baseFields,id:'pi-source-object',standalone:false,orderNumber:'ORD-FROM-PI-TEST',piNumber:'PI-FROM-PI-TEST',ciNumber:'',packingListNumber:'',piVersion:'Draft'});
let fromPI=C.createPISnapshot(piSource,ctx,0);
fromPI=C.createCIDocument(fromPI,[],false,ctx);
fromPI={...fromPI,actualShipmentDate:'2026-07-20',shipmentDate:'2026-07-20',actualTransportMethod:'Sea Freight',actualTransportConfirmed:true,carrier:'Test Ocean Carrier',transportDocumentType:'Bill of Lading',transportDocumentNumber:'TEST-BL-002',portOfLoading:'Yantian Port, Shenzhen, China',portOfDischarge:'Vancouver Port, Canada'};
fromPI=C.updateStageDocuments(fromPI);
const ciFromPI=C.documentOrder(fromPI,'CI');
ciFromPI.ciNumber=fromPI.ciNumber;

const piSingle=C.documentOrder({...fromPI,piVersion:'Final',piSigningMode:'Print',piIncludeSigningBlock:true},'PI',0);
const piMultipage=C.calculateOrder({...piSource,id:'pi-multipage-object',piNumber:'PI-MULTIPAGE-TEST',piVersion:'Draft',items:Array.from({length:72},(_,index)=>item(`multi-${index+1}`,`Thermostatic Shower System - Test Line ${index+1}`))});
let packingSource=C.createPackingListDocument(fromPI,[]);
const packingList=C.documentOrder(packingSource,'PL');

const documents=[
  {name:'CI-standalone-test.pdf',type:'CI',data:standaloneCI},
  {name:'CI-from-PI-test.pdf',type:'CI',data:ciFromPI},
  {name:'PI-single-test.pdf',type:'PI',data:piSingle},
  {name:'PI-multipage-test.pdf',type:'PI',data:piMultipage},
  {name:'Packing-List-test.pdf',type:'PL',data:packingList}
];

const build={PI:global.FTPDF.buildPI,CI:global.FTPDF.buildCI,PL:global.FTPDF.buildPL};
const results=[];
for(const entry of documents){
  const doc=build[entry.type](entry.data,ctx),text=doc.internal.pages.flat().join('\n');
  if(!text.includes('TEST SAMPLE - NOT FOR COMMERCIAL USE'))throw new Error(`${entry.name}: missing Test Mode marker`);
  if(!text.includes(COMPANY_NAME)||text.includes('Aurora Homeware Export Co.,Ltd.'))throw new Error(`${entry.name}: company name mismatch`);
  fs.writeFileSync(path.join(OUTPUT,entry.name),Buffer.from(doc.output('arraybuffer')));
  results.push({file:entry.name,pages:doc.getNumberOfPages(),companyName:COMPANY_NAME});
}

const standaloneText=global.FTPDF.buildCI(standaloneCI,ctx).internal.pages.flat().join('\n');
if(/Order:|Related PI:|SHIPMENT REFERENCE/.test(standaloneText))throw new Error('Standalone CI leaked Order, Related PI, or Shipment Reference');
const linkedText=global.FTPDF.buildCI(ciFromPI,ctx).internal.pages.flat().join('\n');
if(!linkedText.includes('Order: ORD-FROM-PI-TEST')||!linkedText.includes('Related PI: PI-FROM-PI-TEST / Revision 0'))throw new Error('CI-from-PI relationship is missing');
if(C.tradeWarnings({...piSource,namedPlace:'Shenzhen, China'}).every(x=>!x.includes('请确认明确装运港')))throw new Error('Broad Shenzhen port warning missing');
if(C.tradeWarnings({...piSource,namedPlace:'Yantian Port, Shenzhen, China'}).some(x=>x.includes('请确认明确装运港')))throw new Error('Explicit Yantian port still warns');
if(C.formatTradeTerm(piSource)!=='FOB Yantian Port, Shenzhen, China, Incoterms® 2020')throw new Error('Trade term PDF value mismatch');

const productionCtx={...ctx,documentMode:'Production',testMode:false,company:{...company,documentMode:'Production',testMode:false}};
const productionErrors=C.validateDocumentExport({...piSource,piVersion:'Draft'},'PI',productionCtx).errors;
if(!productionErrors.some(x=>x.includes('Production')))throw new Error('Production Mode did not block Demo data');

const manifest={createdAt:new Date().toISOString(),companyNameSource:'ctx.company.englishName via FTCore.companyEnglishName()',testModeMarker:'TEST SAMPLE - NOT FOR COMMERCIAL USE',standaloneCI:{objectId:standaloneCI.id,standalone:standaloneCI.standalone,orderNumber:standaloneCI.orderNumber,relatedPiNumber:standaloneCI.relatedPiNumber||'',relatedPiRevision:standaloneCI.relatedPiRevision??''},ciFromPI:{objectId:fromPI.id,standalone:ciFromPI.standalone,orderNumber:ciFromPI.orderNumber,relatedPiNumber:ciFromPI.relatedPiNumber,relatedPiRevision:ciFromPI.relatedPiRevision},productionModeBlockedDemo:true,results};
fs.writeFileSync(path.join(OUTPUT,'final-validation-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
