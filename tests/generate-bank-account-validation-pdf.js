'use strict';
const fs=require('fs');
const path=require('path');
global.window=global;
const C=require('../js/core.js');
global.jspdf=require('jspdf');
require('jspdf-autotable');
require('../js/pdf.js');

const company={
  id:'main',englishName:'Example Export Testing Co., Ltd.',chineseName:'Example Test Company',telephone:'+1 000 000 0000',email:'qa@example.invalid',
  address:'123 Test Street, Test City, Testland',website:'https://example.invalid',taxId:'QA-TAX-ID-0001',
  authorizedSignatoryName:'Test Signatory',authorizedSignatoryTitle:'QA Signatory & Director',logo:'',signature:'',stamp:'',accounts:[{
    id:'test-usd',label:'Example Test USD Account',currency:'USD',beneficiaryName:'Example Export Testing Co., Ltd.',bankName:'Example Test Bank',
    bankAddress:'1 Test Bank Road, Test City, Testland',accountNumber:'000000000001',achRoutingNumber:'000000000',wireRoutingNumber:'000000000',swift:'TESTBANKXXX',
    paymentReference:'Please include the PI number in the payment reference.'
  }]
};
const customer={id:'buyer',buyerType:'Company',buyerName:'Sample Buyer Testing Ltd.',companyName:'Sample Buyer Testing Ltd.',address:'456 Buyer Test Avenue, Sample City, Testland',country:'Testland',contactPerson:'Test Contact',telephone:'+1 000 000 0001',email:'buyer@example.invalid'};
const order={id:'order',orderNumber:'ORD-TEST-006',piNumber:'PI-TEST-006',piVersion:'Final',piShowSignature:false,piShowStamp:false,customerId:'buyer',currency:'USD',tradeTerm:'FOB',namedPlace:'Shenzhen',paymentTerm:'30% Deposit, 70% Before Shipment',deliveryTime:'30 days after deposit',validUntil:'2026-08-16',transportMethod:'Sea Freight',countryOfOrigin:'China',purposeOfShipment:'Commercial Sale',paymentAccountId:'test-usd',status:'Draft',createdDate:'2026-07-18',shipmentDate:'',shippingMark:'N/M',declaration:'We hereby certify that the information on this invoice is true and correct.',notes:'',freight:0,insurance:0,discount:0,otherCharges:0,depositPercentage:30,amountPaid:0,items:[{id:'line',description:'Thermostatic shower system with overhead and hand shower',modelSku:'TS680 / RR-TS680',material:'Brass / Stainless Steel',hsCode:'84818090',quantity:10,ciQuantity:10,packingQuantity:10,unit:'SETS',unitPrice:125.5,netWeight:4.5,grossWeight:5.2,cartonQty:2,quantityPerCarton:5,cartonLength:80,cartonWidth:40,cartonHeight:30}]};
const ctx={company,customers:[customer],orders:[order]};
const validation=C.validateDocumentExport(order,'PI',ctx);
if(validation.errors.length)throw new Error(validation.errors.join('; '));
const doc=global.FTPDF.buildPI(order,ctx),out=path.join(__dirname,'..','output','pdf','Bank-Account-Validation-Final-PI.pdf');
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,Buffer.from(doc.output('arraybuffer')));
console.log('Generated bank account validation Final PI');
