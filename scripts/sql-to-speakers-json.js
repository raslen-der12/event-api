#!/usr/bin/env node
const fs=require("fs"),path=require("path");
const INPUT=process.argv[2]||"./speakers-cairo.sql";
const OUTPUT=process.argv[3]||"./speakers-cairo.json";
const DEFAULT_EVENT_ID="68ec12fa8c89bd9b5e23d1e0";
const DEFAULT_PASSWORD="Placeholder1!"; // >= 8 chars

const SQL_COLUMNS=[
  "user_id","user_login","user_email","full_name","job_title","company","country",
  "talk_title","talk_description","talk_time","bio","photo_url",
  "social_media_linkedin","social_media_twitter","social_media_website"
];

const S=(v)=>v==null?"":String(v).trim();
const PH=(v,p)=>S(v)||p;
const L=(v)=>S(v).toLowerCase();
const ARR=(...xs)=>xs.filter(Boolean).map(S);

function extractValuesBlock(txt){
  const up=txt.toUpperCase(); const i=up.indexOf("VALUES");
  if(i<0)throw new Error("VALUES not found");
  const tail=txt.slice(i+6);
  const semi=tail.lastIndexOf(";");
  return (semi>=0?tail.slice(0,semi):tail).trim();
}
function splitTopLevelTuples(block){
  const out=[]; let inQ=false,depth=0,buf="";
  for(let i=0;i<block.length;i++){
    const ch=block[i];
    if(inQ){ buf+=ch; if(ch=="'"){ if(block[i+1]=="'"){buf+="'";i++;} else inQ=false; } continue; }
    if(ch=="'"){ inQ=true; buf+=ch; continue; }
    if(ch=="("){ depth++; buf+=ch; continue; }
    if(ch==")"){ depth--; buf+=ch; if(depth===0){ out.push(buf.trim()); buf=""; } continue; }
    buf+=ch;
  }
  return out.filter(t=>t.startsWith("("));
}
function parseTuple(t){
  const inner=t.slice(1,-1); const out=[]; let inQ=false,cur="";
  for(let i=0;i<inner.length;i++){
    const ch=inner[i];
    if(inQ){
      if(ch=="'"){ if(inner[i+1]=="'"){cur+="'";i++;} else inQ=false; }
      else cur+=ch;
    }else{
      if(ch=="'"){ inQ=true; }
      else if(ch==","){ out.push(tok(cur)); cur=""; }
      else cur+=ch;
    }
  }
  if(cur.length||inner.endsWith(",")) out.push(tok(cur));
  return out.map(v=>v===undefined?"":v);
}
function tok(s){
  const t=s.trim(); if(t.toUpperCase()==="NULL")return null; return t;
}
function rowObj(arr){
  const o={}; SQL_COLUMNS.forEach((c,i)=>o[c]=arr[i]===null?null:arr[i]); return o;
}
function toSpeaker(r){
  const full=PH(r.full_name,"Untitled");
  const email=PH(r.user_email,`nm_${Math.random().toString(36).slice(2)}@example.com`);
  const country=PH(r.country,"N/A");
  const company=PH(r.company,"NM");
  const job=PH(r.job_title,"NM");
  const title=PH(r.talk_title,"Untitled");
  const abs=PH(r.talk_description,"TBD");
  const linkedin=S(r.social_media_linkedin);
  const twitter=S(r.social_media_twitter);
  const website=S(r.social_media_website);
  const photo=S(r.photo_url);
  return {
    personal:{
      fullName:full,
      email:L(email),
      phone:"",
      linkedIn:linkedin||"",
      country:country,
      desc:S(r.bio),
      city:"",
      profilePic:photo||"",
      firstEmail:L(email)
    },
    organization:{
      orgName:company,
      orgWebsite:website||"",
      jobTitle:job,
      businessRole:"Speaker"
    },
    talk:{
      title:title,
      abstract:abs,
      topicCategory:"_",
      targetAudience:"_",
      language:"en",
      consentRecording:false
    },
    b2bIntent:{
      openMeetings:false,
      representingBiz:false,
      businessSector:"",
      meetingSlots:[],
      offering:"",
      lookingFor:"",
      regionsInterest:[],
      investmentSeeking:null,
      investmentRange:null
    },
    enrichments:{
      slidesFile:"",
      socialLinks:ARR(linkedin,twitter,website)
    },
    matchMeta:{ matchScore:0,suggestedMatches:[],sessionEngage:0,aiTags:[] },
    verified:false,
    subRole:[],
    actorType:"",
    role:"",
    pwd:DEFAULT_PASSWORD,
    id_event:DEFAULT_EVENT_ID,
    createdAt:new Date().toISOString()
  };
}

(function main(){
  const raw=fs.readFileSync(path.resolve(INPUT),"utf8");
  const block=extractValuesBlock(raw);
  const tuples=splitTopLevelTuples(block);
  if(!tuples.length) throw new Error("No tuples found");
  // drop header row if it looks like column names
  const firstArr=parseTuple(tuples[0]);
  const isHeader=firstArr && /user_id/i.test(String(firstArr[0]||""));
  const dataTuples=isHeader?tuples.slice(1):tuples;
  const docs=[];
  for(const t of dataTuples){
    const arr=parseTuple(t);
    if(arr.length!==SQL_COLUMNS.length) continue;
    const row=rowObj(arr);
    docs.push(toSpeaker(row));
  }
  fs.writeFileSync(path.resolve(OUTPUT),JSON.stringify(docs,null,2),"utf8");
  console.log(`Wrote ${docs.length} docs to ${OUTPUT}`);
})();
