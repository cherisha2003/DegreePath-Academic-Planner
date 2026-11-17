// General-purpose PDF schedule text extractor.
// Reads digital text, with OCR fallback for scanned/image-based PDFs.
// OCR does NOT guarantee that every school layout can be parsed perfectly.
'use strict';
const pdfParse = require('pdf-parse');

async function readSchedulePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0,5).toString() !== '%PDF-')
    throw Error('File is not a PDF.');
  const errors=[];
  try {
    const parsed=await pdfParse(buffer);
    if(parsed.text?.trim().length >= 30) return parsed.text;
  } catch(e) { errors.push('legacy: '+e.message); }

  // Modern PDF.js correctly handles many PDFs that legacy pdf-parse rejects.
  let pdf;
  try {
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdf=await pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,disableFontFace:true}).promise;
    const pages=[];
    let textChars=0;
    for(let i=1;i<=Math.min(pdf.numPages,30);i++){
      const page=await pdf.getPage(i);
      const items=(await page.getTextContent()).items.filter(x=>x.str?.trim());
      // Group text by visual lines for multi-column registrar exports.
      const lines=new Map();
      for(const item of items){
        const y=Math.round(item.transform[5]/3)*3;
        const existing=lines.get(y)||[];
        existing.push({x:item.transform[4],value:item.str});lines.set(y,existing);
      }
      const linesText=[...lines].sort((a,b)=>b[0]-a[0]).map(([,row])=>row.sort((a,b)=>a.x-b.x).map(x=>x.value).join(' ')).join('\n');
      textChars+=linesText.trim().length;
      pages.push(linesText);
    }
    if(textChars>=30) return pages.join('\n\n');

    // The PDF is image-based: render pages and run OCR on each page.
    // Limits cap processing time and memory for large uploaded documents.
    const {createCanvas}=require('@napi-rs/canvas');
    const {createWorker}=require('tesseract.js');
    const worker=await createWorker('eng');
    try {
      const extracted=[];
      for(let i=1;i<=Math.min(pdf.numPages,12);i++) {
        const page=await pdf.getPage(i);
        const viewport=page.getViewport({scale:1.8});
        const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
        await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
        const result=await worker.recognize(canvas.toBuffer('image/png'));
        extracted.push(result.data.text||'');
      }
      const text=extracted.join('\n\n');
      if(text.trim().length>=25)return text;
      throw Error('OCR found no recognizable text.');
    } finally {await worker.terminate();}
  } catch(e) {errors.push('modern/OCR: '+e.message);}
  finally {if(pdf)await pdf.destroy().catch(()=>{});}
  throw Error(errors.join(' | ').slice(0,500)||'No text detected.');
}
module.exports={readSchedulePdf};
