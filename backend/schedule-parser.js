// Extract likely class meeting records from text produced by PDF extraction or OCR.
// This is intentionally conservative: a student confirms the results before saving.
'use strict';
// GSU Banner term schedule: extract the structured registration rows rather than
// the second-page visual weekly grid. Credit hours are read from each row.
function parseBannerSchedule(text, fallbackTerm='Fall 2026') {
 const source=String(text||'').replace(/\r/g,'\n').replace(/[\u2013\u2014]/g,'-');
 if(!/Georgia State University/i.test(source) || !/Credit Hours/i.test(source) || !/CRN/i.test(source))return null;
 const header=source.match(/\b(Fall|Spring|Summer|Winter)\s+(?:Semester\s+)?(20\d{2})\s+Schedule\b/i);
 const term=header?header[1][0].toUpperCase()+header[1].slice(1).toLowerCase()+' '+header[2]:fallbackTerm;
 const firstPage=source.split(/(?:Total Hours\s*\||This is a general view of your term schedule)/i)[0];
 const lines=firstPage.split('\n').map(s=>s.trim()).filter(Boolean);
 const codePattern=/\b(CSC|CS|DSCI|CIS|MATH|STAT|BIO|PHYS|CHEM|ENGR)\s*[- ]?\s*(\d{4}[A-Z]?)\b\s+(\d{3})\s*(\d\.\d)\s*(\d{5})(?=\s*(?:\d{2}\/\d{2}\/\d{4}|$))/i;
 const indices=[];
 const headerByIndex=new Map();
 for(let i=0;i<lines.length;i++){
   if(codePattern.test(lines[i])){indices.push(i);headerByIndex.set(i,lines[i]);continue;}
   // PDF extractors often split the section, credit hours and CRN into
   // three separate lines. Recombine them for the structured parser.
   if(/^\s*(?:CSC|CS|DSCI|CIS|MATH|STAT|BIO|PHYS|CHEM|ENGR)\s*[- ]?\s*\d{4}[A-Z]?\s+\d{3}\s*$/i.test(lines[i])){
     const combined=[lines[i],lines[i+1]||'',lines[i+2]||''].join(' ');
     if(codePattern.test(combined)){indices.push(i);headerByIndex.set(i,combined);}
   }
 }
 if(!indices.length)return null;
 const convert=(raw,am)=>{
  const [hour,min]=raw.split(':').map(Number);
  let h=hour%12+(am.toUpperCase()==='PM'?12:0);
  return String(h).padStart(2,'0')+':'+String(min).padStart(2,'0');
 };
 const dayNames={monday:'M',tuesday:'T',wednesday:'W',thursday:'R',friday:'F',saturday:'Sa',sunday:'Su'};
 const candidates=[];
 for(let k=0;k<indices.length;k++){
  const i=indices[k];const match=headerByIndex.get(i).match(codePattern);
  const code=match[1].toUpperCase()+' '+match[2],credits=Number(match[4]),crn=match[5];
  // In raw extraction the course title precedes the detail row; in layout
  // extraction the title may instead follow the row.
  const prior=lines.slice(Math.max(0,i-3),i).filter(x=>/\bLF2F\b/i.test(x));
  const next=lines.slice(i+1,k+1<indices.length?indices[k+1]:lines.length);
  const titleLine=prior[prior.length-1]||next.find(x=>/\bLF2F\b/i.test(x))||'';
  const title=titleLine.replace(/\s*LF2F.*$/i,'').replace(/\s+(?:ONLINE|F2F)$/i,'').trim().slice(0,140);
  const block=next.join('\n');
  const dayLine=next.find(x=>/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i.test(x))||'';
  const days=[...new Set((dayLine.match(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/gi)||[]).map(x=>dayNames[x.toLowerCase()]))].join('');
  const t=block.match(/\b(\d{1,2}:\d{2})\s*(AM|PM)\s*(?:-|to)\s*(\d{1,2}:\d{2})\s*(AM|PM)\b/i);
  const place=next.find(x=>/\b(Atlanta|Urban Life|Classroom South)\b/i.test(x)&&/[,]/.test(x))||'';
  const teacher=next.find(x=>/^\s*[A-Za-z][A-Za-z' .-]+,\s*[A-Za-z][A-Za-z' .-]+\.?\s*$/.test(x)&&!/(Atlanta|Classroom|Urban Life|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i.test(x))||'';
  if(!t || !days || !(credits>0 && credits<=12))continue;
  const start=convert(t[1],t[2]),end=convert(t[3],t[4]);
  if(start>=end)continue;
  candidates.push({course_code:code,title,credits,crn,term,days,start_time:start,end_time:end,
   room:place.replace(/^Atlanta,\s*/i,'').trim(),instructor:teacher.replace(/\s*\.\s*$/,'').trim(),
   confidence:'banner-verified',source:'GSU Banner registration schedule'});
 }
 return {candidates,expected:indices.length,complete:candidates.length===indices.length};
}

function parseClassSchedule(text, term='Fall 2026') {
 const source=String(text||'').replace(/\r/g,'\n').replace(/[\u2013\u2014]/g,'-');
 const pattern=/\b(CSC|CS|MATH|STAT|DSCI|CIS|BIO|PHYS|CHEM|ENGR)\s*[- ]?\s*(\d{4}[A-Z]?)\b/gi;
 const matches=[...source.matchAll(pattern)];
 const found=[];
 const weekdays={mon:'M',monday:'M',tue:'T',tues:'T',tuesday:'T',wed:'W',wednesday:'W',thu:'R',thur:'R',thurs:'R',thursday:'R',fri:'F',friday:'F',sat:'Sa',saturday:'Sa',sun:'Su',sunday:'Su'};
 function convert(time,meridian) {
  const a=/^(\d{1,2}):(\d{2})$/.exec(time.trim());if(!a)return null;
  let h=Number(a[1]);const mins=Number(a[2]);
  if(meridian){if(h<1||h>12)return null;h=h%12+(meridian.toUpperCase()==='PM'?12:0);}
  if(h>23||mins>59)return null;
  return String(h).padStart(2,'0')+':'+String(mins).padStart(2,'0');
 }
 const timeRE=/(\d{1,2}:\d{2})\s*(AM|PM)?\s*(?:-|to|through)\s*(\d{1,2}:\d{2})\s*(AM|PM)?/gi;
 function findDays(chunk) {
  // Long day names have precedence over compact codes (TR, MW, MWF).
  const full=[...chunk.matchAll(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b/gi)];
  if(full.length){const names=[...new Set(full.map(x=>weekdays[x[1].toLowerCase()]).filter(Boolean))];return names.join('');}
  const compact=chunk.match(/(?:^|[\s(:])(?:Days?\s*[:=-]?\s*)?(MWF|MW|TR|TTH|M|T|W|R|F)(?=\s|$|[),;])/im);
  if(compact)return compact[1]==='TTH'?'TR':compact[1];
  return '';
 }
 const seen=new Set();
 for(let i=0;i<matches.length;i++){
  const x=matches[i];
  const code=x[1].toUpperCase()+' '+x[2];
  let block=source.slice(x.index,Math.min(source.length,x.index+600));
  if(i+1<matches.length&&matches[i+1].index<x.index+600)block=source.slice(x.index,matches[i+1].index);
  const time=[...block.matchAll(timeRE)][0];
  if(!time)continue;
  const firstMeridian=time[2]||time[4]||null;
  const start=convert(time[1],firstMeridian),end=convert(time[3],time[4]||time[2]||null);
  if(!start||!end||start>=end)continue;
  let days=findDays(block);
  if(!days){const vicinity=source.slice(Math.max(0,x.index-110),x.index);days=findDays(vicinity);}
  if(!days)continue;
  const header=block.split('\n')[0].replace(/\b(?:CSC|CS|MATH|STAT|DSCI|CIS|BIO|PHYS|CHEM|ENGR)\s*[- ]?\s*\d{4}[A-Z]?\b/i,'').replace(/^[\s:,-]+/,'').trim();
  const title=header.slice(0,110);
  const key=[code,days,start,end].join('|');if(seen.has(key))continue;seen.add(key);
  let room='';const roomMatch=block.match(/(?:room|location|building)\s*[:#-]?\s*([^\n]{3,60})/i);if(roomMatch)room=roomMatch[1].trim().slice(0,120);
  let instructor='';const prof=block.match(/(?:instructor|professor|faculty)\s*[:=-]?\s*([^\n]{3,70})/i);if(prof)instructor=prof[1].trim().slice(0,120);
  // Credits must occur near this course, and be explicitly labelled.
  // Avoid treating a section number, CRN, or room as course credits.
  const around=block.slice(0,450);
  const creditMatch=around.match(/(?:credit(?:s| hours?)?|units?|hrs?)\s*[:=]?\s*(\d(?:\.\d)?)(?!\d)/i)
    ||around.match(/\b(\d(?:\.\d)?)\s*(?:credit(?:s| hours?)?|units?|hrs?)\b/i);
  const credits=creditMatch?Number(creditMatch[1]):null;
  found.push({course_code:code,title,credits:credits>0&&credits<=12?credits:null,term,days,start_time:start,end_time:end,room,instructor,confidence:'review',source:'Extracted from uploaded schedule'});
  if(found.length===80)break;
 }
 return found;
}
module.exports={parseClassSchedule,parseBannerSchedule};
