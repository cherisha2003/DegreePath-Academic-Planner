// Extract likely class meeting records from text produced by PDF extraction or OCR.
// This is intentionally conservative: a student confirms the results before saving.
'use strict';
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
  const full=[...chunk.matchAll(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues?|Wed|Thurs?|Fri|Sat|Sun)\b/gi)];
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
  found.push({course_code:code,title,term,days,start_time:start,end_time:end,room,instructor,confidence:'review',source:'Extracted from uploaded schedule'});
  if(found.length===80)break;
 }
 return found;
}
module.exports={parseClassSchedule};
