// Deterministic handbook reader for DegreePath.
// We never invent courses, instructors, credit targets or graduation eligibility.
const PROGRAM_SOURCE = 'https://www.gsu.edu/program/computer-science-ms/';
const FOUNDATION_CODES = ['CSC 6210','CSC 6320','CSC 6330','CSC 6340','CSC 6510',
  'CSC 6350','CSC 6520','CSC 7301','CSC 7510','CSC 7302','CSC 7520','CSC 7320','CSC 7220'];

function clean(text){return String(text||'').replace(/\s+/g,' ').trim();}
function analyzeHandbook(text){
 const raw=String(text||'');
 const norm=clean(raw);
 if(!norm) return null;
 // GSU CS rules require multiple distinct markers, not just a filename match.
 const gsu=/Georgia State University/i.test(norm)&&/Department of Computer Science/i.test(norm)
   &&/Graduate Handbook/i.test(norm)&&/Course.only Option/i.test(norm)
   &&/Project Option/i.test(norm)&&/Thesis Option/i.test(norm);
 if(gsu){
   return {
    recognized:true,confidence:'recognized',school:'Georgia State University',program:'Computer Science',
    handbookType:'GSU Computer Science Graduate Handbook',
    levels:['Masters','PhD'],
    ms:{
      'Course-only':{max6000:4,min8000:5,specialCode:'CSC 8901',specialCredits:1,
       description:'Maximum four 6000-level courses, at least five 8000-level courses, CSC 8901 (1 credit)'},
      'Project':{max6000:3,min8000:4,specialCode:'CSC 8930',specialCredits:4,
       description:'Maximum three 6000-level courses, at least four 8000-level courses, CSC 8930 (4 credits)'},
      'Thesis':{max6000:2,min8000:4,specialCode:'CSC 8999',specialCredits:6,
       description:'Maximum two 6000-level courses, at least four 8000-level courses, CSC 8999 (6 credits)'}
    },
    minimumGrade:'B',
    msTotalCredits:31, // Official GSU program page, not stated in the uploaded handbook.
    msCreditsNoCSBackground:56,
    msCreditsCondition:'31-credit minimum applies to applicants with a CS bachelor\'s degree. GSU lists 56 hours for applicants without one; foundation needs vary.',
    phd:{totalCredits:72,courseCredits:48,dissertationCredits:24},
    foundationCodes:FOUNDATION_CODES,
    foundationNote:'Foundation coursework is not automatically applicable to the M.S. degree.',
    sources:[{label:'GSU CS Graduate Handbook, section 3',url:null,kind:'uploaded PDF'},
      {label:'GSU M.S. Computer Science program information (31/56 hours)',url:PROGRAM_SOURCE,kind:'official web page'}],
    sourceNote:'Track requirements and B-grade rule: uploaded GSU CS handbook. M.S. credit minimum: official GSU program page. Always confirm catalog-year and advisor exceptions.'
   };
 }
 // Conservative generic extraction. Do not apply GSU rules to unrelated universities.
 // A candidate is shown for review, not silently certified as a program requirement.
 const candidates=[];
 for(const m of norm.matchAll(/(?:minimum of|requires?|total of|completion of)\s+(\d{1,3})\s+(?:semester\s+)?(?:credit\s+hours?|credits?|semester\s+hours?)/gi)){
   const number=Number(m[1]);if(number>=12&&number<=240 && !candidates.some(x=>x.credits===number))
    candidates.push({credits:number,evidence:norm.slice(Math.max(0,m.index-60),Math.min(norm.length,m.index+150))});
   if(candidates.length>=5)break;
 }
 const school=(norm.match(/(?:^|\n)([A-Za-z .,&-]{4,80}University)/i)||[])[1]||null;
 return {recognized:false,confidence:'review_required',school:school?.trim()||null,program:null,
   possibleTotals:candidates,ms:null,msTotalCredits:null,phd:null,sources:[{label:'Uploaded PDF',url:null,kind:'uploaded PDF'}],
   sourceNote:'General document: candidate credit phrases found, but no approved program-specific rule parser. Review the document and applicable program catalog.'};
}
function recognizeHandbook(text){const data=analyzeHandbook(text);return data?.recognized?data:null;}
module.exports={analyzeHandbook,recognizeHandbook,PROGRAM_SOURCE,FOUNDATION_CODES};
