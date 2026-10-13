'use strict';
const fs=require('fs');
const path=require('path');
global.window=global;
const C=require('../js/core.js');
global.jspdf=require('jspdf');
require('jspdf-autotable');
require('../js/pdf.js');

const company={id:'main',englishName:'Example Export Testing Co., Ltd.',telephone:'+1 000 000 0000',email:'qa@example.invalid',address:'123 Test Street, Test City, Testland',website:'https://example.invalid',taxId:'QA-TAX-ID-0001',authorizedSignatoryName:'Test Signatory',authorizedSignatoryTitle:'Test Title',accounts:[{id:'usd',label:'Example Test USD Account',currency:'USD',beneficiaryName:'Example Export Testing Co., Ltd.',bankName:'Example Test Bank',bankAddress:'1 Test Bank Road, Test City, Testland',accountNumber:'000000000001',achRoutingNumber:'000000000',wireRoutingNumber:'000000000',swift:'TESTBANKXXX',paymentReference:'Use the test document number.'}]};
const buyer={id:'buyer',buyerType:'Company',buyerName:'Sample Buyer Testing Ltd.',companyName:'Sample Buyer Testing Ltd.',address:'456 Buyer Test Avenue, Sample City, Testland',country:'Testland',contactPerson:'Test Contact',telephone:'+1 000 000 0001',email:'buyer@example.invalid',consigneeName:'Sample Buyer Warehouse',consigneeAddress:'789 Warehouse Test Road, Sample City, Testland',consigneeCountry:'Testland',consigneeTelephone:'+1 000 000 0002'};
const ctx={company,customers:[buyer],orders:[]};
let order=C.calculateOrder({...C.newOrder([]),id:'snapshot-order',orderNumber:'ORD-20260719-001',piNumber:'PI-202607-009',customerId:'buyer',paymentAccountId:'usd',piVersion:'Final',namedPlace:'Yantian Port, Shenzhen, China',createdDate:'2026-07-19',validUntil:'2026-08-18',items:[{id:'line',description:'Snapshot validation product',modelSku:'SVP-100',material:'Brass',hsCode:'84818090',countryOfOrigin:'China',quantity:10,ciQuantity:10,packingQuantity:10,unit:'PCS',unitPrice:100,netWeight:1,grossWeight:1.2,cartonQty:1,quantityPerCarton:10,cartonNumber:'1',cartonLength:50,cartonWidth:40,cartonHeight:30}]});
order=C.createPISnapshot(order,ctx,0);
order.items[0].quantity=12;
order=C.createPISnapshot(order,ctx,1);
order=C.createCIDocument(order,[]);
Object.assign(order.ciDocument.data,{actualShipmentDate:'2026-07-19',shipmentDate:'2026-07-19',actualTransportMethod:'Sea Freight',actualTransportConfirmed:true,carrier:'Maersk Line',transportDocumentType:'Bill of Lading',transportDocumentNumber:'BL-20260719-009',purposeOfShipment:'Commercial Sale',declaration:'We hereby certify that the information on this invoice is true and correct.'});
order.ciDocument.data.items[0].ciQuantity=11;
order.ciDocument.differences=C.compareCIToPI(order);order.ciDocument.differencesConfirmed=true;order.ciVersion='Final';
order=C.createPackingListDocument(order,[]);order.packingListDocument.data.items[0].packingQuantity=11;order.packingListDocument.data.items[0].quantityPerCarton=11;order.packingListDocument.data.shippingMark='N/M';order.plVersion='Final';

const out=path.join(__dirname,'..','output','pdf');fs.mkdirSync(out,{recursive:true});
const files=[
  ['PI-Snapshot-Original.pdf',global.FTPDF.buildPI(C.documentOrder(order,'PI',0),{company:order.piHistory[0].seller,customers:[order.piHistory[0].buyer]})],
  ['PI-Snapshot-R1.pdf',global.FTPDF.buildPI(C.documentOrder(order,'PI',1),{company:order.piHistory[1].seller,customers:[order.piHistory[1].buyer]})],
  ['CI-Related-PI-R1.pdf',global.FTPDF.buildCI(C.documentOrder(order,'CI'),ctx)],
  ['PL-Independent.pdf',global.FTPDF.buildPL(C.documentOrder(order,'PL'),ctx)]
];
for(const [name,doc] of files){const file=path.join(out,name);fs.writeFileSync(file,Buffer.from(doc.output('arraybuffer')));console.log(`Generated ${name} (${doc.getNumberOfPages()} page(s))`);}
