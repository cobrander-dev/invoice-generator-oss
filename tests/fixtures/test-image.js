'use strict';
// Synthetic rectangular PNG spelling TEST. No signature or seal source images.
const {deflateSync}=require('node:zlib');
module.exports=function testImage(){
  const font={T:['11111','00100','00100','00100','00100','00100','00100'],E:['11111','10000','10000','11110','10000','10000','11111'],S:['11111','10000','10000','11111','00001','00001','11111']};
  const scale=4,width=104,height=40,raw=Buffer.alloc(height*(1+width*3),255);
  for(let y=0;y<height;y++)raw[y*(1+width*3)]=0;
  [...'TEST'].forEach((c,index)=>font[c].forEach((row,y)=>[...row].forEach((v,x)=>{if(v==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const offset=(y*scale+dy+6)*(1+width*3)+1+(index*24+x*scale+dx+6)*3;raw.fill(0,offset,offset+3);}})));
  const crc=buffer=>{let n=0xffffffff;for(const byte of buffer){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([size,body,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
};
