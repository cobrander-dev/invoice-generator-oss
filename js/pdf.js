(function(global){
  'use strict';
  const C=global.FTCore;
  const fmt=(v,c)=>`${c} ${C.money(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const safe=v=>String(v??'');
  const CONTENT_BOTTOM=270;
  const partyLines=p=>{const address=safe(p?.address),country=safe(p?.country),countryLine=country&&!address.toLocaleLowerCase().includes(country.toLocaleLowerCase())?country:'';return[p?.companyName||p?.buyerName,p?.buyerType==='Individual'?p?.buyerName:'',address,countryLine,p?.contactPerson?`Attn: ${p.contactPerson}`:'',p?.telephone?`Tel: ${p.telephone}`:'',p?.email].filter(Boolean);};
  const companyLines=c=>[C.companyEnglishName(c),c?.address,c?.telephone?`Tel: ${c.telephone}`:'',c?.email,c?.website,c?.taxId?`Tax ID: ${c.taxId}`:''].filter(Boolean);
  function remarkLines(doc,enabled,value,width=80){if(!enabled||!String(value||'').trim())return [];return safe(value).replace(/\r\n?/g,'\n').split('\n').flatMap(line=>line?doc.splitTextToSize(line,width):['']);}
  const dataUrlType=url=>String(url||'').startsWith('data:image/png')?'PNG':String(url||'').startsWith('data:image/webp')?'WEBP':'JPEG';

  function addFittedImage(doc,data,x,y,maxWidth,maxHeight){
    if(!data)return false;
    try{
      const props=doc.getImageProperties(data),ratio=props.width/props.height;
      let width=maxWidth,height=width/ratio;
      if(height>maxHeight){height=maxHeight;width=height*ratio;}
      doc.addImage(data,dataUrlType(data),x+(maxWidth-width)/2,y+(maxHeight-height)/2,width,height,undefined,'SLOW');
      return true;
    }catch(e){return false;}
  }
  function documentCompany(company={},order={},type='PI'){
    const key=String(type).toLowerCase(),hasFrozen=Boolean(order[`${key}SigningSnapshot`]),frozen=order[`${key}SigningSnapshot`]||{};
    const signatureImage=hasFrozen?C.companySignatureImage(frozen):C.companySignatureImage(company),companyStampImage=hasFrozen?C.companyStampImage(frozen):C.companyStampImage(company);
    return {...company,signatureImage,companyStampImage,signature:signatureImage,signatureFileName:hasFrozen?(frozen.signatureFileName||''):(company.signatureFileName||''),stamp:companyStampImage,stampFileName:hasFrozen?(frozen.stampFileName||''):(company.stampFileName||'')};
  }

  function docBase(title,company){
    const {jsPDF}=global.jspdf;
    const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
    doc.setProperties({title,subject:'Foreign Trade Document',author:C.companyEnglishName(company)||'Local Document Generator',creator:'Foreign Trade Document Generator'});
    return doc;
  }
  function addHeader(doc,title,company,order,type){
    const number=type==='PI'?(order.piDisplayNumber||order.piNumber):type==='CI'?order.ciNumber:order.packingListNumber;
    const settings=C.documentSettings(order,type),right=196,rightWidth=company?.logo?114:182;
    if(company?.logo)addFittedImage(doc,company.logo,14,14,58,24);
    doc.setFont('helvetica','bold');doc.setFontSize(13);doc.setTextColor(19,34,56);
    const nameLines=doc.splitTextToSize(safe(C.companyEnglishName(company)||'SELLER'),rightWidth).slice(0,2);let y=17;
    nameLines.forEach(line=>{doc.text(line,right,y,{align:'right'});y+=5;});
    y+=1.5;doc.setFont('helvetica','normal');doc.setFontSize(7.8);doc.setTextColor(45,55,70);
    const contact=[company?.telephone?`Tel: ${company.telephone}`:'',company?.email?`Email: ${company.email}`:''].filter(Boolean).join(' | ');
    const detailLines=[company?.address,contact,company?.website,company?.taxId?`Tax ID: ${company.taxId}`:''].filter(Boolean);
    detailLines.forEach(line=>{doc.splitTextToSize(safe(line),rightWidth).slice(0,2).forEach(part=>{doc.text(part,right,y,{align:'right'});y+=3.9;});});
    const dividerY=Math.max(45,y+2.8);doc.setDrawColor(50,75,105);doc.setLineWidth(.35);doc.line(14,dividerY,196,dividerY);
    const titleY=dividerY+11;doc.setFont('helvetica','bold');doc.setTextColor(19,34,56);doc.setFontSize(18);doc.text(title,105,titleY,{align:'center'});
    doc.setFontSize(8);doc.setTextColor(80);doc.text(number||'',105,titleY+6,{align:'center'});
    doc.setFontSize(6.8);if(settings.version==='Final')doc.setTextColor(22,101,52);else doc.setTextColor(146,64,14);doc.text(`${settings.version.toUpperCase()} DOCUMENT`,105,titleY+10.5,{align:'center'});
    const testMode=C.isTestMode(order,{company});if(testMode){doc.setFont('helvetica','bold');doc.setFontSize(8);doc.setTextColor(185,28,28);doc.text('TEST SAMPLE - NOT FOR COMMERCIAL USE',105,titleY+15.5,{align:'center'});}doc.setTextColor(0);
    return titleY+(testMode?21:16);
  }
  function addParties(doc,y,leftTitle,leftLines,rightTitle,rightLines){
    doc.autoTable({startY:y,theme:'grid',margin:{left:14,right:14},styles:{font:'helvetica',fontSize:7.5,cellPadding:2,lineColor:[180,185,193],lineWidth:.2,valign:'top'},headStyles:{fillColor:[235,239,244],textColor:[20,30,45],fontStyle:'bold'},head:[[leftTitle,rightTitle]],body:[[leftLines.join('\n'),rightLines.join('\n')]],columnStyles:{0:{cellWidth:91},1:{cellWidth:91}}});
    return doc.lastAutoTable.finalY+4;
  }
  function addSingleParty(doc,y,title,lines){
    doc.autoTable({startY:y,theme:'grid',margin:{left:14,right:14},styles:{font:'helvetica',fontSize:7.5,cellPadding:2,lineColor:[180,185,193],lineWidth:.2,valign:'top'},headStyles:{fillColor:[235,239,244],textColor:[20,30,45],fontStyle:'bold'},head:[[title]],body:[[lines.join('\n')]]});
    return doc.lastAutoTable.finalY+4;
  }
  function addMeta(doc,y,pairs){
    const rows=[];for(let i=0;i<pairs.length;i+=2){const a=pairs[i]||['',''],b=pairs[i+1]||['',''];rows.push([a[0],safe(a[1]),b[0],safe(b[1])]);}
    doc.autoTable({startY:y,theme:'plain',margin:{left:14,right:14},styles:{font:'helvetica',fontSize:7.5,cellPadding:{top:1.3,bottom:1.3,left:1,right:1}},body:rows,columnStyles:{0:{fontStyle:'bold',textColor:[70,80,95],cellWidth:27},1:{cellWidth:64},2:{fontStyle:'bold',textColor:[70,80,95],cellWidth:27},3:{cellWidth:64}}});
    return doc.lastAutoTable.finalY+4;
  }
  function addFooter(doc,company,order){
    const pages=doc.getNumberOfPages(),companyName=C.companyEnglishName(company)||'Seller',orderNumber=order.orderNumber||'',testMode=C.isTestMode(order,{company});
    const leftX=14,leftWidth=66,centerX=105,rightX=196;
    for(let p=1;p<=pages;p++){
      doc.setPage(p);doc.setDrawColor(210);doc.line(14,284,196,284);
      doc.setFont('helvetica','normal');doc.setFontSize(6.2);doc.setTextColor(110);
      const leftText=orderNumber?`${companyName} | ${orderNumber}`:companyName;
      const leftLines=doc.splitTextToSize(leftText,leftWidth).slice(0,2);
      doc.text(leftLines,leftX,leftLines.length>1?287.5:289.5);
      if(testMode){doc.setFont('helvetica','bold');doc.setTextColor(185,28,28);doc.text('TEST SAMPLE - NOT FOR COMMERCIAL USE',centerX,289.5,{align:'center'});}
      doc.setFont('helvetica','normal');doc.setTextColor(110);doc.text(`Page ${p} of ${pages}`,rightX,289.5,{align:'right'});doc.setTextColor(0);
    }
  }
  function addSignatures(doc,y,company,order,type){
    const settings=C.documentSettings(order,type);
    if(settings.version!=='Final'||!settings.includeSigningBlock)return y;
    const blockHeight=settings.signingMode==='Electronic'?54:51.5;
    if(y+blockHeight>CONTENT_BOTTOM){doc.addPage();y=20;}
    const signatureX=100,signatureW=50,stampX=155.5,stampSize=40.5;
    doc.setDrawColor(205);doc.setLineWidth(.25);doc.line(96,y,196,y);
    doc.setFont('helvetica','bold');doc.setFontSize(7.4);doc.setTextColor(45,55,70);
    doc.text('FOR AND ON BEHALF OF THE SELLER',signatureX,y+3);
    doc.setFont('helvetica','normal');doc.setFontSize(6.8);doc.text(safe(C.companyEnglishName(company)),signatureX,y+6.5);
    doc.setFont('helvetica','bold');doc.setFontSize(7.2);doc.text('AUTHORIZED SIGNATURE',signatureX,y+10.5);doc.text('COMPANY STAMP',stampX+stampSize/2,y+10.5,{align:'center'});
    if(settings.signingMode==='Electronic'){
      const signatureAdded=addFittedImage(doc,C.companySignatureImage(company),signatureX,y+12.5,31.5,12);
      const stampAdded=addFittedImage(doc,C.companyStampImage(company),stampX,y+11.5,stampSize,stampSize);
      if(!signatureAdded||!stampAdded)throw new Error('无法读取公司资料中的正式签名或公司印章，请重新上传并保存，或改用打印签章版。');
    }else{
      doc.setDrawColor(120);doc.setLineWidth(.25);doc.line(signatureX,y+27,signatureX+signatureW,y+27);
    }
    doc.setFont('helvetica','normal');doc.setFontSize(7);doc.setTextColor(45);
    doc.text(`Name: ${safe(company?.authorizedSignatoryName||'')}`,signatureX,y+31.5);
    doc.text(`Title: ${safe(company?.authorizedSignatoryTitle||'')}`,signatureX,y+35.5);
    doc.text(`Date: ${safe(settings.signedDate)}`,signatureX,y+39.5);
    doc.setTextColor(0);return y+blockHeight;
  }
  function signatureHeight(order,type){const settings=C.documentSettings(order,type);return settings.version==='Final'&&settings.includeSigningBlock?(settings.signingMode==='Electronic'?54:51.5):0;}
  function closingStart(doc,y,height){if(y+height<=CONTENT_BOTTOM)return y;doc.addPage();return 20;}
  function summaryRows(order,kind){
    const rows=[['Product Subtotal',fmt(order.subtotal,order.currency)]];
    if(order.showZeroAmountItems||order.freight) rows.push(['Freight',fmt(order.freight,order.currency)]);
    if(order.showZeroAmountItems||order.insurance) rows.push(['Insurance',fmt(order.insurance,order.currency)]);
    if(order.showZeroAmountItems||order.discount) rows.push(['Discount',`- ${fmt(order.discount,order.currency)}`]);
    if(order.showZeroAmountItems||order.otherCharges) rows.push(['Other Charges',fmt(order.otherCharges,order.currency)]);
    rows.push([kind==='PI'?'TOTAL AMOUNT':'TOTAL INVOICE VALUE',fmt(order.total,order.currency)]);
    if(kind==='PI'){rows.push([`Deposit Required (${order.depositPercentage}%)`,fmt(order.depositAmount,order.currency)],['Balance Payment',fmt(order.balancePayment,order.currency)]);if(order.amountPaid>0)rows.push(['Amount Paid',fmt(order.amountPaid,order.currency)],['Outstanding Amount',fmt(order.outstandingAmount,order.currency)]);rows.push(['AMOUNT PAYABLE NOW',fmt(order.amountPayableNow,order.currency)]);}
    if(kind==='CI'&&order.showPaymentStatusOnCI)rows.push(['Amount Paid',fmt(order.amountPaid,order.currency)],['Outstanding Amount',fmt(order.outstandingAmount,order.currency)]);
    return rows;
  }
  function addSummary(doc,y,rows,compact=false){
    doc.autoTable({startY:y,theme:'plain',margin:{left:112,right:14,bottom:27},styles:{font:'helvetica',fontSize:compact?7.5:8,cellPadding:compact?1.05:1.4},body:rows,columnStyles:{0:{fontStyle:'bold',halign:'right'},1:{halign:'right',cellWidth:42}},didParseCell:d=>{if(d.row.index===rows.length-1){d.cell.styles.fillColor=[19,34,56];d.cell.styles.textColor=[255,255,255];d.cell.styles.fontStyle='bold';}}});return doc.lastAutoTable.finalY+(compact?2.5:4);
  }
  function getCustomer(order,customers){return customers.find(x=>x.id===order.customerId)||{};}

  function buildPI(raw,ctx){
    const order=C.calculateOrder(raw),customer=getCustomer(order,ctx.customers),company=documentCompany(ctx.company||{},order,'PI'),account=(company.accounts||[]).find(a=>a.id===order.paymentAccountId)||{},compact=order.items.length===1;
    const doc=docBase(order.piNumber,company);let y=addHeader(doc,'PROFORMA INVOICE',company,order,'PI');
    y=addParties(doc,y,'SELLER',companyLines(company),'BUYER',partyLines(customer));
    const planned=order.plannedTransportMethod==='Other'?order.plannedTransportMethodOther:order.plannedTransportMethod;
    y=addMeta(doc,y,[['PI Number',order.piDisplayNumber||order.piNumber],['Revision',order.piRevision??0],['Order Number',order.orderNumber],['Date',order.createdDate],['Valid Until',order.validUntil],['Currency',order.currency],['Trade Term',C.formatTradeTerm(order)],['Payment Term',order.paymentTerm],['Delivery Time',order.deliveryTime],['Planned Transport Method',planned]]);
    doc.autoTable({startY:y,theme:'grid',margin:{left:14,right:14,bottom:27},head:[['Item','Product Description','Model / SKU','Material','HS Code','Qty','Unit','Unit Price','Amount']],body:order.items.map((i,n)=>[n+1,i.description,C.formatModelSku(i.modelSku),i.material,i.hsCode,i.quantity,i.unit,fmt(i.unitPrice,order.currency),fmt(i.amount,order.currency)]),styles:{font:'helvetica',fontSize:6.8,cellPadding:compact?1.15:1.5,lineColor:[190,195,202],lineWidth:.15,valign:'middle'},headStyles:{fillColor:[29,49,80],textColor:255,fontStyle:'bold'},columnStyles:{0:{cellWidth:9,halign:'center'},1:{cellWidth:46},2:{cellWidth:22},3:{cellWidth:21},4:{cellWidth:18},5:{cellWidth:12,halign:'right'},6:{cellWidth:13},7:{cellWidth:20,halign:'right'},8:{cellWidth:21,halign:'right'}},rowPageBreak:'avoid'});
    y=addSummary(doc,doc.lastAutoTable.finalY+(compact?2:3),summaryRows(order,'PI'),compact);
    const paymentAccount={...account,beneficiaryName:C.companyEnglishName(company)},paymentLines=C.paymentInformationLines(paymentAccount),lineStep=compact?3.25:3.8,wrappedPayment=paymentLines.flatMap(line=>doc.splitTextToSize(safe(line),80)),wrappedNotes=remarkLines(doc,order.showCustomerRemarksOnPI,order.customerRemarks),paymentHeight=7+wrappedPayment.length*lineStep+(wrappedNotes.length?6+wrappedNotes.length*lineStep:0),closingHeight=Math.max(paymentHeight,signatureHeight(order,'PI'));
    y=closingStart(doc,y,closingHeight);const signatureY=y;doc.setFontSize(8);doc.setFont('helvetica','bold');doc.text('PAYMENT INFORMATION',14,y);doc.setFont('helvetica','normal');doc.setFontSize(7.5);y+=4;
    wrappedPayment.forEach(line=>{doc.text(line,14,y);y+=lineStep;});
    if(wrappedNotes.length){y+=compact?2:3;doc.setFont('helvetica','bold');doc.text('Remarks',14,y);doc.setFont('helvetica','normal');y+=compact?3.5:4;wrappedNotes.forEach(line=>{doc.text(line,14,y);y+=lineStep;});}
    addSignatures(doc,signatureY,company,order,'PI');addFooter(doc,company,order);return doc;
  }

  function buildCI(raw,ctx){
    const order=C.calculateOrder(raw),customer=getCustomer(order,ctx.customers),company=documentCompany(ctx.company||{},order,'CI');const doc=docBase(order.ciNumber,company);let y=addHeader(doc,'COMMERCIAL INVOICE',company,order,'CI');
    const consignee=[customer.consigneeName,customer.consigneeAddress,customer.consigneeCountry,customer.consigneeTelephone?`Tel: ${customer.consigneeTelephone}`:''].filter(Boolean);
    const standalone=order.standalone===true,hasRevision=order.relatedPiRevision!==''&&order.relatedPiRevision!=null,relatedPi=hasRevision?`${order.relatedPiNumber||order.piNumber} / Revision ${order.relatedPiRevision}`:(order.relatedPiNumber||order.piNumber),shipmentReference=[];
    if(!standalone&&order.orderNumber)shipmentReference.push(`Order: ${order.orderNumber}`);if(!standalone&&relatedPi)shipmentReference.push(`Related PI: ${relatedPi}`);
    y=addParties(doc,y,'EXPORTER / SELLER',companyLines(company),'BUYER',partyLines(customer));y=shipmentReference.length?addParties(doc,y,'CONSIGNEE',consignee,'SHIPMENT REFERENCE',shipmentReference):addSingleParty(doc,y,'CONSIGNEE',consignee);
    const actualMethod=order.actualTransportMethod==='Other'?order.actualTransportMethodOther:order.actualTransportMethod,documentType=order.transportDocumentType==='Other'?order.transportDocumentTypeOther:order.transportDocumentType,purpose=order.purposeOfShipment==='Other'?order.purposeOfShipmentOther:order.purposeOfShipment;
    const shipment=[['Actual Shipment Date',C.actualShipmentDate(order)],['Actual Transport Method',actualMethod],['Logistics Company / Carrier',order.carrier],['Transport Document Type',documentType],['Transport Document Number',order.transportDocumentNumber],['Vessel / Flight Number',order.vesselFlightNumber],['Port of Loading',order.portOfLoading],['Port of Discharge',order.portOfDischarge],['Estimated Arrival Date',order.estimatedArrivalDate]].filter(([,value])=>value);
    y=addMeta(doc,y,[['Invoice Number',order.ciNumber],['Invoice Date',order.createdDate],['Country of Origin',order.countryOfOrigin],['Currency',order.currency],['Trade Term',C.formatTradeTerm(order)],['Purpose',purpose],...shipment]);
    doc.autoTable({startY:y,theme:'grid',margin:{left:14,right:14,bottom:18},head:[['Item','Product Description','Model / SKU','Material','HS Code','Qty','Unit','Unit Price','Amount']],body:order.items.map((i,n)=>[n+1,i.description,C.formatModelSku(i.modelSku),i.material,i.hsCode,i.quantity,i.unit,fmt(i.unitPrice,order.currency),fmt(i.amount,order.currency)]),styles:{font:'helvetica',fontSize:6.8,cellPadding:1.5,lineColor:[190,195,202],lineWidth:.15},headStyles:{fillColor:[29,49,80],textColor:255},columnStyles:{0:{cellWidth:9,halign:'center'},1:{cellWidth:46},2:{cellWidth:22},3:{cellWidth:21},4:{cellWidth:18},5:{cellWidth:12,halign:'right'},6:{cellWidth:13},7:{cellWidth:20,halign:'right'},8:{cellWidth:21,halign:'right'}},rowPageBreak:'avoid'});
    const declaration=doc.splitTextToSize(order.declaration||'We hereby certify that the information on this invoice is true and correct.',80),remarks=remarkLines(doc,order.showCustomerRemarksOnCI,order.customerRemarks),rows=summaryRows(order,'CI'),leftHeight=rows.length*4.8+12+8+declaration.length*3.8+(remarks.length?7+remarks.length*3.8:0),closingHeight=Math.max(leftHeight,signatureHeight(order,'CI'));
    y=closingStart(doc,doc.lastAutoTable.finalY+3,closingHeight);
    doc.autoTable({startY:y,theme:'plain',margin:{left:14,right:112},styles:{font:'helvetica',fontSize:7,cellPadding:1.1},body:rows,columnStyles:{0:{fontStyle:'bold',halign:'right'},1:{halign:'right',cellWidth:31}},didParseCell:d=>{if(d.row.index===rows.length-1){d.cell.styles.fillColor=[19,34,56];d.cell.styles.textColor=[255,255,255];d.cell.styles.fontStyle='bold';}}});let leftY=doc.lastAutoTable.finalY+2;
    doc.autoTable({startY:leftY,theme:'grid',margin:{left:14,right:112},head:[['Packages','Net Weight','Gross Weight']],body:[[order.totalCartons,`${order.totalNetWeight.toFixed(2)} KG`,`${order.totalGrossWeight.toFixed(2)} KG`]],styles:{font:'helvetica',fontSize:6.6,halign:'center',cellPadding:1.2},headStyles:{fillColor:[235,239,244],textColor:[20,30,45]}});leftY=doc.lastAutoTable.finalY+3;
    doc.setFont('helvetica','bold');doc.setFontSize(8);doc.text('DECLARATION',14,leftY);doc.setFont('helvetica','normal');doc.setFontSize(7.5);leftY+=4;declaration.forEach(line=>{doc.text(line,14,leftY);leftY+=3.8;});if(remarks.length){leftY+=3;doc.setFont('helvetica','bold');doc.text('Remarks',14,leftY);doc.setFont('helvetica','normal');leftY+=4;remarks.forEach(line=>{doc.text(line,14,leftY);leftY+=3.8;});}addSignatures(doc,y,company,order,'CI');addFooter(doc,company,order);return doc;
  }

  function buildPL(raw,ctx){
    const order=C.calculateOrder(raw),customer=getCustomer(order,ctx.customers),company=documentCompany(ctx.company||{},order,'PL');const doc=docBase(order.packingListNumber,company);let y=addHeader(doc,'PACKING LIST',company,order,'PL');
    const consignee=[customer.consigneeName,customer.consigneeAddress,customer.consigneeCountry,customer.consigneeTelephone?`Tel: ${customer.consigneeTelephone}`:''].filter(Boolean);
    y=addParties(doc,y,'EXPORTER',companyLines(company),'BUYER',partyLines(customer));y=addParties(doc,y,'CONSIGNEE',consignee,'SHIPPING MARK',[order.shippingMark||'N/M']);
    const actualMethod=order.actualTransportMethod==='Other'?order.actualTransportMethodOther:order.actualTransportMethod,documentType=order.transportDocumentType==='Other'?order.transportDocumentTypeOther:order.transportDocumentType;
    const shipment=[['Actual Shipment Date',C.actualShipmentDate(order)],['Actual Transport Method',actualMethod],['Logistics Company / Carrier',order.carrier],['Transport Document Type',documentType],['Transport Document Number',order.transportDocumentNumber],['Port of Loading',order.portOfLoading],['Port of Discharge',order.portOfDischarge]].filter(([,value])=>value);
    const relatedPi=order.relatedPiRevision!=null?`${order.relatedPiNumber||order.piNumber} / Revision ${order.relatedPiRevision}`:(order.relatedPiNumber||order.piNumber);
    y=addMeta(doc,y,[['Packing List No.',order.packingListNumber],['Related CI',order.relatedCiNumber||order.ciNumber],['Related PI',relatedPi],['Order Number',order.orderNumber],['Trade Term',C.formatTradeTerm(order)],...shipment]);
    const body=order.items.map((i,n)=>[n+1,i.description,C.formatModelSku(i.modelSku),i.packageType||'Carton',i.cartonQty,i.quantityPerCarton||i.quantity,i.packingQuantity||i.ciQuantity||i.quantity,i.unit,i.countryOfOrigin,`${C.asNumber(i.netWeightPerCarton).toFixed(2)} KG`,`${C.asNumber(i.grossWeightPerCarton).toFixed(2)} KG`,`${i.cartonLength} x ${i.cartonWidth} x ${i.cartonHeight} cm`,i.cbm.toFixed(3)]);
    doc.autoTable({startY:y,theme:'grid',margin:{left:8,right:8,bottom:18},head:[['Item','Product Description','Model / SKU','Package','Cartons','Qty / Carton','Total Qty','Unit','Origin','N.W. / Carton','G.W. / Carton','Carton Dimensions','CBM']],body,styles:{font:'helvetica',fontSize:5.45,cellPadding:1.15,lineColor:[190,195,202],lineWidth:.15,valign:'middle'},headStyles:{fillColor:[29,49,80],textColor:255,fontSize:5.25},columnStyles:{0:{cellWidth:7},1:{cellWidth:32},2:{cellWidth:16},3:{cellWidth:13},4:{cellWidth:11,halign:'right'},5:{cellWidth:13,halign:'right'},6:{cellWidth:13,halign:'right'},7:{cellWidth:9},8:{cellWidth:14},9:{cellWidth:15,halign:'right'},10:{cellWidth:15,halign:'right'},11:{cellWidth:24},12:{cellWidth:12,halign:'right'}},rowPageBreak:'avoid'});
    y=doc.lastAutoTable.finalY+4;doc.autoTable({startY:y,theme:'grid',margin:{left:100,right:8},head:[['TOTAL CARTONS','TOTAL N.W.','TOTAL G.W.','TOTAL CBM']],body:[[order.totalCartons,`${order.totalNetWeight.toFixed(2)} KG`,`${order.totalGrossWeight.toFixed(2)} KG`,order.totalCBM.toFixed(3)]],styles:{font:'helvetica',fontSize:7,halign:'right',cellPadding:1.6},headStyles:{fillColor:[235,239,244],textColor:[20,30,45]}});y=doc.lastAutoTable.finalY+4;const declaration=order.plShowDeclaration?doc.splitTextToSize(order.plDeclaration||'We certify that the packing details stated above are true and correct.',80):[],packingRemarks=String(order.packingRemarks||'').trim()?doc.splitTextToSize(order.packingRemarks,80):[],remarks=remarkLines(doc,order.showCustomerRemarksOnPL,order.customerRemarks),declarationHeight=(declaration.length?8+declaration.length*3.8:0)+(packingRemarks.length?8+packingRemarks.length*3.8:0)+(remarks.length?8+remarks.length*3.8:0),closingHeight=Math.max(declarationHeight,signatureHeight(order,'PL'));if(closingHeight){y=closingStart(doc,y,closingHeight);let textY=y+4;if(declaration.length){doc.setFont('helvetica','bold');doc.setFontSize(8);doc.text('DECLARATION',14,textY);doc.setFont('helvetica','normal');doc.setFontSize(7.5);textY+=4;declaration.forEach(line=>{doc.text(line,14,textY);textY+=3.8;});}if(packingRemarks.length){textY+=3;doc.setFont('helvetica','bold');doc.text('PACKING REMARKS',14,textY);doc.setFont('helvetica','normal');textY+=4;packingRemarks.forEach(line=>{doc.text(line,14,textY);textY+=3.8;});}if(remarks.length){textY+=3;doc.setFont('helvetica','bold');doc.text('Remarks',14,textY);doc.setFont('helvetica','normal');textY+=4;remarks.forEach(line=>{doc.text(line,14,textY);textY+=3.8;});}addSignatures(doc,y,company,order,'PL');}addFooter(doc,company,order);return doc;
  }

  function ensureNumbers(order){return {...order};}
  function saveDoc(type,order,ctx,fileName=''){const full=ensureNumbers(order);const doc=type==='PI'?buildPI(full,ctx):type==='CI'?buildCI(full,ctx):buildPL(full,ctx);const number=type==='PI'?(full.piDisplayNumber||full.piNumber):type==='CI'?full.ciNumber:full.packingListNumber;doc.save(fileName||`${number}.pdf`);return full;}
  async function buildArchiveBlob(order,ctx){
    const full=ensureNumbers(order),zip=new JSZip(),pi=C.documentOrder?C.documentOrder(full,'PI'):full,ci=C.documentOrder?C.documentOrder(full,'CI'):full,pl=C.documentOrder?C.documentOrder(full,'PL'):full,snapshot=C.piSnapshot?C.piSnapshot(full):null,currentName=C.companyEnglishName(ctx.company),withCurrentName=seller=>({...seller,englishName:currentName}),piCtx=snapshot?{...ctx,company:withCurrentName(snapshot.seller||ctx.company),customers:[snapshot.buyer||{}]}:ctx,ciCtx=full.ciDocument?{...ctx,company:withCurrentName(full.ciDocument.seller||ctx.company),customers:[full.ciDocument.buyer||{}]}:ctx,plCtx=full.packingListDocument?{...ctx,company:withCurrentName(full.packingListDocument.seller||ctx.company),customers:[full.packingListDocument.buyer||{}]}:ctx;
    zip.file(`${pi.piDisplayNumber||pi.piNumber}.pdf`,buildPI(pi,piCtx).output('arraybuffer'));zip.file(`${ci.ciNumber}.pdf`,buildCI(ci,ciCtx).output('arraybuffer'));zip.file(`${pl.packingListNumber}.pdf`,buildPL(pl,plCtx).output('arraybuffer'));
    const customer=getCustomer(full,ctx.customers);zip.file('order-data.json',JSON.stringify({...full,customer},null,2));
    const folder=zip.folder('attachments');for(const file of (full.attachments||[])){const parts=String(file.data||'').split(',');if(parts[1]) folder.file(file.name,parts[1],{base64:true});}
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});return {blob,order:full};
  }
  async function exportArchive(order,ctx){
    const built=await buildArchiveBlob(order,ctx);downloadBlob(built.blob,`${built.order.orderNumber}-archive.zip`);return built.order;
  }
  function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  global.FTPDF={buildPI,buildCI,buildPL,saveDoc,buildArchiveBlob,exportArchive,ensureNumbers,downloadBlob};
})(window);
